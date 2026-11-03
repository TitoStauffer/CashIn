import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync, utimesSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
import { JiraHttpError } from "../src/jira/client.js";
import { ConcurrencyError, ProcessLock, StateStore } from "../src/state.js";
import { ControlledCodex, FakeJira, STATUS, eligibleIssue, makeConfig, makeDispatcher, tempDir } from "./helpers.js";

describe("concurrency", () => {
  it("never starts the same issue twice while its run is active", async () => {
    const jira = new FakeJira().add(eligibleIssue("DEV-10"));
    const { dispatcher, codex, store } = makeDispatcher({ jira, config: makeConfig({ maxConcurrentRuns: 3 }) });

    const first = await dispatcher.pollOnce();
    assert.deepEqual(first.started, ["DEV-10"]);

    // Simulate Jira still returning the issue (stale search index) while the run is active.
    jira.setStatus("DEV-10", STATUS.todo);
    const second = await dispatcher.pollOnce();
    assert.deepEqual(second.started, []);
    assert.match(second.skipped[0]!.reason, /execução ativa/);
    assert.equal((codex as ControlledCodex).calls.length, 1);
    assert.equal(jira.transitionsCalled.length, 1);
    assert.equal(store.forIssue("DEV-10").length, 1);
  });

  it("respects maxConcurrentRuns and keeps Jira order", async () => {
    const jira = new FakeJira().add(eligibleIssue("DEV-10"), eligibleIssue("DEV-11"), eligibleIssue("DEV-12"));
    const { dispatcher, store } = makeDispatcher({ jira, config: makeConfig({ maxConcurrentRuns: 2 }) });

    const summary = await dispatcher.pollOnce();
    assert.deepEqual(summary.started, ["DEV-10", "DEV-11"]);
    assert.equal(store.active().length, 2);
    assert.deepEqual((await dispatcher.pollOnce()).started, []);
  });

  it("refuses to create a second active run for the same issue at the store level", () => {
    const store = new StateStore(tempDir());
    store.create({ issueKey: "DEV-10", logDirRoot: "/tmp/x" });
    assert.throws(() => store.create({ issueKey: "DEV-10", logDirRoot: "/tmp/x" }), ConcurrencyError);
  });

  it("does not reserve when another actor moved the issue between search and reservation", async () => {
    const jira = new FakeJira().add(eligibleIssue("DEV-10"));
    jira.onGetIssue = (issue) => {
      issue.fields.status = STATUS.progress; // someone else pulled the ticket
    };
    const { dispatcher, store, codex } = makeDispatcher({ jira });

    const summary = await dispatcher.pollOnce();
    assert.deepEqual(summary.started, []);
    assert.equal(jira.transitionsCalled.length, 0);
    assert.equal((codex as ControlledCodex).calls.length, 0);
    const run = store.latestForIssue("DEV-10")!;
    assert.equal(run.status, "cancelled");
    assert.equal(run.jiraReserved, false);
  });

  it("does not reserve when the parent changes to an unauthorized epic before reservation", async () => {
    const jira = new FakeJira().add(eligibleIssue("DEV-10"));
    jira.onGetIssue = (issue) => {
      issue.fields.parent = { key: "DEV-25" };
    };
    const { dispatcher, store, codex } = makeDispatcher({ jira });

    const summary = await dispatcher.pollOnce();
    assert.deepEqual(summary.started, []);
    assert.equal(jira.transitionsCalled.length, 0);
    assert.equal((codex as ControlledCodex).calls.length, 0);
    assert.equal(store.latestForIssue("DEV-10")!.status, "cancelled");
  });

  it("allows only one dispatcher process per state directory", () => {
    const dir = tempDir();
    const first = new ProcessLock(dir);
    const second = new ProcessLock(dir);
    assert.equal(first.tryAcquire().acquired, true);
    const attempt = second.tryAcquire();
    assert.equal(attempt.acquired, false);
    first.release();
    assert.equal(second.tryAcquire().acquired, true);
    second.release();
  });

  it("reclaims a lock left by a dead process on the same host", async () => {
    const dir = tempDir();
    const child = spawn(process.execPath, ["-e", ""]);
    await new Promise((r) => child.on("exit", r));
    const lock = new ProcessLock(dir);
    writeFileSync(join(dir, "dispatcher.lock"), JSON.stringify({ pid: child.pid, host: (await import("node:os")).hostname(), startedAt: "x" }));
    assert.equal(lock.tryAcquire().acquired, true);
    lock.release();
  });

  it("never steals a lock owned by another host", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "dispatcher.lock"), JSON.stringify({ pid: 1, host: "other-machine", startedAt: "x" }));
    assert.equal(new ProcessLock(dir).tryAcquire().acquired, false);
  });

  it("does not reclaim a fresh incomplete lock that another process may still be writing", () => {
    const dir = tempDir();
    const lockPath = join(dir, "dispatcher.lock");
    writeFileSync(lockPath, "");

    const attempt = new ProcessLock(dir).tryAcquire();
    assert.equal(attempt.acquired, false);
    assert.equal(readFileSync(lockPath, "utf8"), "");
  });

  it("reclaims an old incomplete lock after it remains unchanged", () => {
    const dir = tempDir();
    const lockPath = join(dir, "dispatcher.lock");
    writeFileSync(lockPath, "{");
    const staleDate = new Date(Date.now() - 60_000);
    utimesSync(lockPath, staleDate, staleDate);

    const lock = new ProcessLock(dir);
    assert.equal(lock.tryAcquire().acquired, true);
    assert.equal(lock.readHolder()?.pid, process.pid);
    lock.release();
  });

  it("serializes stale-lock recovery across concurrent processes", async () => {
    const script = `
      import { ProcessLock } from "./src/state.ts";
      const lock = new ProcessLock(process.env.DISPATCHER_LOCK_DIR);
      const result = lock.tryAcquire();
      process.stdout.write(JSON.stringify(result) + "\\n");
      if (result.acquired) await new Promise((resolve) => process.stdin.once("data", resolve));
      if (result.acquired) lock.release();
    `;
    const staleLocks = [
      { contents: "{", invalid: true },
      { contents: JSON.stringify({ pid: 2_147_483_647, host: hostname(), startedAt: "stale" }), invalid: false }
    ];

    for (const staleLock of staleLocks) {
      const dir = tempDir();
      const lockPath = join(dir, "dispatcher.lock");
      writeFileSync(lockPath, staleLock.contents);
      if (staleLock.invalid) {
        const staleDate = new Date(Date.now() - 60_000);
        utimesSync(lockPath, staleDate, staleDate);
      }

      const children = [spawnLockChild(dir, script), spawnLockChild(dir, script)];
      const results = await Promise.all(children.map((child) => readLockResult(child)));
      assert.equal(results.filter((result) => result.acquired).length, 1);
      for (let index = 0; index < children.length; index++) {
        if (results[index]!.acquired) children[index]!.stdin!.end("release");
      }
      await Promise.all(children.map((child) => waitForExit(child)));
      assert.equal(new ProcessLock(dir).readHolder(), undefined);
    }
  });
});

