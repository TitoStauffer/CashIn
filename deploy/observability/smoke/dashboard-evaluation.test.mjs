// Sensitivity tests of dashboard-evaluation.mjs (DEV-136): the dashboard check must fail closed.
// Run with `node --test deploy/observability/smoke/dashboard-evaluation.test.mjs`.
import assert from "node:assert/strict";
import test from "node:test";
import { concreteQuery, evaluatePass, evaluateUntil } from "./dashboard-evaluation.mjs";

const targets = [
  { label: "A", expr: "rate(a_total[$__rate_interval])" },
  { label: "B", expr: "increase(b_total[$__range])" },
  { label: "C", expr: "c_bytes" },
];
const withData = { status: "success", data: { result: [{ value: [0, "1"] }] } };
const noData = { status: "success", data: { result: [] } };
const noSleep = async () => {};

test("Grafana variables become fixed windows", () => {
  assert.equal(concreteQuery("rate(a[$__rate_interval]) + increase(b[$__range])"), "rate(a[5m]) + increase(b[15m])");
});

test("a pass where every query has data passes", async () => {
  const result = await evaluateUntil(targets, async () => withData, { deadlineMs: 0, sleep: noSleep });
  assert.equal(result.passed, true);
  assert.deepEqual(result.empty, []);
});

test("a query without series is empty", async () => {
  const result = await evaluatePass(targets, async (expr) => (expr.startsWith("increase") ? noData : withData));
  assert.deepEqual(result.empty, ["B"]);
});

test("a query that throws counts as empty, and every later query is still asked", async () => {
  const asked = [];
  const result = await evaluatePass(targets, async (expr) => {
    asked.push(expr);
    if (expr.startsWith("rate")) throw new Error("connection reset");
    return withData;
  });
  assert.deepEqual(result.empty, ["A"]);
  assert.equal(asked.length, 3);
});

test("an error answer or a malformed answer counts as empty", async () => {
  // The first error answer still carries series: the status alone must make it empty.
  const answers = [{ status: "error", error: "partial", data: { result: [{ value: [0, "1"] }] } }, "not json", withData];
  let index = 0;
  const result = await evaluatePass(targets, async () => answers[index++]);
  assert.deepEqual(result.empty, ["A", "B"]);
});

test("running out of time fails with the last complete pass, even when every query throws", async () => {
  let clock = 0;
  const result = await evaluateUntil(targets, async () => { throw new Error("Grafana down"); }, {
    deadlineMs: 10, now: () => clock, sleep: async () => { clock += 5; },
  });
  assert.equal(result.passed, false);
  assert.deepEqual(result.empty, ["A", "B", "C"]);
});

test("a dashboard without queries does not pass", async () => {
  const result = await evaluateUntil([], async () => withData, { deadlineMs: 0, sleep: noSleep });
  assert.equal(result.passed, false);
});

test("data that arrives late is accepted on a later complete pass", async () => {
  let pass = 0;
  const result = await evaluateUntil(targets, async (expr) => (pass >= 2 || !expr.startsWith("c") ? withData : noData), {
    deadlineMs: Number.POSITIVE_INFINITY, sleep: async () => { pass += 1; },
  });
  assert.equal(result.passed, true);
});
