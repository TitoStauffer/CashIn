// Smoke test of the production stack (DEV-159), run by the "Smoke test production stack" step of the API CI
// job when the stack changes, and runnable locally from the repository root:
//
//   node deploy/production/smoke/smoke-test.mjs
//
// It uses the host ports 80 and 443, or HTTP_PORT and HTTPS_PORT when they are set (for a machine where
// those ports are taken).
//
// It builds and brings up deploy/production/compose.yaml as the runbook does, with SITE_ADDRESS=localhost so
// Caddy issues the certificate from its own local authority, and checks over real HTTPS: the API health
// through /api, the Web and its fallback, the HTTP redirect, the security headers, the Secure session cookie,
// that a forged X-Forwarded-For does not escape the login budget, and that only Caddy publishes ports, only
// 80 and 443. It always tears the stack down with its volumes. Every step prints what it observed.
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

const COMPOSE_FILE = "deploy/production/compose.yaml";
const PROJECT = "saldocerto-smoke";
const OBSERVABILITY_NETWORK = "saldocerto-observability";
// Same pinned image as the API's Dockerfile.production; used as a second client inside the stack network.
const NODE_IMAGE = "node:24-alpine@sha256:116b800c3754b440ee0aa3ed2f20f5bf3d99a554bfd9adeea09ea8017f6e85f5";
const HTTP_PORT = Number(process.env.HTTP_PORT || 80);
const HTTPS_PORT = Number(process.env.HTTPS_PORT || 443);
const workDirectory = mkdtempSync(join(tmpdir(), "production-smoke-"));
const rootCertificate = join(workDirectory, "root.crt");
const env = {
  ...process.env,
  SITE_ADDRESS: "localhost",
  ACME_EMAIL: "smoke@example.invalid",
  POSTGRES_DB: "saldocerto",
  POSTGRES_USER: "saldocerto",
  POSTGRES_PASSWORD: randomBytes(24).toString("base64url"),
  HTTP_PORT: String(HTTP_PORT),
  HTTPS_PORT: String(HTTPS_PORT),
};

function run(command, args, { allowFailure = false } = {}) {
  const result = spawnSync(command, args, { env, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0 && !allowFailure) {
    throw new Error(`${command} ${args.join(" ")} failed (${result.status}):\n${result.stderr || result.stdout}`);
  }
  return result;
}
const compose = (...args) => run("docker", ["compose", "-p", PROJECT, "-f", COMPOSE_FILE, ...args]);

function step(message) {
  console.log(`\n== ${message}`);
}

function check(condition, message) {
  if (!condition) throw new Error(message);
  console.log(`ok: ${message}`);
}

async function until(description, attempt, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      const value = await attempt();
      if (value) return value;
    } catch (error) {
      last = error;
    }
    await delay(2000);
  }
  throw new Error(`timed out waiting for ${description}${last ? `: ${last.message}` : ""}`);
}

// HTTPS to 127.0.0.1 with the name `localhost`, trusting only Caddy's local authority.
function https(method, path, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      { host: "127.0.0.1", port: HTTPS_PORT, servername: "localhost", method, path, ca: readFileSync(rootCertificate), headers: { host: "localhost", ...headers } },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => { data += chunk; });
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
      },
    );
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

function plainHttp(path) {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port: HTTP_PORT, path, headers: { host: "localhost" } }, (res) => {
      res.resume();
      resolve({ status: res.statusCode, headers: res.headers });
    });
    req.on("error", reject);
    req.end();
  });
}

const createdNetwork = run("docker", ["network", "inspect", OBSERVABILITY_NETWORK], { allowFailure: true }).status !== 0;

