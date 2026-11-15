import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { BUSINESS_METRIC_NAMES } from "./business-metrics.js";
import { PROCESS_METRIC_NAMES } from "./process-metrics.js";

// DEV-136. The Grafana dashboard is versioned in deploy/observability and provisioned in both stacks. These
// tests keep it honest: every query references a metric the API really exports, so a renamed metric breaks
// this test instead of leaving an empty panel nobody notices.

const DASHBOARD_PATH = new URL("../../../deploy/observability/grafana/dashboards/saldocerto-api.json", import.meta.url);
const PROVIDER_PATH = new URL("../../../deploy/observability/grafana/provisioning/dashboards/saldocerto.yaml", import.meta.url);

// Every metric name the API exports, as OpenTelemetry names it: the HTTP and pg ones come from their
// instrumentations, the process and business ones from this code base.
export const API_METRIC_NAMES = [
  "http.server.request.duration",
  "db.client.connection.count",
  "db.client.connection.pending_requests",
  "db.client.connection.max",
  "db.client.operation.duration",
  ...PROCESS_METRIC_NAMES,
  ...BUSINESS_METRIC_NAMES,
];

// Prometheus receives OTLP names with dots turned into underscores, plus a unit suffix and, per series
// type, a counter or histogram suffix. Stripping those suffixes gives back the OpenTelemetry name.
const SERIES_SUFFIXES = ["_bucket", "_count", "_sum", "_total"];
const UNIT_SUFFIXES = ["_seconds", "_bytes"];

// Every reading of a Prometheus name as an OpenTelemetry one: a name may end in "_count" because the metric
// is called that (db.client.connection.count) or because it is a histogram count series.
export function openTelemetryNamesOf(prometheusName: string): string[] {
  const series = SERIES_SUFFIXES.find((suffix) => prometheusName.endsWith(suffix));
  const candidates = new Set([prometheusName, series ? prometheusName.slice(0, -series.length) : prometheusName]);
  for (const name of [...candidates]) {
    const unit = UNIT_SUFFIXES.find((suffix) => name.endsWith(suffix));
    if (unit) candidates.add(name.slice(0, -unit.length));
  }
  return [...candidates];
}

const PROMQL_KEYWORDS = new Set(["sum", "rate", "increase", "histogram_quantile", "by", "max", "le"]);

export function metricNamesIn(expr: string): string[] {
  // Label matchers, label lists and range selectors hold label names and durations, not metric names.
  const withoutLabels = expr.replace(/\{[^}]*\}/g, "").replace(/\bby\s*\([^)]*\)/g, "").replace(/\[[^\]]*\]/g, "");
  return [...withoutLabels.matchAll(/\b([a-z_][a-z0-9_]*)\b/g)]
    .map((match) => match[1])
    .filter((name) => !PROMQL_KEYWORDS.has(name) && /_/.test(name));
}

export function unknownMetrics(dashboard: { panels: Array<{ targets?: Array<{ expr: string }> }> }): string[] {
  const known = new Set(API_METRIC_NAMES.map((name) => name.replaceAll(".", "_")));
  return dashboard.panels
    .flatMap((panel) => panel.targets ?? [])
    .flatMap((target) => metricNamesIn(target.expr))
    .filter((name) => !openTelemetryNamesOf(name).some((candidate) => known.has(candidate)));
}

type Dashboard = {
  uid: string;
  editable: boolean;
  panels: Array<{ type: string; title: string; datasource?: { uid: string }; targets?: Array<{ expr: string }> }>;
  links: Array<{ url: string; keepTime: boolean }>;
};
const dashboard = JSON.parse(readFileSync(DASHBOARD_PATH, "utf8")) as Dashboard;

test("every dashboard query references a metric the API exports", () => {
  const referenced = dashboard.panels.flatMap((panel) => panel.targets ?? []).flatMap((target) => metricNamesIn(target.expr));
  assert.ok(referenced.length > 0);
  assert.deepEqual(unknownMetrics(dashboard), []);
});

test("an unknown metric in a query is reported", () => {
  assert.deepEqual(unknownMetrics({ panels: [{ targets: [{ expr: 'sum(rate(http_server_requests_total{service_name="x"}[5m]))' }] }] }), ["http_server_requests_total"]);
  assert.deepEqual(unknownMetrics({ panels: [{ targets: [{ expr: "sum by (item_outcome) (increase(financial_import_items_total[5m]))" }] }] }), []);
});

test("the dashboard covers API health and import usage", () => {
  const exprs = dashboard.panels.flatMap((panel) => panel.targets ?? []).map((target) => target.expr).join("\n");
  for (const required of [
    "http_server_request_duration_seconds_count", // requests per second and 5xx rate
    'http_response_status_code=~"5.."',
    "histogram_quantile(0.5,", "histogram_quantile(0.95,", "histogram_quantile(0.99,", // latency per route
    "db_client_connection_count", "nodejs_eventloop_delay_p99_seconds", "process_memory_usage_bytes",
    "financial_import_confirmed_total", "financial_import_undone_total", "financial_import_failed_total",
    'item_outcome="skipped_duplicate"',
  ]) {
    assert.ok(exprs.includes(required), `the dashboard must query ${required}`);
  }
});

test("every panel reads the provisioned Prometheus datasource, and the dashboard links to traces and logs", () => {
  for (const panel of dashboard.panels.filter((candidate) => candidate.type !== "row")) {
    assert.equal(panel.datasource?.uid, "prometheus", `${panel.title} must use the provisioned Prometheus`);
  }
  assert.equal(dashboard.editable, false);
  const links = dashboard.links.map((link) => decodeURIComponent(link.url));
  assert.ok(links.some((url) => url.includes('"uid":"tempo"')), "a link must open Tempo");
  assert.ok(links.some((url) => url.includes('"uid":"loki"')), "a link must open Loki");
  assert.ok(dashboard.links.every((link) => link.keepTime), "links must keep the selected period");
});

test("the provider refuses UI saves and points at the folder both stacks mount", () => {
  const provider = readFileSync(PROVIDER_PATH, "utf8");
  // Criterion 3 rests on this flag: with it, Grafana answers "Cannot save provisioned dashboard".
  assert.match(provider, /^\s*allowUiUpdates:\s*false\s*$/m);
  assert.match(provider, /^\s*disableDeletion:\s*true\s*$/m);
  assert.match(provider, /^\s*path:\s*\/var\/lib\/saldocerto\/dashboards\s*$/m);
});
