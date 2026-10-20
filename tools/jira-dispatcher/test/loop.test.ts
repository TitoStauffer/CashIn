import assert from "node:assert/strict";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { RequestQueue } from "../src/requests.js";
import { ControlledCodex, FakeJira, eligibleIssue, makeConfig, makeDispatcher, tempDir } from "./helpers.js";

describe("RequestQueue", () => {
  it("delivers requests in order and discards invalid ones", () => {
    const queue = new RequestQueue(tempDir());
    queue.enqueue({ action: "resume", issueKey: "DEV-10" });
    queue.enqueue({ action: "stop", mode: "drain" });
    mkdirSync(queue.dir, { recursive: true });
    writeFileSync(join(queue.dir, "999999999999999-99999999-bad.json"), JSON.stringify({ action: "resume", issueKey: "DEV-10; rm -rf /" }));
    assert.deepEqual(queue.drain(), [
      { action: "resume", issueKey: "DEV-10" },
      { action: "stop", mode: "drain" }
    ]);
    assert.deepEqual(queue.drain(), []);
  });
});

describe("runLoop", () => {
  it("polls, then drains on stop: no new issues, waits for the active run to finish", async () => {
    const jira = new FakeJira().add(eligibleIssue("DEV-10"), eligibleIssue("DEV-11"));
    const config = makeConfig({ maxConcurrentRuns: 1 });
    const { dispatcher, codex, store } = makeDispatcher({ jira, config });
    const controlled = codex as ControlledCodex;
    const stop = new AbortController();

    let ticks = 0;
    const loop = dispatcher.runLoop(
      stop.signal,
      () => {
        ticks += 1;
        if (ticks === 3) stop.abort(); // operator asked to stop after the first poll
      },
      5
    );

    await new Promise((r) => setTimeout(r, 50));
    assert.equal(controlled.calls.length, 1, "only one run started (maxConcurrentRuns = 1)");
    assert.equal(store.latestForIssue("DEV-10")!.status, "running");

    let finished = false;
    void loop.then(() => (finished = true));
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(finished, false, "the loop waits for the active run");

    controlled.finish(0, { exitCode: 0, finalResult: { issueKey: "DEV-10", outcome: "blocked", prUrl: null, jiraStatus: "Em andamento", summary: "x" } });
    await loop;
    assert.equal(store.latestForIssue("DEV-10")!.status, "needs_attention");
    assert.equal(store.latestForIssue("DEV-11"), undefined, "DEV-11 was never started after stop");
  });

  it("keeps running when Jira is unavailable during a poll", async () => {
    const jira = new FakeJira();
    jira.searchIssues = async () => {
      throw new Error("ECONNRESET");
    };
    const { dispatcher, logger } = makeDispatcher({ jira });
    const stop = new AbortController();
    setTimeout(() => stop.abort(), 30);
    await dispatcher.runLoop(stop.signal, undefined, 5);
    assert.ok(logger.entries.some((e) => e.event === "poll_failed" && e.level === "error"));
  });
});
