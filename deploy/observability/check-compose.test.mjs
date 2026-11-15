// Sensitivity tests of check-compose.mjs (DEV-133): a valid resolved configuration passes, and breaking
// each rule, one at a time, is reported. Run with `node --test deploy/observability/check-compose.test.mjs`.
import assert from "node:assert/strict";
import test from "node:test";
import { checkCompose, checkRetention } from "./check-compose.mjs";

const DIGEST = `@sha256:${"a".repeat(64)}`;
const limits = { resources: { limits: { cpus: 0.5, memory: "268435456" } } };
const named = (target) => ({ type: "volume", source: "data", target });

function validConfig() {
  return {
    services: {
      "otel-collector": { image: `otel/collector:1${DIGEST}`, deploy: limits, networks: { observability: null, internal: null } },
      loki: { image: `grafana/loki:1${DIGEST}`, deploy: limits, volumes: [named("/loki")], networks: { internal: null } },
      tempo: { image: `grafana/tempo:1${DIGEST}`, deploy: limits, volumes: [named("/var/tempo")], networks: { internal: null } },
      prometheus: { image: `prom/prometheus:1${DIGEST}`, deploy: limits, volumes: [named("/prometheus")], networks: { internal: null } },
      grafana: {
        image: `grafana/grafana:1${DIGEST}`,
        deploy: limits,
        volumes: [named("/var/lib/grafana")],
        ports: [{ host_ip: "127.0.0.1", target: 3000, published: "3001" }],
        networks: { internal: null, ui: null },
        environment: {
          GF_SECURITY_ADMIN_USER: "ops",
          GF_SECURITY_ADMIN_PASSWORD__FILE: "/run/secrets/grafana_admin_password",
          GF_AUTH_ANONYMOUS_ENABLED: "false",
          GF_USERS_ALLOW_SIGN_UP: "false",
        },
      },
    },
    networks: { internal: { internal: true }, observability: {}, ui: {} },
  };
}

test("a configuration that follows every rule passes", () => {
  assert.deepEqual(checkCompose(validConfig()), []);
});

const breakages = [
  ["Grafana published on all interfaces", (c) => { c.services.grafana.ports[0].host_ip = ""; }, /grafana: port 3000 is published on/],
  ["Grafana published on a public address", (c) => { c.services.grafana.ports[0].host_ip = "0.0.0.0"; }, /not on loopback/],
  ["a storage component publishing a port", (c) => { c.services.loki.ports = [{ host_ip: "127.0.0.1", target: 3100 }]; }, /loki: must not publish any port/],
  ["the collector publishing OTLP", (c) => { c.services["otel-collector"].ports = [{ host_ip: "0.0.0.0", target: 4318 }]; }, /otel-collector: must not publish any port/],
  ["an image pinned only by tag", (c) => { c.services.tempo.image = "grafana/tempo:3.1.1"; }, /tempo: image must be pinned by digest/],
  ["a service without a memory limit", (c) => { c.services.prometheus.deploy = { resources: { limits: { cpus: 0.5 } } }; }, /prometheus: deploy.resources.limits/],
  ["data on an anonymous path instead of a named volume", (c) => { c.services.loki.volumes = []; }, /loki: data at \/loki must live in a named volume/],
  ["anonymous Grafana access", (c) => { c.services.grafana.environment.GF_AUTH_ANONYMOUS_ENABLED = "true"; }, /anonymous access must be disabled/],
  ["Grafana sign-up", (c) => { delete c.services.grafana.environment.GF_USERS_ALLOW_SIGN_UP; }, /sign-up must be disabled/],
  ["an admin password in the environment", (c) => { c.services.grafana.environment.GF_SECURITY_ADMIN_PASSWORD = "x"; }, /must come from a secret file/],
  ["the default admin user", (c) => { c.services.grafana.environment.GF_SECURITY_ADMIN_USER = "admin"; }, /must not be the default "admin"/],
  ["a non-internal storage network", (c) => { c.networks.internal = {}; }, /"internal" must be an internal network/],
  ["a storage component on the network shared with the API", (c) => { c.services.loki.networks.observability = null; }, /loki: only otel-collector joins/],
];

for (const [label, breakIt, expected] of breakages) {
  test(`reports ${label}`, () => {
    const config = validConfig();
    breakIt(config);
    const problems = checkCompose(config);
    assert.ok(problems.some((problem) => expected.test(problem)), `expected ${expected}; got ${JSON.stringify(problems)}`);
  });
}

const retention = {
  loki: "limits_config:\n  retention_period: 168h\ncompactor:\n  retention_enabled: true\n",
  tempo: "backend_scheduler:\n  block_retention: 168h\nbackend_worker:\n  block_retention: 168h\n",
  compose: "- --storage.tsdb.retention.time=15d\n- --storage.tsdb.retention.size=2GB\n",
};

test("declared retention passes", () => {
  assert.deepEqual(checkRetention(retention), []);
});

test("reports missing retention for each signal", () => {
  assert.match(checkRetention({ ...retention, loki: "retention_period: 168h\n" }).join(), /loki.yaml/);
  assert.match(checkRetention({ ...retention, tempo: "backend_worker:\n  block_retention: 168h\n" }).join(), /tempo.yaml/);
  assert.match(checkRetention({ ...retention, compose: "- --storage.tsdb.retention.time=15d\n" }).join(), /prometheus must set retention/);
});
