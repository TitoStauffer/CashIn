import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { describe, it } from "node:test";
import { StateStore } from "../src/state.js";
import { ControlledCodex, FakeJira, STATUS, eligibleIssue, makeConfig, makeDispatcher } from "./helpers.js";

/** Writes a run that looks like it was left behind by a dispatcher process that crashed. */
function seedCrashedRun(store: StateStore, issueKey: string, childPid: number | undefined, patch = {}) {
  const run = store.create({ issueKey, logDirRoot: "/tmp/runs" });
  return store.update(run.runId, {
    status: "running",
    phase: "codex",
    dispatcherPid: 2_147_000_000, // not this process
    childPid,
    jiraReserved: true,
    startCommentPosted: true,
    workdir: "/tmp/worktree-of-previous-run",
    worktreePath: "/tmp/worktree-of-previous-run",
    ...patch
  });
}

async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", ""]);
  await new Promise((resolve) => child.on("exit", resolve));
  return child.pid!;
}

describe("recovery", () => {
  it("marks runs of a crashed dispatcher as interrupted when Codex is gone", async () => {
    const config = makeConfig();
    const store = new StateStore(config.stateDir);
    const crashed = seedCrashedRun(store, "DEV-10", await deadPid());

    const { dispatcher } = makeDispatcher({ config, store });
    const recovered = dispatcher.recover();

    assert.equal(recovered.length, 1);
    assert.equal(store.get(crashed.runId)!.status, "interrupted");
    assert.equal(store.get(crashed.runId)!.error!.phase, "codex");
  });

  it("keeps blocking the issue while an orphaned Codex process is still alive", async () => {
    const config = makeConfig();
    const store = new StateStore(config.stateDir);
    const orphan = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"]);
    try {
      const run = seedCrashedRun(store, "DEV-10", orphan.pid);
      const jira = new FakeJira().add(eligibleIssue("DEV-10")); // pretend Jira shows it as To Do again
      const { dispatcher, codex } = makeDispatcher({ config, store, jira });

      const summary = await dispatcher.pollOnce();
      assert.equal(store.get(run.runId)!.status, "running");
      assert.equal(store.get(run.runId)!.phase, "orphaned");
      assert.deepEqual(summary.started, []);
      assert.equal((codex as ControlledCodex).calls.length, 0);
      assert.equal(jira.transitionsCalled.length, 0);
    } finally {
      orphan.kill();
    }
  });

  it("does not automatically reselect an interrupted issue", async () => {
    const config = makeConfig();
    const store = new StateStore(config.stateDir);
    seedCrashedRun(store, "DEV-10", await deadPid());
    const jira = new FakeJira().add(eligibleIssue("DEV-10"));
    const { dispatcher } = makeDispatcher({ config, store, jira });

    const summary = await dispatcher.pollOnce();
    assert.deepEqual(summary.started, []);
    assert.match(summary.skipped[0]!.reason, /interrupted; use resume ou clear/);
  });

  it("resumes in a new run without repeating the reservation transition", async () => {
    const config = makeConfig();
    const store = new StateStore(config.stateDir);
    const previous = seedCrashedRun(store, "DEV-10", await deadPid());
    const jira = new FakeJira().add(eligibleIssue("DEV-10", { status: STATUS.progress }));
    const { dispatcher, codex } = makeDispatcher({ config, store, jira });

    const resumed = await dispatcher.resume("DEV-10");

    assert.notEqual(resumed.runId, previous.runId);
    assert.equal(resumed.previousRunId, previous.runId);
    assert.equal(resumed.status, "running");
    assert.equal(resumed.workdir, previous.workdir, "reuses the previous worktree");
    assert.equal(jira.transitionsCalled.length, 0);
    assert.match(jira.comments[0]!.text, /retomada.*runId/);
    const prompt = (codex as ControlledCodex).calls[0]!.prompt;
    assert.ok(prompt.includes("RETOMAR") && prompt.includes(previous.runId) && prompt.includes("feature/DEV-1-x"));
    assert.equal(store.get(previous.runId)!.status, "interrupted");
  });

  it("posts the missing start comment when the interrupted run never posted it", async () => {
    const config = makeConfig();
    const store = new StateStore(config.stateDir);
    seedCrashedRun(store, "DEV-10", await deadPid(), { startCommentPosted: false });
    const jira = new FakeJira().add(eligibleIssue("DEV-10", { status: STATUS.progress }));
    const { dispatcher } = makeDispatcher({ config, store, jira });
    await dispatcher.resume("DEV-10");
    assert.match(jira.comments[0]!.text, /^Iniciado em /);
  });

  it("refuses to resume when Jira shows a status outside resumableStatuses", async () => {
    const config = makeConfig();
    const store = new StateStore(config.stateDir);
    seedCrashedRun(store, "DEV-10", await deadPid());
    const jira = new FakeJira().add(eligibleIssue("DEV-10", { status: STATUS.done }));
    const { dispatcher, codex } = makeDispatcher({ config, store, jira });

    await assert.rejects(() => dispatcher.resume("DEV-10"), /resumableStatuses/);
    assert.equal((codex as ControlledCodex).calls.length, 0);
    assert.equal(store.forIssue("DEV-10").length, 1);
  });

  it("refuses to resume an issue with an active run or nothing to resume", async () => {
    const jira = new FakeJira().add(eligibleIssue("DEV-10"));
    const { dispatcher } = makeDispatcher({ jira });
    await assert.rejects(() => dispatcher.resume("DEV-10"), /não tem execução/);
    await dispatcher.pollOnce();
    await assert.rejects(() => dispatcher.resume("DEV-10"), /já tem uma execução ativa/);
  });

  it("clear unblocks the issue without touching Jira", async () => {
    const config = makeConfig();
    const store = new StateStore(config.stateDir);
    seedCrashedRun(store, "DEV-10", await deadPid());
    const jira = new FakeJira().add(eligibleIssue("DEV-10"));
    const { dispatcher } = makeDispatcher({ config, store, jira });
    dispatcher.recover();

    dispatcher.clear("DEV-10");
    assert.equal(store.latestForIssue("DEV-10")!.status, "cancelled");
    assert.equal(jira.comments.length, 0);
    assert.deepEqual((await dispatcher.pollOnce()).started, ["DEV-10"]);
  });

  it("persists state across store instances (process restarts)", () => {
    const config = makeConfig();
    const first = new StateStore(config.stateDir);
    const run = first.create({ issueKey: "DEV-10", logDirRoot: "/tmp/x" });
    first.update(run.runId, { status: "running", codexThreadId: "thread-1" });
    const second = new StateStore(config.stateDir);
    assert.equal(second.get(run.runId)!.codexThreadId, "thread-1");
    assert.equal(second.activeForIssue("DEV-10")!.runId, run.runId);
  });
});
