import { FastifyOtelInstrumentation } from "@fastify/otel";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { HttpInstrumentation } from "@opentelemetry/instrumentation-http";
import { PgInstrumentation } from "@opentelemetry/instrumentation-pg";
import { PinoInstrumentation } from "@opentelemetry/instrumentation-pino";
import { NodeSDK } from "@opentelemetry/sdk-node";

// The exporter and span shapes are taken from the SDK's own configuration type instead of importing
// `@opentelemetry/sdk-trace`, which is only a transitive dependency of the packages approved for this API.
type NodeSdkConfiguration = NonNullable<ConstructorParameters<typeof NodeSDK>[0]>;
export type SpanExporter = NonNullable<NodeSdkConfiguration["traceExporter"]>;
export type ExportedSpan = Parameters<SpanExporter["export"]>[0][number];
type ExportCallback = Parameters<SpanExporter["export"]>[1];

export const DEFAULT_SERVICE_NAME = "saldocerto-api";

// Telemetry is opt-in: without one of these variables the SDK is never started, nothing is patched and
// nothing leaves the process, so the API behaves exactly as it did before tracing existed.
export const TELEMETRY_ENDPOINT_VARIABLES = ["OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", "OTEL_EXPORTER_OTLP_ENDPOINT"] as const;

type Environment = Readonly<Record<string, string | undefined>>;

export function isTelemetryEnabled(environment: Environment): boolean {
  return TELEMETRY_ENDPOINT_VARIABLES.some((name) => (environment[name] ?? "").trim() !== "");
}

// Attributes that may carry what a trace must never hold — a query string can carry a token, a header a
// cookie or a credential, a statement parameter a password or a financial value. They are dropped at
// export time, the last point before data leaves the process, so the rule holds for attributes any
// current or future instrumentation sets, not only for the ones configured below.
const DROPPED_ATTRIBUTE_PREFIXES = [
  "http.request.header.",
  "http.response.header.",
  "http.request.body",
  "http.response.body",
  "db.query.parameter.",
  "db.operation.parameter.",
] as const;
const DROPPED_ATTRIBUTES = new Set(["url.query", "db.statement.parameters", "db.postgresql.values"]);
// Attributes that hold a URL, a path or a request target: kept, but without the query string. `url.path`
// is here because @fastify/otel writes the raw request URL, query string included, into it.
const URL_ATTRIBUTES = new Set(["url.full", "url.path", "http.url", "http.target"]);

export function redactAttributes(attributes: ExportedSpan["attributes"]): ExportedSpan["attributes"] {
  const redacted: Record<string, ExportedSpan["attributes"][string]> = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (DROPPED_ATTRIBUTES.has(key) || DROPPED_ATTRIBUTE_PREFIXES.some((prefix) => key.startsWith(prefix))) continue;
    redacted[key] = URL_ATTRIBUTES.has(key) && typeof value === "string" ? value.split("?")[0] : value;
  }
  return redacted;
}

// Wraps the real exporter and hands it spans whose attributes went through `redactAttributes`. The span
// is not copied field by field: a view with the span as prototype keeps every field and method
// (`spanContext()` included) and overrides only `attributes`.
export class RedactingSpanExporter implements SpanExporter {
  constructor(private readonly delegate: SpanExporter) {}

  export(spans: ExportedSpan[], resultCallback: ExportCallback): void {
    const redacted = spans.map((span) => Object.create(span, {
      attributes: { value: redactAttributes(span.attributes), enumerable: true },
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

export function createInstrumentations() {
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
      // Logs keep going to stdout as JSON; the instrumentation only correlates each line with its span.
      disableLogSending: true,
      logKeys: { traceId: "traceId", spanId: "spanId", traceFlags: "traceFlags" },
    }),
  ];
}

export interface TelemetryOptions {
  environment: Environment;
  // Tests inject an in-memory exporter; production builds the OTLP one, which reads its endpoint from
  // the same standard variables.
  exporter?: SpanExporter;
}

export function startTelemetry({ environment, exporter }: TelemetryOptions): NodeSDK | null {
  if (!exporter && !isTelemetryEnabled(environment)) return null;
  const sdk = new NodeSDK({
    serviceName: environment.OTEL_SERVICE_NAME?.trim() || DEFAULT_SERVICE_NAME,
    // No resource detection: the process detector would export the command line and the host
    // detectors machine details, none of which a trace of this API needs.
    autoDetectResources: false,
    traceExporter: new RedactingSpanExporter(exporter ?? new OTLPTraceExporter()),
    instrumentations: createInstrumentations(),
    // Traces only. Empty lists keep the SDK from configuring log and metric exporters from the
    // environment on its own.
    logRecordProcessors: [],
    metricReaders: [],
  });
  sdk.start();
  return sdk;
}
