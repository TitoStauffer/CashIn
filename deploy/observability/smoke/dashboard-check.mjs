// Proves that every query of the versioned Grafana dashboard returns data after real API traffic (DEV-136).
// Run from the repository root after `npm ci` and `npm run build` in apps/api:
//
//   DATABASE_URL=postgresql://user:password@host.docker.internal:5432/db node deploy/observability/smoke/dashboard-check.mjs
//
// It brings the production observability stack up, runs the compiled API in a container on the
// saldocerto-observability network (drive-api.mjs) against that PostgreSQL, then runs each dashboard query
// through the authenticated Grafana and fails if any of them comes back empty. The stack is always torn
// down with its volumes.
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

const COMPOSE_FILE = "deploy/observability/compose.yaml";
const DASHBOARD = "deploy/observability/grafana/dashboards/saldocerto-api.json";
const NODE_IMAGE = "node:24-alpine@sha256:116b800c3754b440ee0aa3ed2f20f5bf3d99a554bfd9adeea09ea8017f6e85f5";
const GRAFANA = "http://127.0.0.1:3001";
const ADMIN_USER = "dashboard-check";
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("set DATABASE_URL to a disposable PostgreSQL reachable from a container");

const secretsDirectory = mkdtempSync(join(tmpdir(), "dashboard-check-"));
const passwordFile = join(secretsDirectory, "grafana-admin-password");
const password = randomBytes(18).toString("base64url");
// World-readable inside a 700 directory: Grafana (uid 472) reads it through a bind mount (see the runbook).
writeFileSync(passwordFile, password, { mode: 0o644 });
const env = { ...process.env, GRAFANA_ADMIN_USER: ADMIN_USER, GRAFANA_ADMIN_PASSWORD_FILE: passwordFile };

function run(command, args, { allowFailure = false } = {}) {
  const result = spawnSync(command, args, { env, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0 && !allowFailure) {
    throw new Error(`${command} ${args.slice(0, 4).join(" ")} … failed (${result.status}):\n${(result.stderr || result.stdout).slice(-4000)}`);
  }
  return result.stdout;
}
const compose = (...args) => run("docker", ["compose", "-f", COMPOSE_FILE, ...args]);

async function until(description, check, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { if (await check()) return; } catch { /* retried below */ }
    await delay(3000);
  }
  throw new Error(`timed out waiting for ${description}`);
}

// Grafana variables replaced by fixed windows. The traffic of drive-api.mjs lasts about 25 seconds; 5 minutes
// keeps it inside every rate window for the whole retry period below, so a slow ingestion cannot turn into
// a false "no data" for a query that does have data.
export function concreteQuery(expr) {
  return expr.replaceAll("$__rate_interval", "5m").replaceAll("$__range", "15m");
}

let failed = false;
try {
  console.log("== bring the stack up");
  compose("up", "-d");
  await until("Grafana", async () => (await fetch(`${GRAFANA}/api/health`)).ok);

  console.log("== run the compiled API with real traffic through the collector");
  const output = run("docker", [
    "run", "--rm", "--network", "saldocerto-observability", "--add-host", "host.docker.internal:host-gateway",
    "-v", `${resolve("apps/api")}:/app:ro`, "-v", `${resolve("deploy/observability/smoke")}:/probe:ro`,
    "-w", "/app",
    "-e", `DATABASE_URL=${databaseUrl}`,
    "-e", "OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4318",
    "-e", "OTEL_LOGS_EXPORTER=otlp", "-e", "OTEL_METRICS_EXPORTER=otlp", "-e", "OTEL_METRIC_EXPORT_INTERVAL=2000",
    "-e", "OTEL_SERVICE_NAME=saldocerto-api",
    NODE_IMAGE, "node", "--import", "/app/dist/instrumentation.js", "/probe/drive-api.mjs",
  ]);
  console.log(output.split("\n").filter((line) => line.startsWith("round ")).join("\n"));

  console.log("== every dashboard query returns data");
  const login = await fetch(`${GRAFANA}/login`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ user: ADMIN_USER, password }),
  });
  if (login.status !== 200) throw new Error(`login answered ${login.status}`);
  const cookie = login.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
  const dashboard = JSON.parse(readFileSync(DASHBOARD, "utf8"));
  const targets = dashboard.panels.flatMap((panel) => (panel.targets ?? []).map((target) => ({ panel: panel.title, legend: target.legendFormat, expr: target.expr })));
  const empty = [];
  await until("every query to return data", async () => {
    empty.length = 0;
    for (const target of targets) {
      const query = encodeURIComponent(concreteQuery(target.expr));
      const result = await (await fetch(`${GRAFANA}/api/datasources/proxy/uid/prometheus/api/v1/query?query=${query}`, { headers: { cookie } })).json();
      if (result.status !== "success" || (result.data?.result?.length ?? 0) === 0) empty.push(`${target.panel} · ${target.legend}`);
    }
    return empty.length === 0;
  }, 90_000).catch(() => undefined);
  for (const target of targets) console.log(`${empty.includes(`${target.panel} · ${target.legend}`) ? "EMPTY" : "data "} | ${target.panel} · ${target.legend}`);
  if (empty.length > 0) throw new Error(`${empty.length} dashboard queries returned no data`);
  console.log(`\nAll ${targets.length} dashboard queries returned data.`);
} catch (error) {
  failed = true;
  console.error(`\nDashboard check FAILED: ${error.message}`);
} finally {
  run("docker", ["compose", "-f", COMPOSE_FILE, "down", "-v"], { allowFailure: true });
  rmSync(secretsDirectory, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
