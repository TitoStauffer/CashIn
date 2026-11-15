// Checks the rules of the production observability stack (DEV-133) on the configuration Docker Compose
// actually resolves, not on the YAML text. Usage, from the repository root:
//
//   GRAFANA_ADMIN_USER=check GRAFANA_ADMIN_PASSWORD_FILE=/dev/null \
//     docker compose -f deploy/observability/compose.yaml config --format json \
//     | node deploy/observability/check-compose.mjs
//
// Exits non-zero and lists every broken rule. The rules are what keeps this stack from being exposed or
// from starving the API that shares the VPS with it.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const LOOPBACK = new Set(["127.0.0.1", "::1"]);
const PUBLISHED_ONLY_BY = new Set(["grafana"]);
const STORAGE_SERVICES = { loki: "/loki", tempo: "/var/tempo", prometheus: "/prometheus", grafana: "/var/lib/grafana" };

export function checkCompose(config) {
  const problems = [];
  const services = config.services ?? {};

  for (const [name, service] of Object.entries(services)) {
    if (!/@sha256:[0-9a-f]{64}$/.test(service.image ?? "")) {
      problems.push(`${name}: image must be pinned by digest (got ${service.image ?? "none"})`);
    }
    const limits = service.deploy?.resources?.limits ?? {};
    if (!limits.memory || !limits.cpus) problems.push(`${name}: deploy.resources.limits must set memory and cpus`);
    for (const port of service.ports ?? []) {
      if (!PUBLISHED_ONLY_BY.has(name)) problems.push(`${name}: must not publish any port`);
      if (!LOOPBACK.has(port.host_ip ?? "")) {
        problems.push(`${name}: port ${port.target} is published on "${port.host_ip ?? "all interfaces"}", not on loopback`);
      }
    }
  }

  for (const [name, target] of Object.entries(STORAGE_SERVICES)) {
    const volumes = services[name]?.volumes ?? [];
    if (!volumes.some((volume) => volume.type === "volume" && volume.target === target)) {
      problems.push(`${name}: data at ${target} must live in a named volume`);
    }
  }

  const grafana = services.grafana?.environment ?? {};
  if (grafana.GF_AUTH_ANONYMOUS_ENABLED !== "false") problems.push("grafana: anonymous access must be disabled");
  if (grafana.GF_USERS_ALLOW_SIGN_UP !== "false") problems.push("grafana: sign-up must be disabled");
  if ("GF_SECURITY_ADMIN_PASSWORD" in grafana) problems.push("grafana: the admin password must come from a secret file, not an environment value");
  if (!grafana.GF_SECURITY_ADMIN_PASSWORD__FILE) problems.push("grafana: GF_SECURITY_ADMIN_PASSWORD__FILE must be set");
  if (!grafana.GF_SECURITY_ADMIN_USER || grafana.GF_SECURITY_ADMIN_USER === "admin") {
    problems.push("grafana: the admin user must be set explicitly and must not be the default \"admin\"");
  }

  if (config.networks?.internal?.internal !== true) problems.push("networks: \"internal\" must be an internal network");
  for (const [name, service] of Object.entries(services)) {
    const networks = Object.keys(service.networks ?? {});
    if (name !== "otel-collector" && networks.includes("observability")) {
      problems.push(`${name}: only otel-collector joins the network shared with the API`);
    }
  }
  return problems;
}

// Retention is declared in the component files; the compose file only mounts them.
export function checkRetention(files) {
  const problems = [];
  if (!/retention_period:\s*\d+h/.test(files.loki) || !/retention_enabled:\s*true/.test(files.loki)) {
    problems.push("loki.yaml: retention_period and compactor.retention_enabled must be set");
  }
  if ((files.tempo.match(/block_retention:\s*\d+h/g) ?? []).length < 2) {
    problems.push("tempo.yaml: block_retention must be set for the backend scheduler and the backend worker");
  }
  if (!/--storage\.tsdb\.retention\.size=\d+[KMGT]B/.test(files.compose) || !/--storage\.tsdb\.retention\.time=\d+[dhw]/.test(files.compose)) {
    problems.push("compose.yaml: prometheus must set retention by time and by size");
  }
  return problems;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const directory = new URL(".", import.meta.url);
  const read = (name) => readFileSync(new URL(name, directory), "utf8");
  const config = JSON.parse(readFileSync(0, "utf8"));
  const problems = [
    ...checkCompose(config),
    ...checkRetention({ loki: read("loki.yaml"), tempo: read("tempo.yaml"), compose: read("compose.yaml") }),
  ];
  if (problems.length > 0) {
    console.error(`Observability stack rules broken:\n- ${problems.join("\n- ")}`);
    process.exit(1);
  }
  console.log("Observability stack rules hold.");
}
