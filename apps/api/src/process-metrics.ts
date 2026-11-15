import { monitorEventLoopDelay } from "node:perf_hooks";
import type { Meter } from "@opentelemetry/api";

// Process health of the API (DEV-134): event loop delay, memory, CPU and uptime, read when the SDK
// collects metrics. Implemented on the OpenTelemetry API already approved for the project instead of a
// host-metrics dependency, and with no attribute other than the CPU mode, so it adds no cardinality.
export const PROCESS_METRIC_NAMES = [
  "nodejs.eventloop.delay.p50",
  "nodejs.eventloop.delay.p99",
  "nodejs.eventloop.delay.max",
  "process.memory.usage",
  "nodejs.heap.used",
  "process.cpu.time",
  "process.uptime",
] as const;

const NANOSECONDS_PER_SECOND = 1e9;
const MICROSECONDS_PER_SECOND = 1e6;

export function registerProcessMetrics(meter: Meter): () => void {
  const loopDelay = monitorEventLoopDelay({ resolution: 20 });
  loopDelay.enable();

  const delayP50 = meter.createObservableGauge("nodejs.eventloop.delay.p50", { unit: "s", description: "Event loop delay, 50th percentile since the last collection." });
  const delayP99 = meter.createObservableGauge("nodejs.eventloop.delay.p99", { unit: "s", description: "Event loop delay, 99th percentile since the last collection." });
  const delayMax = meter.createObservableGauge("nodejs.eventloop.delay.max", { unit: "s", description: "Largest event loop delay since the last collection." });
  const memory = meter.createObservableGauge("process.memory.usage", { unit: "By", description: "Resident set size of the API process." });
  const heap = meter.createObservableGauge("nodejs.heap.used", { unit: "By", description: "V8 heap in use." });
  const cpu = meter.createObservableCounter("process.cpu.time", { unit: "s", description: "CPU time consumed by the API process." });
  const uptime = meter.createObservableGauge("process.uptime", { unit: "s", description: "Time since the API process started." });

  const observe: Parameters<Meter["addBatchObservableCallback"]>[0] = (result) => {
    result.observe(delayP50, loopDelay.percentile(50) / NANOSECONDS_PER_SECOND);
    result.observe(delayP99, loopDelay.percentile(99) / NANOSECONDS_PER_SECOND);
    result.observe(delayMax, loopDelay.max / NANOSECONDS_PER_SECOND);
    // Each collection reports the delay of its own interval, not the whole life of the process.
    loopDelay.reset();
    const usage = process.memoryUsage();
    result.observe(memory, usage.rss);
    result.observe(heap, usage.heapUsed);
    const cpuUsage = process.cpuUsage();
    result.observe(cpu, cpuUsage.user / MICROSECONDS_PER_SECOND, { "cpu.mode": "user" });
    result.observe(cpu, cpuUsage.system / MICROSECONDS_PER_SECOND, { "cpu.mode": "system" });
    result.observe(uptime, process.uptime());
  };
  const observables = [delayP50, delayP99, delayMax, memory, heap, cpu, uptime];
  meter.addBatchObservableCallback(observe, observables);

  return () => {
    meter.removeBatchObservableCallback(observe, observables);
    loopDelay.disable();
  };
}
