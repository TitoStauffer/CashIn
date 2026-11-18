// Checks the rules of the production stack (DEV-159) on the configuration Docker Compose actually resolves,
// not on the YAML text, plus the Dockerfiles it builds. Usage, from the repository root, with the
// placeholder values the CI step uses:
//
//   SITE_ADDRESS=localhost ACME_EMAIL=check@example.invalid POSTGRES_DB=check POSTGRES_USER=check \
//     POSTGRES_PASSWORD=check docker compose -f deploy/production/compose.yaml config --format json \
//     | node deploy/production/check-compose.mjs
//
// Exits non-zero and lists every broken rule. The rules are what keeps the database and the API off the
// internet and keeps the forwarded client address trustworthy.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const PUBLISHING_SERVICE = "proxy";
const PUBLIC_PORTS = new Set([80, 443]);
const DIGEST = /@sha256:[0-9a-f]{64}$/;
const STORAGE = { db: "/var/lib/postgresql/data", proxy: "/data" };

export function checkCompose(config) {
  const problems = [];
  const services = config.services ?? {};
  const networks = config.networks ?? {};

  for (const name of ["proxy", "api", "db"]) {
    if (!services[name]) problems.push(`${name}: service is missing`);
  }

  for (const [name, service] of Object.entries(services)) {
    if (!service.build && !DIGEST.test(service.image ?? "")) {
      problems.push(`${name}: image must be pinned by digest (got ${service.image ?? "none"})`);
    }
    const limits = service.deploy?.resources?.limits ?? {};
    if (!limits.memory || !limits.cpus) problems.push(`${name}: deploy.resources.limits must set memory and cpus`);
    if (service.privileged) problems.push(`${name}: must not be privileged`);
    if (!(service.security_opt ?? []).includes("no-new-privileges:true")) {
      problems.push(`${name}: security_opt must include no-new-privileges:true`);
    }
    if (!service.restart || service.restart === "no") problems.push(`${name}: must set a restart policy`);
    if (service.network_mode === "host") problems.push(`${name}: must not use the host network`);
    for (const port of service.ports ?? []) {
      if (name !== PUBLISHING_SERVICE) problems.push(`${name}: must not publish any port (publishes ${port.target})`);
      else if (!PUBLIC_PORTS.has(Number(port.target))) problems.push(`${name}: publishes ${port.target}; only 80 and 443 are allowed`);
    }
  }

  for (const [name, target] of Object.entries(STORAGE)) {
    const volumes = services[name]?.volumes ?? [];
    if (!volumes.some((volume) => volume.type === "volume" && volume.target === target)) {
      problems.push(`${name}: data at ${target} must live in a named volume`);
    }
  }

  const databaseNetworks = Object.keys(services.db?.networks ?? {});
  if (databaseNetworks.length === 0) problems.push("db: must join an internal network explicitly");
  for (const network of databaseNetworks) {
    if (networks[network]?.internal !== true) problems.push(`db: network "${network}" must be internal`);
  }

  const api = services.api ?? {};
  if (api.environment?.NODE_ENV !== "production") problems.push("api: NODE_ENV must be production (Secure cookies)");
  const proxyAddress = services.proxy?.networks?.edge?.ipv4_address;
  if (!proxyAddress) problems.push("proxy: must have a fixed ipv4_address on the edge network");
  if (api.environment?.TRUSTED_PROXIES !== proxyAddress) {
    problems.push(`api: TRUSTED_PROXIES must be exactly the proxy address (got ${api.environment?.TRUSTED_PROXIES ?? "none"})`);
  }
  // Without a dynamic pool that leaves the fixed address out, a container started first can take it, and
  // the proxy cannot start (seen in the first smoke test run).
  const pools = (networks.edge?.ipam?.config ?? []).map((entry) => entry.ip_range).filter(Boolean);
  if (proxyAddress && (pools.length === 0 || pools.some((pool) => inRange(proxyAddress, pool)))) {
    problems.push(`networks: edge must declare an ip_range that leaves the proxy address ${proxyAddress} out`);
  }
  return problems;
}

function toNumber(address) {
  return address.split(".").reduce((value, part) => value * 256 + Number(part), 0);
}

function inRange(address, cidr) {
  const [base, bits] = cidr.split("/");
  const size = 2 ** (32 - Number(bits));
  const start = Math.floor(toNumber(base) / size) * size;
  return toNumber(address) >= start && toNumber(address) < start + size;
}

// Built images: every stage pinned by digest, and the API never runs as root.
export function checkDockerfiles({ api, web }) {
  const problems = [];
  for (const [name, text] of Object.entries({ api, web })) {
    const bases = [...text.matchAll(/^FROM\s+(\S+)/gim)].map((match) => match[1]);
    if (bases.length === 0) problems.push(`${name} Dockerfile.production: no FROM line`);
    for (const base of bases) {
      if (!DIGEST.test(base)) problems.push(`${name} Dockerfile.production: base ${base} must be pinned by digest`);
    }
  }
  const finalStage = api.split(/^FROM\s/im).at(-1) ?? "";
  const user = [...finalStage.matchAll(/^USER\s+(\S+)/gim)].at(-1)?.[1];
  if (!user || user === "root" || user === "0") problems.push("api Dockerfile.production: the final stage must run as a non-root USER");
  return problems;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
  const config = JSON.parse(readFileSync(0, "utf8"));
  const problems = [
    ...checkCompose(config),
    ...checkDockerfiles({ api: read("../../apps/api/Dockerfile.production"), web: read("../../apps/web/Dockerfile.production") }),
  ];
  if (problems.length > 0) {
    console.error(`Production stack rules broken:\n- ${problems.join("\n- ")}`);
    process.exit(1);
  }
  console.log("Production stack rules hold.");
}
