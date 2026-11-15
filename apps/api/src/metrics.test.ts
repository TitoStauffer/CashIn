import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { before, test } from "node:test";
import type { ExportedSpan, SpanExporter } from "./telemetry.js";
import { filterMetricAttributes, isMetricExportEnabled, metricReadersFor, startTelemetry } from "./telemetry.js";
import { PROCESS_METRIC_NAMES } from "./process-metrics.js";

// DEV-134. The production path, end to end: OTEL_METRICS_EXPORTER=otlp makes the SDK build its own OTLP
// metric exporter from the environment, which here points to a local receiver. Its own process (node
// --test runs each file apart), because the SDK and the instrumentations are global.

type DataPoint = { attributes?: Array<{ key: string; value: Record<string, unknown> }>; asInt?: string; asDouble?: number; count?: string };
type Metric = { name: string; sum?: { dataPoints: DataPoint[] }; gauge?: { dataPoints: DataPoint[] }; histogram?: { dataPoints: DataPoint[] } };

const payloads: string[] = [];
const ITEM_ID = "segredo-id-do-recurso-123";
let metricsRouteStatus = 0;
let poolQueryRan = false;

function dataPoints(metric: Metric): DataPoint[] {
  return metric.sum?.dataPoints ?? metric.gauge?.dataPoints ?? metric.histogram?.dataPoints ?? [];
}

function exportedMetrics(): Metric[] {
  return payloads.flatMap((payload) => (JSON.parse(payload) as { resourceMetrics: Array<{ scopeMetrics: Array<{ metrics: Metric[] }> }> })
    .resourceMetrics.flatMap((resource) => resource.scopeMetrics.flatMap((scope) => scope.metrics)));
}

function attributesOf(point: DataPoint): Record<string, unknown> {
  return Object.fromEntries((point.attributes ?? []).map(({ key, value }) => [key, Object.values(value)[0]]));
}

before(async () => {
  const receiver = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      payloads.push(Buffer.concat(chunks).toString("utf8"));
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    });
  });
  await new Promise<void>((resolve) => receiver.listen(0, "127.0.0.1", resolve));
  const { port } = receiver.address() as AddressInfo;

  // The SDK reads these from process.env itself; the short interval lets an export happen while a
  // database query is still holding a pool connection.
  Object.assign(process.env, {
    OTEL_METRICS_EXPORTER: "otlp",
    OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: `http://127.0.0.1:${port}/v1/metrics`,
    OTEL_EXPORTER_OTLP_METRICS_PROTOCOL: "http/json",
    OTEL_METRIC_EXPORT_INTERVAL: "200",
  });
  const spans: SpanExporter = {
    export: (_spans: ExportedSpan[], done) => done({ code: 0 }),
    shutdown: async () => {},
  };
  const sdk = startTelemetry({ environment: process.env, exporter: spans });
  assert.ok(sdk);
  const { createApp } = await import("./app.js");
  const pg = await import("pg");

  const app = createApp({
    query: async () => ({ rows: [], rowCount: 0 }),
    transaction: async (work) => work({ query: async () => ({ rows: [], rowCount: 0 }) }),
  });
  app.get("/test-only/items/:itemId", async () => ({ ok: true }));
  // In the API every query runs inside a request, and the pg instrumentation only records inside a span
  // (`requireParentSpan`), so the pool is exercised from a route, as the application does.
  const pool = process.env.TEST_DATABASE_URL
    ? new pg.default.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 2 })
    : null;
  app.get("/test-only/slow-query", async () => {
    await pool!.query("SELECT pg_sleep(0.8)");
    return { ok: true };
  });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;

  await fetch(`${base}/test-only/items/${ITEM_ID}`);
  await fetch(`${base}/test-only/items/${ITEM_ID}?wallet=x`);
  metricsRouteStatus = (await fetch(`${base}/metrics`)).status;

  if (pool) {
    poolQueryRan = (await fetch(`${base}/test-only/slow-query`)).status === 200;
    await pool.end();
  }

  await app.close();
  await sdk.shutdown();
  await new Promise<void>((resolve) => receiver.close(() => resolve()));
});

test("HTTP requests are counted under the route template, never under the id in the URL", () => {
  const duration = exportedMetrics().filter((metric) => metric.name === "http.server.request.duration");
  const points = duration.flatMap(dataPoints).map(attributesOf);
  assert.ok(points.some((attributes) => attributes["http.route"] === "/test-only/items/:itemId"), `got ${JSON.stringify(points)}`);
  assert.ok(points.every((attributes) => attributes["http.response.status_code"] !== undefined));
  assert.equal(payloads.join("").includes(ITEM_ID), false, "the resource id leaked into a metric");
});

test("every exported metric label is on the allowlist", () => {
  const labels = new Set(exportedMetrics().flatMap(dataPoints).flatMap((point) => Object.keys(attributesOf(point))));
  assert.ok(labels.size > 0);
  const allowed = new Set(Object.keys(filterMetricAttributes(Object.fromEntries([...labels].map((label) => [label, 1])))));
  assert.deepEqual([...labels].filter((label) => !allowed.has(label)), []);
  for (const forbidden of ["url.full", "url.path", "url.query", "client.address", "user_agent.original", "server.address", "server.port"]) {
    assert.equal(labels.has(forbidden), false, `${forbidden} must not be a metric label`);
  }
});

test("the process metrics are exported", () => {
  const names = new Set(exportedMetrics().map((metric) => metric.name));
  assert.deepEqual(PROCESS_METRIC_NAMES.filter((name) => !names.has(name)), []);
});

test("the API exposes no metrics endpoint on its public port", () => {
  assert.equal(metricsRouteStatus, 404);
});

test("the pool metrics show a connection in use while a query runs", { skip: !process.env.TEST_DATABASE_URL && "needs TEST_DATABASE_URL" }, () => {
  assert.equal(poolQueryRan, true);
  const used = exportedMetrics()
    .filter((metric) => metric.name === "db.client.connection.count")
    .flatMap(dataPoints)
    .filter((point) => attributesOf(point)["db.client.connection.state"] === "used")
    .map((point) => Number(point.asInt ?? point.asDouble ?? 0));
  assert.ok(used.some((value) => value >= 1), `connections in use seen by the exports: ${JSON.stringify(used)}`);
});

test("metric export is a separate opt-in, built from the environment only when enabled", () => {
  assert.equal(isMetricExportEnabled({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318" }), false);
  assert.equal(isMetricExportEnabled({ OTEL_METRICS_EXPORTER: " OTLP " }), true);
  assert.equal(metricReadersFor({ sendMetrics: true }), undefined);
  assert.deepEqual(metricReadersFor({ sendMetrics: false }), []);
});