function spawnLockChild(dir: string, script: string): ChildProcess {
  return spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
    cwd: resolve(import.meta.dirname, ".."),
    env: { ...process.env, DISPATCHER_LOCK_DIR: dir },
    stdio: ["pipe", "pipe", "pipe"]
  });
}

function readLockResult(child: ChildProcess): Promise<{ acquired: boolean }> {
  return new Promise((resolve, reject) => {
    let output = "";
    let stderr = "";
    child.stdout!.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
      const newline = output.indexOf("\n");
      if (newline < 0) return;
      try {
        resolve(JSON.parse(output.slice(0, newline)) as { acquired: boolean });
      } catch (error) {
        reject(error);
      }
    });
    child.stderr!.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (!output.includes("\n")) reject(new Error(`Lock child exited before reporting, code ${code}: ${stderr}`));
    });
  });
}

function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) {
    return child.exitCode === 0 ? Promise.resolve() : Promise.reject(new Error(`Lock child exited with code ${child.exitCode}`));
  }
  return new Promise((resolve, reject) => {
    let stderr = "";
    child.stderr!.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`Lock child exited with code ${code}: ${stderr}`)));
  });
}

describe("reservation", () => {
  it("reserves through the available transition and comments with the AGENTS.md format and runId", async () => {
    const jira = new FakeJira().add(eligibleIssue("DEV-10"));
    const { dispatcher, store, codex } = makeDispatcher({ jira });
    await dispatcher.pollOnce();

    const run = store.latestForIssue("DEV-10")!;
    assert.deepEqual(jira.transitionsCalled, [{ key: "DEV-10", id: "21" }]);
    assert.equal(jira.issues.get("DEV-10")!.fields.status!.name, "Em andamento");
    assert.equal(jira.comments.length, 1);
    assert.match(jira.comments[0]!.text, /^Iniciado em \d{2}\/\d{2}\/\d{4} \d{2}:\d{2} \(America\/Sao_Paulo\)\./);
    assert.ok(jira.comments[0]!.text.includes(run.runId));
    assert.deepEqual(jira.properties.get("DEV-10:saldocerto.dispatcher.run"), {
      ...(jira.properties.get("DEV-10:saldocerto.dispatcher.run") as object),
      runId: run.runId,
      status: "running"
    });
    assert.equal(run.status, "running");
    const prompt = (codex as ControlledCodex).calls[0]!.prompt;
    assert.ok(prompt.includes(run.runId) && prompt.includes("DEV-10") && prompt.includes("AGENTS.md"));
    assert.ok(!prompt.includes("{{"), "all placeholders rendered");
  });

  it("fails safely when the reservation transition is not available, without guessing another one", async () => {
    const jira = new FakeJira().add(eligibleIssue("DEV-10"));
    jira.workflow[STATUS.todo.id] = [{ id: "99", name: "Cancelar", to: STATUS.done }];
    const { dispatcher, store, codex } = makeDispatcher({ jira });

    await dispatcher.pollOnce();
    const run = store.latestForIssue("DEV-10")!;
    assert.equal(run.status, "failed");
    assert.match(run.error!.message, /Nenhuma transição disponível.*Cancelar → Concluído/);
    assert.equal(jira.transitionsCalled.length, 0);
    assert.equal((codex as ControlledCodex).calls.length, 0);

    // The failed run blocks automatic reselection until an operator acts.
    const again = await dispatcher.pollOnce();
    assert.match(again.skipped[0]!.reason, /use resume ou clear/);
  });

  it("refuses ambiguous transitions unless reservationTransitionId is configured", async () => {
    const jira = new FakeJira().add(eligibleIssue("DEV-10"));
    jira.workflow[STATUS.todo.id] = [
      { id: "21", name: "Iniciar", to: STATUS.progress },
      { id: "22", name: "Iniciar (bug)", to: STATUS.progress }
    ];
    const ambiguous = makeDispatcher({ jira });
    await ambiguous.dispatcher.pollOnce();
    assert.match(ambiguous.store.latestForIssue("DEV-10")!.error!.message, /Mais de uma transição/);

    const jira2 = new FakeJira().add(eligibleIssue("DEV-10"));
    jira2.workflow = { ...jira.workflow };
    const explicit = makeDispatcher({ jira: jira2, config: makeConfig({ jira: { reservationTransitionId: "22" } }) });
    await explicit.dispatcher.pollOnce();
    assert.deepEqual(jira2.transitionsCalled, [{ key: "DEV-10", id: "22" }]);
  });

  it("does not retry a failed transition and records the failure", async () => {
    const jira = new FakeJira().add(eligibleIssue("DEV-10"));
    jira.failTransition = new JiraHttpError(500, "POST", "/transitions", "boom");
    const { dispatcher, store } = makeDispatcher({ jira });
    await dispatcher.pollOnce();
    assert.equal(jira.transitionsCalled.length, 1);
    assert.equal(store.latestForIssue("DEV-10")!.status, "failed");
    assert.equal(store.latestForIssue("DEV-10")!.jiraReserved, false);
  });

  it("retries only the comment when it fails after a successful transition", async () => {
    const jira = new FakeJira().add(eligibleIssue("DEV-10"));
    jira.failComments = 2;
    const { dispatcher, store } = makeDispatcher({ jira });
    await dispatcher.pollOnce();
    assert.equal(jira.transitionsCalled.length, 1);
    assert.equal(jira.comments.length, 1);
    assert.equal(store.latestForIssue("DEV-10")!.startCommentPosted, true);
  });

  it("stops before Codex when the start comment keeps failing", async () => {
    const jira = new FakeJira().add(eligibleIssue("DEV-10"));
    jira.failComments = 10;
    const { dispatcher, store, codex } = makeDispatcher({ jira });
    await dispatcher.pollOnce();
    await dispatcher.waitForRuns();
    const run = store.latestForIssue("DEV-10")!;
    assert.equal(run.status, "failed");
    assert.equal(run.phase, "start_comment");
    assert.equal(run.jiraReserved, true);
    assert.equal(jira.transitionsCalled.length, 1);
    assert.equal((codex as ControlledCodex).calls.length, 0);
  });

  it("stops before Codex when the workspace cannot be prepared", async () => {
    const jira = new FakeJira().add(eligibleIssue("DEV-10"));
    const { dispatcher, store, codex, workspace } = makeDispatcher({ jira });
    (workspace as { failPrepare?: Error }).failPrepare = new Error("git fetch falhou");
    await dispatcher.pollOnce();
    await dispatcher.waitForRuns();
    assert.equal(store.latestForIssue("DEV-10")!.phase, "workspace");
    assert.equal((codex as ControlledCodex).calls.length, 0);
    assert.ok(jira.comments.some((c) => c.text.includes("Fase: workspace")), "failure is recorded on the issue");
  });

  it("dry-run lists eligible issues without touching Jira", async () => {
    const jira = new FakeJira().add(eligibleIssue("DEV-10"), eligibleIssue("DEV-11", { customfield_agent: null }));
    const { dispatcher, store } = makeDispatcher({ jira });
    const summary = await dispatcher.pollOnce({ dryRun: true });
    assert.deepEqual(summary.started, ["DEV-10"]);
    assert.equal(summary.skipped[0]!.issueKey, "DEV-11");
    assert.equal(jira.transitionsCalled.length, 0);
    assert.equal(store.all().length, 0);
  });
});
