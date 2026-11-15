import { FastifyOtelInstrumentation } from "@fastify/otel";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { HttpInstrumentation } from "@opentelemetry/instrumentation-http";
import { PgInstrumentation } from "@opentelemetry/instrumentation-pg";
import { PinoInstrumentation } from "@opentelemetry/instrumentation-pino";
import { metrics } from "@opentelemetry/api";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { registerProcessMetrics } from "./process-metrics.js";

// The exporter and span shapes are taken from the SDK's own configuration type instead of importing
// `@opentelemetry/sdk-trace`, which is only a transitive dependency of the packages approved for this API.
type NodeSdkConfiguration = NonNullable<ConstructorParameters<typeof NodeSDK>[0]>;
export type SpanExporter = NonNullable<NodeSdkConfiguration["traceExporter"]>;
export type ExportedSpan = Parameters<SpanExporter["export"]>[0][number];
type ExportCallback = Parameters<SpanExporter["export"]>[1];
export type LogRecordProcessor = NonNullable<NodeSdkConfiguration["logRecordProcessors"]>[number];
type MetricView = NonNullable<NodeSdkConfiguration["views"]>[number];

export const DEFAULT_SERVICE_NAME = "saldocerto-api";

// Telemetry is opt-in: without one of these variables the SDK is never started, nothing is patched and
// nothing leaves the process, so the API behaves exactly as it did before tracing existed.
export const TELEMETRY_ENDPOINT_VARIABLES = ["OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", "OTEL_EXPORTER_OTLP_ENDPOINT"] as const;

type Environment = Readonly<Record<string, string | undefined>>;

export function isTelemetryEnabled(environment: Environment): boolean {
  return TELEMETRY_ENDPOINT_VARIABLES.some((name) => (environment[name] ?? "").trim() !== "");
}

// Sending logs over OTLP is a second, explicit opt-in on top of the endpoint (`OTEL_LOGS_EXPORTER=otlp`):
// with only the endpoint set, logs stay on stdout as before. When enabled, the SDK builds the OTLP log
// exporter from the same standard variables. What it sends is the line pino already serialized — after
// `requestLoggerOptions` applied its serializers and redaction — so the log rules of `app.ts` hold for
// the copy that leaves the process too.
export function isLogExportEnabled(environment: Environment): boolean {
  return (environment.OTEL_LOGS_EXPORTER ?? "").trim().toLowerCase() === "otlp";
}

// Metrics follow the same rule as logs (DEV-134): a separate opt-in, `OTEL_METRICS_EXPORTER=otlp`, and the
// SDK builds the OTLP metric exporter from the standard variables. They are pushed to the collector; the
// API exposes no /metrics endpoint, so nothing about them is reachable through its public port.
export function isMetricExportEnabled(environment: Environment): boolean {
  return (environment.OTEL_METRICS_EXPORTER ?? "").trim().toLowerCase() === "otlp";
}

// `undefined` makes the SDK build the metric readers from the environment — the production path. The SDK
// defaults OTEL_METRICS_EXPORTER to otlp when it is empty, so the empty list is what keeps metrics off.
export function metricReadersFor({ sendMetrics }: { sendMetrics: boolean }): [] | undefined {
  return sendMetrics ? undefined : [];
}

// The metric twin of the span allowlist (vault rule 21): only these attributes become metric labels. A
// label is a dimension stored for every combination of values, so anything identifying — a user, a
// wallet, an e-mail, an amount, a raw URL — would be both personal data and unbounded cardinality.
export const METRIC_ATTRIBUTES = new Set([
  "http.request.method", "http.response.status_code", "http.route", "error.type", "url.scheme", "network.protocol.version",
  "db.system", "db.system.name", "db.namespace", "db.operation.name", "db.client.connection.state", "db.client.connection.pool.name",
  "cpu.mode",
  // Business metrics of the financial imports (business-metrics.ts).
  "import.format", "import.kind", "item.outcome",
]);

export function filterMetricAttributes(attributes: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(attributes).filter(([key]) => METRIC_ATTRIBUTES.has(key)));
}

