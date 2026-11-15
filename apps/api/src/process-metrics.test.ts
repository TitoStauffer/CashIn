import assert from "node:assert/strict";
import test from "node:test";
import type { Meter } from "@opentelemetry/api";
import { PROCESS_METRIC_NAMES, registerProcessMetrics } from "./process-metrics.js";

// DEV-134/135: the process metrics register one batch callback and an event loop delay monitor; the function
// they return must release both, which is what `Telemetry.shutdown` calls.

function recordingMeter() {
  const created: string[] = [];
  const added: unknown[] = [];
  const removed: unknown[] = [];
  const instrument = (name: string) => { created.push(name); return { name }; };
  const meter = {
    createObservableGauge: instrument,
    createObservableCounter: instrument,
    addBatchObservableCallback: (callback: unknown) => { added.push(callback); },
    removeBatchObservableCallback: (callback: unknown) => { removed.push(callback); },
  } as unknown as Meter;
  return { meter, created, added, removed };
}

test("the process metrics create every documented instrument and one batch callback", () => {
  const { meter, created, added } = recordingMeter();
  const stop = registerProcessMetrics(meter);
  assert.deepEqual([...created].sort(), [...PROCESS_METRIC_NAMES].sort());
  assert.equal(added.length, 1);
  stop();
});

test("stopping the process metrics removes the same callback it registered", () => {
  const { meter, added, removed } = recordingMeter();
  const stop = registerProcessMetrics(meter);
  stop();
  assert.equal(removed.length, 1);
  assert.equal(removed[0], added[0]);
});
