import assert from "node:assert/strict";
import { before, test } from "node:test";
import type { AddressInfo } from "node:net";
import type { ExportedSpan, SpanExporter } from "./telemetry.js";
import { isTelemetryEnabled, pgInstrumentationConfig, redactAttributes, redactEvents, startTelemetry } from "./telemetry.js";

// DEV-131. The SDK patches Fastify, pino, http and pg when they are loaded, so it is started here before
// `app.js` and `pg` are imported — the same order `node --import ./dist/instrumentation.js` gives
// production. Every test reads what one real request, served over a real socket, produced.

class CollectingExporter implements SpanExporter {
  readonly spans: ExportedSpan[] = [];
  export(spans: ExportedSpan[], resultCallback: Parameters<SpanExporter["export"]>[1]): void {
    this.spans.push(...spans);
    resultCallback({ code: 0 });
  }
  async shutdown(): Promise<void> {}
}

const SECRETS = {
  queryToken: "segredo-na-query-string",
  cookie: "segredo-do-cookie",
  authorization: "segredo-do-authorization",
  password: "segredo-do-corpo",
  sqlValue: "segredo-parametro-sql",
  errorMessage: "segredo-na-mensagem-de-erro",
};

// A traceparent a client might send to pick the traceId of its own request. It must be ignored.
const CLIENT_TRACE_ID = "0af7651916cd43dd8448eb211c80319c";

const exporter = new CollectingExporter();
const logLines: Array<Record<string, unknown>> = [];
let sensitiveStatus = 0;