export const metricViews: MetricView[] = [{
  instrumentName: "*",
  attributesProcessors: [{ process: (incoming) => filterMetricAttributes(incoming) as typeof incoming }],
  // A ceiling on label combinations per metric, in case an allowed label ever turns unbounded.
  aggregationCardinalityLimit: 2000,
}];

// What leaves the process is an allowlist, not a denylist (vault rule 21: a guard whose silence means
// "let it through" lists the inert, never the sensitive). An attribute is exported only if it is named
// here; anything else — a header, a body, a query string, a statement parameter, a client address, or an
// attribute some future instrumentation invents — is dropped at export time, the last point before data
// leaves the process.
const EXPORTED_ATTRIBUTES = new Set([
  // HTTP server span (stable semantic conventions, plus the legacy names an opt-in could switch back to).
  "http.request.method", "http.response.status_code", "http.route", "url.path", "url.scheme", "error.type",
  "server.address", "server.port", "network.protocol.version",
  "http.method", "http.status_code", "http.target", "http.scheme", "http.flavor", "net.host.name", "net.host.port",
  // Fastify lifecycle spans.
  "fastify.root", "fastify.type", "hook.name", "hook.callback.name",
  // PostgreSQL spans. The statement text carries placeholders ($1), never values — see
  // `pgInstrumentationConfig`. The database user and connection string stay out.
  "db.system", "db.system.name", "db.namespace", "db.name", "db.query.text", "db.statement",
  "db.operation.name", "db.collection.name", "db.response.status_code", "net.peer.name", "net.peer.port",
  "db.postgresql.idle.timeout.millis", "db.postgresql.max.clients",
]);
// Exported, but without the query string: @fastify/otel writes the raw request URL into `url.path`.
const PATH_ATTRIBUTES = new Set(["url.path", "http.target"]);

export function redactAttributes(attributes: ExportedSpan["attributes"]): ExportedSpan["attributes"] {
  const redacted: Record<string, ExportedSpan["attributes"][string]> = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (!EXPORTED_ATTRIBUTES.has(key)) continue;
    redacted[key] = PATH_ATTRIBUTES.has(key) && typeof value === "string" ? value.split("?")[0] : value;
  }
  return redacted;
}

// An error message is free text written by whoever threw it, and PostgreSQL echoes the offending value
// in some of them (`invalid input syntax for type uuid: "…"`). An exception event keeps only the error
// type, and the span status keeps only its code — the log line of the request still says what failed.
const EXPORTED_EVENT_ATTRIBUTES = new Set(["exception.type"]);

export function redactEvents(events: ExportedSpan["events"]): ExportedSpan["events"] {
  return events.map((event) => ({
    ...event,
    attributes: Object.fromEntries(Object.entries(event.attributes ?? {}).filter(([key]) => EXPORTED_EVENT_ATTRIBUTES.has(key))),
  }));
}

// Wraps the real exporter and hands it spans whose attributes, events and status went through the
// redaction. The span is not copied field by field: a view with the span as prototype keeps every field
// and method (`spanContext()` included) and overrides only what is redacted.
export class RedactingSpanExporter implements SpanExporter {
  constructor(private readonly delegate: SpanExporter) {}

  export(spans: ExportedSpan[], resultCallback: ExportCallback): void {
    const redacted = spans.map((span) => Object.create(span, {
      attributes: { value: redactAttributes(span.attributes), enumerable: true },
      events: { value: redactEvents(span.events), enumerable: true },
      status: { value: { code: span.status.code }, enumerable: true },
    }) as ExportedSpan);
    this.delegate.export(redacted, resultCallback);
  }

  shutdown(): Promise<void> {
    return this.delegate.shutdown();
  }

  forceFlush(): Promise<void> {
    return this.delegate.forceFlush?.() ?? Promise.resolve();
  }
}

// The health check is polled by the container runtime every few seconds; tracing it would only bury
// real requests under noise.
const UNTRACED_PATHS = new Set(["/health"]);

