import assert from "node:assert/strict";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
import { CodexCliRunner } from "../src/codex.js";
import type { DispatcherConfig } from "../src/config.js";
import { Redactor } from "../src/redact.js";
import { FakeJira, STATUS, eligibleIssue, makeConfig, makeDispatcher, tempDir } from "./helpers.js";

const FIXTURE = resolve(import.meta.dirname, "fixtures", "fake-codex.mjs");

/** Returns a command that runs the fake Codex on this OS (a .cmd shim on Windows, like npm installs). */
function fakeCodexCommand(dir: string): string {
  if (process.platform === "win32") {
    const shim = join(dir, "fake-codex.cmd");
    writeFileSync(shim, `@"${process.execPath}" "${FIXTURE}" %*\r\n`);
    return shim;
  }
  chmodSync(FIXTURE, 0o755);
  return FIXTURE;
}

function setup(mode: string, options: { jiraDoneAfterRun?: boolean; env?: NodeJS.ProcessEnv; configure?: (c: DispatcherConfig) => void } = {}) {
  const dir = tempDir();
  const config = makeConfig({ codex: { command: fakeCodexCommand(dir) } }, dir);
  options.configure?.(config);
  const recordFile = join(dir, "record.json");
  const env = { ...process.env, FAKE_CODEX_MODE: mode, FAKE_CODEX_RECORD: recordFile, JIRA_API_TOKEN: "super-secret-token-value", ...options.env };
  const redactor = Redactor.fromEnvironment(env);
  const runner = new CodexCliRunner(config, redactor, env);
  const jira = new FakeJira().add(eligibleIssue("DEV-10"));
  const harness = makeDispatcher({ config, jira, codex: runner });

  if (options.jiraDoneAfterRun) {
    // Simulates the Codex workflow moving the issue to Done before exiting.
    jira.onGetIssue = (issue) => {
      if (harness.store.latestForIssue(issue.key)?.status === "running") issue.fields.status = STATUS.done;
    };
  }
  return { ...harness, recordFile, dir };
}

async function runOne(h: ReturnType<typeof setup>) {
  const summary = await h.dispatcher.pollOnce();
  assert.deepEqual(summary.started, ["DEV-10"], JSON.stringify([summary.skipped, h.store.all().map((r) => r.error)]));
  await h.dispatcher.waitForRuns();
  return h.store.latestForIssue("DEV-10")!;
}

describe("Codex runs (real child process)", () => {
  it("completes when Codex reports done and Jira confirms a done status", async () => {
    const h = setup("done", { jiraDoneAfterRun: true });
    const run = await runOne(h);

    assert.equal(run.status, "completed");
    assert.equal(run.prUrl, "https://github.com/x/y/pull/1");
    assert.equal(run.codexThreadId, "thread-123");
    assert.equal(run.exitCode, 0);
    assert.equal(run.jiraStatusAfter, "Concluído");

    const record = JSON.parse(readFileSync(h.recordFile, "utf8"));
    assert.equal(record.args[0], "exec");
    assert.ok(record.args.includes("--sandbox") && record.args.includes("workspace-write"));
    assert.ok(!record.args.some((a: string) => /danger|yolo|bypass/.test(a)));
    assert.equal(record.args.at(-1), "-", "prompt is sent through stdin");
    assert.equal(record.args[record.args.indexOf("--cd") + 1], run.workdir);
    assert.equal(resolve(record.cwd), resolve(run.workdir!));
    assert.ok(record.prompt.includes(run.runId));
    assert.equal(record.hasJiraToken, false, "the dispatcher's Jira token is not passed to Codex");

    for (const file of ["prompt.md", "codex-events.jsonl", "result.json"]) {
      assert.ok(existsSync(join(run.logDir, file)), `${file} is kept with the run logs`);
    }
    assert.ok(run.logDir.includes(join("runs", "DEV-10", run.runId)), "logs are grouped by issue key and runId");
  });

  it("needs attention when Codex says done but Jira is not in a done status", async () => {
    const run = await runOne(setup("done"));
    assert.equal(run.status, "needs_attention");
    assert.match(run.error!.message, /informou "done", mas o Jira está em "Em andamento"/);
  });

  it("needs attention when Codex reports a blocked outcome", async () => {
    const run = await runOne(setup("blocked"));
    assert.equal(run.status, "needs_attention");
    assert.equal(run.outcome, "blocked");
  });

  it("fails when Codex reports a failure", async () => {
    const run = await runOne(setup("reported-failure"));
    assert.equal(run.status, "failed");
    assert.equal(run.phase, "codex_reported_failure");
  });

  it("fails on a non-zero exit code and records the failure on the issue", async () => {
    const h = setup("crash");
    const run = await runOne(h);
    assert.equal(run.status, "failed");
    assert.equal(run.phase, "codex_exit");
    assert.match(run.error!.message, /código 3: model overloaded/);
    assert.ok(h.jira.comments.some((c) => c.text.includes(run.runId) && c.text.includes("codex_exit")));
    assert.equal(h.jira.transitionsCalled.length, 1, "no extra transition on failure");
  });

  it("needs attention when the final message is not valid JSON", async () => {
    const run = await runOne(setup("invalid"));
    assert.equal(run.status, "needs_attention");
    assert.match(run.error!.message, /não é um JSON válido/);
  });

  it("needs attention when the result refers to another issue", async () => {
    const run = await runOne(setup("wrong-issue"));
    assert.equal(run.status, "needs_attention");
    assert.match(run.error!.message, /DEV-999/);
  });

  it("kills Codex after the timeout", async () => {
    const h = setup("hang", {
      configure: (c) => {
        c.codex.timeoutMinutes = 0.005; // 300 ms
        c.codex.killGraceSeconds = 1;
      }
    });
    const run = await runOne(h);
    assert.equal(run.status, "failed");
    assert.equal(run.phase, "codex_timeout");
  });

  it("marks the run interrupted on forced shutdown so it can be resumed", async () => {
    const h = setup("hang");
    await h.dispatcher.pollOnce();
    await new Promise((r) => setTimeout(r, 300));
    h.dispatcher.forceStop();
    await h.dispatcher.waitForRuns();
    const run = h.store.latestForIssue("DEV-10")!;
    assert.equal(run.status, "interrupted");
    assert.equal(h.dispatcher.isDraining, true);
    assert.deepEqual((await h.dispatcher.pollOnce()).started, [], "no new work after stop");
  });

  it("fails cleanly when the Codex command does not exist", async () => {
    const h = setup("done", { configure: (c) => (c.codex.command = join(tempDir(), "missing-codex")) });
    const run = await runOne(h);
    assert.equal(run.status, "failed");
    assert.ok(["codex_spawn", "codex_exit"].includes(run.phase), run.phase);
  });

  it("redacts secrets from Codex events, stderr, summaries and state", async () => {
    const h = setup("leak", { env: { LEAK_VALUE: "super-secret-token-value" }, jiraDoneAfterRun: true });
    const run = await runOne(h);
    for (const file of ["codex-events.jsonl", "codex-stderr.log"]) {
      const content = readFileSync(join(run.logDir, file), "utf8");
      assert.ok(!content.includes("super-secret-token-value"), `${file} must not contain the secret`);
      assert.ok(content.includes("[REDACTED]"));
    }
    assert.ok(!readFileSync(h.store.filePath, "utf8").includes("super-secret-token-value"));
  });
});