before(async () => {
  const sdk = startTelemetry({ environment: {}, exporter });
  assert.ok(sdk, "an injected exporter must start the SDK");
  const { createApp } = await import("./app.js");
  const pg = await import("pg");

  const app = createApp({
    query: async () => ({ rows: [], rowCount: 0 }),
    transaction: async (work) => work({ query: async () => ({ rows: [], rowCount: 0 }) }),
  }, { logger: { write: (line) => { logLines.push(JSON.parse(line) as Record<string, unknown>); } } });

  // A pg client that was closed before connecting rejects every query at once, but only after the
  // instrumentation opened the query span with everything it knows about the statement — which is what
  // the redaction has to be proven against, without depending on a database.
  app.post("/test-only/sensitive", async (request) => {
    request.log.info("handling sensitive request");
    const client = new pg.default.Client();
    await client.end();
    await client.query("SELECT id FROM users WHERE password_hash = $1", [SECRETS.sqlValue]).catch(() => undefined);
    return { ok: true };
  });
  // An error whose message carries a value: the exception event and the span status must not export it.
  app.get("/test-only/failure", async () => {
    throw new Error(`falha ao processar ${SECRETS.errorMessage}`);
  });

  await app.listen({ port: 0, host: "127.0.0.1" });
  const { port } = app.server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;

  const sensitive = await fetch(`${base}/test-only/sensitive?token=${SECRETS.queryToken}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie: `cashin_session=${SECRETS.cookie}`,
      authorization: `Bearer ${SECRETS.authorization}`,
      traceparent: `00-${CLIENT_TRACE_ID}-b7ad6b7169203331-01`,
    },
    body: JSON.stringify({ password: SECRETS.password }),
  });
  sensitiveStatus = sensitive.status;
  await fetch(`${base}/test-only/failure`);
  await fetch(`${base}/health`);

  await app.close();
  // Shutting the SDK down flushes the batch processor into the collecting exporter.
  await sdk.shutdown();
});

function requestTraceId(): string {
  const server = exporter.spans.find((span) => span.kind === 1 && String(span.attributes["url.path"] ?? span.attributes["http.target"] ?? "").startsWith("/test-only/sensitive"));
  assert.ok(server, `the HTTP server span must be exported; got ${exporter.spans.map((span) => span.name).join(", ")}`);
  return server.spanContext().traceId;
}

test("a request produces one trace with the HTTP, Fastify and pg spans", () => {
  assert.equal(sensitiveStatus, 200);
  const traceId = requestTraceId();
  const spans = exporter.spans.filter((span) => span.spanContext().traceId === traceId);
  const libraries = new Set(spans.map((span) => span.instrumentationScope.name));
  assert.ok(libraries.has("@opentelemetry/instrumentation-http"), `http span missing: ${[...libraries].join(", ")}`);
  assert.ok([...libraries].some((name) => name.includes("fastify")), `fastify span missing: ${[...libraries].join(", ")}`);
  const query = spans.find((span) => span.instrumentationScope.name === "@opentelemetry/instrumentation-pg" && span.name.startsWith("pg.query"));
  assert.ok(query, `pg query span missing: ${spans.map((span) => span.name).join(", ")}`);
  // The statement itself is kept — it is what makes a slow query findable — with placeholders only.
  assert.match(JSON.stringify(query.attributes), /password_hash = \$1/);
});

test("the log lines of a request carry the traceId of its exported trace", () => {
  const traceId = requestTraceId();
  const handlerLine = logLines.find((line) => line.msg === "handling sensitive request");
  assert.ok(handlerLine, "the handler log line must be emitted");
  assert.equal(handlerLine.traceId, traceId);
  assert.match(String(handlerLine.spanId), /^[0-9a-f]{16}$/);
  assert.equal(typeof handlerLine.reqId, "string");
});

test("no exported span carries a password, token, cookie, request body or SQL parameter value", () => {
  const exported = JSON.stringify(exporter.spans.map((span) => ({
    name: span.name,
    attributes: span.attributes,
    events: span.events,
    status: span.status,
    resource: span.resource.attributes,
  })));
  for (const [kind, secret] of Object.entries(SECRETS)) {
    assert.equal(exported.includes(secret), false, `${kind} leaked into an exported span`);
  }
  assert.equal(JSON.stringify(logLines).includes(SECRETS.sqlValue), false);
});

test("an exception is exported by its type only, without the message or the stack trace", () => {
  const exceptions = exporter.spans.flatMap((span) => span.events.filter((event) => event.name === "exception"));
  // Without an exception event the assertion below would pass on nothing.
  assert.ok(exceptions.length > 0, "the failing route must export an exception event");
  // The type survives where the instrumentation recorded one (pg records only the message).
  assert.ok(exceptions.some((event) => event.attributes?.["exception.type"] === "Error"));
  for (const event of exceptions) {
    assert.equal(event.attributes?.["exception.message"], undefined);
    assert.equal(event.attributes?.["exception.stacktrace"], undefined);
  }
  for (const span of exporter.spans) assert.equal(span.status.message, undefined);
});

test("a traceparent sent by the client does not choose the traceId of the request", () => {
  assert.notEqual(requestTraceId(), CLIENT_TRACE_ID);
  assert.deepEqual(exporter.spans.filter((span) => span.spanContext().traceId === CLIENT_TRACE_ID).map((span) => span.name), []);
});

test("the health check is not traced", () => {
  const health = exporter.spans.filter((span) => JSON.stringify(span.attributes).includes("/health"));
  assert.deepEqual(health.map((span) => span.name), []);
});

test("redaction exports only allowlisted attributes and strips query strings from paths", () => {
  assert.deepEqual(redactAttributes({
    "http.request.header.cookie": ["x"],
    "http.response.header.set-cookie": ["x"],
    "http.request.body.size": 10,
    "db.query.parameter.0": "x",
    "db.statement.parameters": "x",
    "db.user": "x",
    "db.connection_string": "postgresql://x",
    "url.query": "token=x",
    "url.full": "http://host/path?token=x",
    "http.url": "http://host/path?token=x",
    "client.address": "203.0.113.10",
    "network.peer.address": "203.0.113.10",
    "user_agent.original": "x",
    // An attribute no instrumentation sets today: unknown means dropped.
    "some.future.attribute": "x",
    "http.target": "/path?token=x",
    // @fastify/otel writes the raw request URL, query string included, into `url.path`.
    "url.path": "/path?token=x",
    "http.route": "/path",
    "http.request.method": "GET",
    "db.query.text": "SELECT 1",
  }), {
    "http.target": "/path",
    "url.path": "/path",
    "http.route": "/path",
    "http.request.method": "GET",
    "db.query.text": "SELECT 1",
  });
});

test("an exception event keeps only the error type", () => {
  assert.deepEqual(redactEvents([
    { name: "exception", time: [0, 0], attributes: { "exception.type": "Error", "exception.message": "x", "exception.stacktrace": "x", "other": "x" } },
    { name: "exception", time: [0, 0] },
  ]).map((event) => event.attributes), [{ "exception.type": "Error" }, {}]);
});

test("telemetry stays off without an OTLP endpoint", () => {
  assert.equal(isTelemetryEnabled({}), false);
  assert.equal(isTelemetryEnabled({ OTEL_EXPORTER_OTLP_ENDPOINT: "  " }), false);
  assert.equal(isTelemetryEnabled({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318" }), true);
  assert.equal(isTelemetryEnabled({ OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "http://collector:4318/v1/traces" }), true);
  assert.equal(startTelemetry({ environment: {} }), null);
});

test("the pg instrumentation never attaches statement parameters, independently of the redaction", () => {
  assert.equal(pgInstrumentationConfig.enhancedDatabaseReporting, false);
});

test("the exported resource names the service and carries no host or process details", () => {
  const resource = exporter.spans[0]?.resource.attributes ?? {};
  assert.equal(resource["service.name"], "saldocerto-api");
  const detected = Object.keys(resource).filter((key) => key.startsWith("host.") || key.startsWith("process.") || key.startsWith("os."));
  assert.deepEqual(detected, []);
});
