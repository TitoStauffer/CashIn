// Smoke test of the production observability stack (DEV-133), run by the `Observability stack` CI job when
// deploy/observability changes, and runnable locally from the repository root:
//
//   node deploy/observability/smoke/smoke-test.mjs
//
// It brings the stack up exactly as the runbook does, sends a trace, a log and a metric through the
// collector the way the API would, reads all three back through the authenticated Grafana, restarts the
// stack and reads them again (persistence), checks that only Grafana publishes a port and only on
// loopback, and always tears the stack down with its volumes. Every step prints what it observed.
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

const COMPOSE_FILE = "deploy/observability/compose.yaml";
const PROBE_DIRECTORY = resolve("deploy/observability/smoke");
const NODE_IMAGE = "node:24-alpine@sha256:116b800c3754b440ee0aa3ed2f20f5bf3d99a554bfd9adeea09ea8017f6e85f5";
const GRAFANA = "http://127.0.0.1:3001";
const ADMIN_USER = "smoke-test";

const secretsDirectory = mkdtempSync(join(tmpdir(), "observability-smoke-"));
const passwordFile = join(secretsDirectory, "grafana-admin-password");
const password = randomBytes(18).toString("base64url");
// Outside swarm, a Compose secret is a bind mount that keeps the host permissions, and Grafana runs as
// uid 472: a 600 file owned by the runner is unreadable inside the container, and Grafana would start
// without the configured password. The file is world-readable inside a 700 directory instead, which keeps
// other host users out (same layout as the runbook).
writeFileSync(passwordFile, password, { mode: 0o644 });
const env = { ...process.env, GRAFANA_ADMIN_USER: ADMIN_USER, GRAFANA_ADMIN_PASSWORD_FILE: passwordFile };

function run(command, args, { allowFailure = false } = {}) {
  const result = spawnSync(command, args, { env, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0 && !allowFailure) {
    throw new Error(`${command} ${args.join(" ")} failed (${result.status}):\n${result.stderr || result.stdout}`);
  }
  return result.stdout;
}
const compose = (...args) => run("docker", ["compose", "-f", COMPOSE_FILE, ...args]);

function step(message) {
  console.log(`\n== ${message}`);
}

async function until(description, check, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      last = error;
    }
    await delay(3000);
  }
  throw new Error(`timed out waiting for ${description}${last ? `: ${last.message}` : ""}`);
}

async function login() {
  const response = await fetch(`${GRAFANA}/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ user: ADMIN_USER, password }),
  });
  if (response.status !== 200) throw new Error(`login answered ${response.status}`);
  return response.headers.getSetCookie().map((cookie) => cookie.split(";")[0]).join("; ");
}

async function readBack(traceId) {
  const cookie = await login();
  const get = (path) => fetch(`${GRAFANA}${path}`, { headers: { cookie } });
  const end = BigInt(Date.now()) * 1_000_000n;
  const start = end - 3_600n * 1_000_000_000n;
  return until("the probe in Tempo, Loki and Prometheus", async () => {
    const trace = await get(`/api/datasources/proxy/uid/tempo/api/traces/${traceId}`);
    const logs = await (await get(`/api/datasources/proxy/uid/loki/loki/api/v1/query_range?query=${encodeURIComponent(`{service_name="saldocerto-api"} | trace_id="${traceId}"`)}&start=${start}&end=${end}`)).json();
    const metric = await (await get(`/api/datasources/proxy/uid/prometheus/api/v1/query?query=${encodeURIComponent(`probe_requests_total{probe_trace="${traceId}"}`)}`)).json();
    const lines = logs.data?.result?.flatMap((stream) => stream.values.map((value) => value[1])) ?? [];
    const samples = metric.data?.result?.length ?? 0;
    console.log(`tempo trace: ${trace.status}; loki lines: ${lines.length}; prometheus series: ${samples}`);
    return trace.status === 200 && lines.includes("probe log line") && samples === 1;
  }, 120_000);
}

async function waitForGrafana() {
  await until("Grafana", async () => (await fetch(`${GRAFANA}/api/health`)).ok);
  console.log("grafana is up");
}

let failed = false;
try {
  step("bring the stack up");
  compose("up", "-d");
  await waitForGrafana();

  step("only Grafana publishes a port, and only on loopback");
  const containers = compose("ps", "--format", "json").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const published = containers.flatMap((container) => (container.Publishers ?? [])
    .filter((publisher) => publisher.PublishedPort > 0)
    .map((publisher) => ({ service: container.Service, url: publisher.URL, port: publisher.PublishedPort })));
  console.log(JSON.stringify(published));
  if (published.length === 0 || published.some((entry) => entry.service !== "grafana" || !["127.0.0.1", "::1"].includes(entry.url))) {
    throw new Error("a port is published outside Grafana's loopback binding");
  }

  step("anonymous access is refused");
  const anonymous = await fetch(`${GRAFANA}/api/datasources`);
  console.log(`anonymous /api/datasources: ${anonymous.status}`);
  if (anonymous.status !== 401) throw new Error("Grafana answered an anonymous request");

  step("send a trace, a log and a metric through the collector");
  const traceId = randomBytes(16).toString("hex");
  run("docker", ["run", "--rm", "--network", "saldocerto-observability", "-v", `${PROBE_DIRECTORY}:/probe:ro`, NODE_IMAGE, "node", "/probe/send-probe.mjs", traceId]);
  console.log(`probe trace id: ${traceId}`);

  step("read all three back through the authenticated Grafana");
  await readBack(traceId);

  step("restart the stack and read them again (persistence)");
  compose("down");
  compose("up", "-d");
  await waitForGrafana();
  await readBack(traceId);
  console.log("\nObservability stack smoke test passed.");
} catch (error) {
  failed = true;
  console.error(`\nObservability stack smoke test FAILED: ${error.message}`);
  console.error(run("docker", ["compose", "-f", COMPOSE_FILE, "logs", "--tail", "40"], { allowFailure: true }));
} finally {
  run("docker", ["compose", "-f", COMPOSE_FILE, "down", "-v"], { allowFailure: true });
  rmSync(secretsDirectory, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