try {
  if (createdNetwork) {
    step(`creating the external network ${OBSERVABILITY_NETWORK} (deploy/observability would create it on the VPS)`);
    run("docker", ["network", "create", OBSERVABILITY_NETWORK]);
  }

  step("building and starting the stack");
  compose("up", "-d", "--build", "--wait", "--wait-timeout", "300");

  step("reading Caddy's local certificate authority");
  await until("the local root certificate", async () =>
    compose("cp", "proxy:/data/caddy/pki/authorities/local/root.crt", rootCertificate).status === 0);

  step("API through /api");
  const health = await until("/api/health over HTTPS", async () => {
    const response = await https("GET", "/api/health");
    return response.status === 200 ? response : null;
  });
  check(JSON.parse(health.body).status === "ok" && JSON.parse(health.body).database === "ok", `/api/health answers ${health.body}`);
  check(/max-age=\d+/.test(health.headers["strict-transport-security"] ?? ""), "HSTS header is sent");
  check(health.headers["x-content-type-options"] === "nosniff", "X-Content-Type-Options is nosniff");
  check(health.headers.server === undefined, "the Server header is removed");

  step("Web");
  const home = await https("GET", "/");
  check(home.status === 200 && /text\/html/.test(home.headers["content-type"] ?? "") && home.body.includes('id="root"'), "/ serves the Web");
  const deepLink = await https("GET", "/cartoes-de-credito");
  check(deepLink.status === 200 && deepLink.body.includes('id="root"'), "an unknown path falls back to the Web, whose router resolves it");

  step("plain HTTP");
  const redirect = await plainHttp("/");
  check(redirect.status === 308 && /^https:\/\/localhost(:\d+)?\/$/.test(redirect.headers.location ?? ""), `HTTP redirects to HTTPS (${redirect.status} ${redirect.headers.location})`);

  step("session cookie");
  const logout = await https("POST", "/api/auth/logout");
  const cookie = String(logout.headers["set-cookie"] ?? "");
  check(logout.status === 204 && /;\s*Secure/.test(cookie) && /HttpOnly/.test(cookie), "the session cookie is HttpOnly and Secure");

  step("forwarded address");
  const login = (forwardedFor) => https("POST", "/api/auth/login", {
    headers: { "content-type": "application/json", "x-forwarded-for": forwardedFor },
    body: JSON.stringify({ email: "smoke@example.invalid", password: "WrongPassword1!" }),
  });
  for (let attempt = 1; attempt <= 10; attempt += 1) {
    const response = await login(`198.51.100.${attempt}`);
    if (response.status !== 401) throw new Error(`login attempt ${attempt} answered ${response.status}`);
  }
  const blocked = await login("198.51.100.200");
  check(blocked.status === 429, "ten failed logins from one client block the eleventh, whatever X-Forwarded-For it sends");
  // Another client, a container on the edge network talking to Caddy directly, keeps its own budget. If the
  // API took Caddy's address for every request, one client's failures would lock everyone out.
  const otherClientScript = `
    const https = require("node:https");
    const req = https.request({ host: "172.30.10.2", port: 443, servername: "localhost", method: "POST", path: "/api/auth/login",
      ca: require("node:fs").readFileSync("/root.crt"), headers: { host: "localhost", "content-type": "application/json" } },
      (res) => { console.log(res.statusCode); res.resume(); });
    req.on("error", (error) => { console.error(error.message); process.exit(1); });
    req.end(JSON.stringify({ email: "smoke@example.invalid", password: "WrongPassword1!" }));`;
  const otherClient = run("docker", [
    "run", "--rm", "--network", `${PROJECT}_edge`, "-v", `${rootCertificate}:/root.crt:ro`, NODE_IMAGE, "node", "-e", otherClientScript,
  ]).stdout.trim();
  check(otherClient === "401", `another client through the proxy still has its own login budget (answered ${otherClient})`);

  step("published ports");
  const containers = compose("ps", "--format", "json").stdout.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  check(containers.length === 3, `three containers run (${containers.map((container) => container.Service).join(", ")})`);
  for (const container of containers) {
    const published = (container.Publishers ?? []).filter((publisher) => publisher.PublishedPort > 0);
    if (container.Service === "proxy") {
      check(published.length > 0 && published.every((publisher) => [80, 443].includes(publisher.TargetPort)), `proxy publishes only 80 and 443 (${published.map((p) => `${p.TargetPort}/${p.Protocol}`).join(", ")})`);
    } else {
      check(published.length === 0, `${container.Service} publishes no port`);
    }
  }

  console.log("\nProduction stack smoke test passed.");
} catch (error) {
  console.error(`\nProduction stack smoke test FAILED: ${error.message}`);
  const logs = compose("logs", "--no-color", "--tail", "80").stdout;
  console.error(logs);
  process.exitCode = 1;
} finally {
  step("tearing down");
  compose("down", "--volumes", "--remove-orphans");
  if (createdNetwork) run("docker", ["network", "rm", OBSERVABILITY_NETWORK], { allowFailure: true });
  rmSync(workDirectory, { recursive: true, force: true });
}
