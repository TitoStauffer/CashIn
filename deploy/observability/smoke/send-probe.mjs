// Sends one OTLP trace, one log and one metric sharing a trace id to the collector. Run by smoke-test.mjs
// inside a container on the saldocerto-observability network, which is how the API reaches the collector.
const traceId = process.argv[2];
const spanId = "a1b2c3d4e5f60718";
const nowNs = BigInt(Date.now()) * 1000000n;
const resource = { attributes: [{ key: "service.name", value: { stringValue: "saldocerto-api" } }] };
const post = async (path, body) => {
  const response = await fetch(`http://otel-collector:4318${path}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  console.log(path, response.status);
};
await post("/v1/traces", { resourceSpans: [{ resource, scopeSpans: [{ scope: { name: "probe" }, spans: [{
  traceId, spanId, name: "POST /probe", kind: 2,
  startTimeUnixNano: String(nowNs - 5000000n), endTimeUnixNano: String(nowNs),
}] }] }] });
await post("/v1/logs", { resourceLogs: [{ resource, scopeLogs: [{ scope: { name: "probe" }, logRecords: [{
  timeUnixNano: String(nowNs), severityText: "info", body: { stringValue: "probe log line" }, traceId, spanId,
  attributes: [{ key: "reqId", value: { stringValue: "probe-req-id" } }],
}] }] }] });
await post("/v1/metrics", { resourceMetrics: [{ resource, scopeMetrics: [{ scope: { name: "probe" }, metrics: [{
  name: "probe_requests", sum: { aggregationTemporality: 2, isMonotonic: true, dataPoints: [{
    asInt: "1", attributes: [{ key: "probe_trace", value: { stringValue: traceId } }], startTimeUnixNano: String(nowNs - 60000000000n), timeUnixNano: String(nowNs),
  }] },
}] }] }] });