// The first lock on SQL values: the instrumentation never attaches statement parameters to a span —
// they are passwords, tokens and financial values. The export-time redaction above is the second lock,
// and each one is tested on its own, since a test of both together would pass with either one broken.
export const pgInstrumentationConfig = {
  enhancedDatabaseReporting: false,
  requireParentSpan: true,
} as const;

export function createInstrumentations({ sendLogs }: { sendLogs: boolean }) {
  return [
    new HttpInstrumentation({
      ignoreIncomingRequestHook: (request) => UNTRACED_PATHS.has((request.url ?? "").split("?")[0]),
    }),
    new FastifyOtelInstrumentation({
      registerOnInitialization: true,
      ignorePaths: ({ url }) => UNTRACED_PATHS.has(url),
    }),
    new PgInstrumentation(pgInstrumentationConfig),
    new PinoInstrumentation({
      // Logs always keep going to stdout as JSON; the instrumentation correlates each line with its span
      // and, only when log export is enabled, also hands the same line to the OTLP log exporter.
      disableLogSending: !sendLogs,
      logKeys: { traceId: "traceId", spanId: "spanId", traceFlags: "traceFlags" },
    }),
  ];
}

// What `logRecordProcessors` the SDK receives. `undefined` is not "nothing": it makes the SDK build the
// OTLP log exporter from the environment, which is the production path. An empty list keeps logs off.
export function logRecordProcessorsFor({ logProcessor, sendLogs }: { logProcessor?: LogRecordProcessor; sendLogs: boolean }): LogRecordProcessor[] | undefined {
  if (logProcessor) return [logProcessor];
  return sendLogs ? undefined : [];
}

export interface TelemetryOptions {
  environment: Environment;
  // Tests inject an in-memory exporter; production builds the OTLP one, which reads its endpoint from
  // the same standard variables.
  exporter?: SpanExporter;
  // Tests inject an in-memory log processor; production uses the OTLP one when `isLogExportEnabled`.
  logProcessor?: LogRecordProcessor;
}

// What the caller keeps: shutting down flushes buffered telemetry and releases what the SDK and the
// process metrics hold (the event loop delay monitor included).
export interface Telemetry {
  shutdown(): Promise<void>;
}

export function startTelemetry({ environment, exporter, logProcessor }: TelemetryOptions): Telemetry | null {
  if (!exporter && !isTelemetryEnabled(environment)) return null;
  const sendLogs = logProcessor !== undefined || isLogExportEnabled(environment);
  const sendMetrics = isMetricExportEnabled(environment);
  const sdk = new NodeSDK({
    serviceName: environment.OTEL_SERVICE_NAME?.trim() || DEFAULT_SERVICE_NAME,
    // No resource detection: the process detector would export the command line and the host
    // detectors machine details, none of which a trace of this API needs.
    autoDetectResources: false,
    // No propagator: a `traceparent` sent by the client is ignored, so no caller chooses the traceId that
    // lands in our logs or decides whether its own request is sampled. The API calls no other traced
    // service, so there is nothing to propagate onwards either.
    textMapPropagator: null,
    traceExporter: new RedactingSpanExporter(exporter ?? new OTLPTraceExporter()),
    instrumentations: createInstrumentations({ sendLogs }),
    // An empty list keeps the SDK from configuring a log exporter from the environment on its own;
    // leaving it undefined lets the SDK build the OTLP log exporter from `OTEL_LOGS_EXPORTER`.
    logRecordProcessors: logRecordProcessorsFor({ logProcessor, sendLogs }),
    metricReaders: metricReadersFor({ sendMetrics }),
    views: metricViews,
  });
  sdk.start();
  // HTTP and pg metrics come from their instrumentations once the SDK sets the meter provider; the
  // process metrics are registered here, on that same provider.
  const stopProcessMetrics = sendMetrics ? registerProcessMetrics(metrics.getMeter(DEFAULT_SERVICE_NAME)) : undefined;
  return {
    shutdown: async () => {
      stopProcessMetrics?.();
      await sdk.shutdown();
    },
  };
}
