// Sensitivity tests of check-compose.mjs (DEV-159): each rule must hold on a valid stack and fail on the
// one change that breaks it. Run with `node --test deploy/production/check-compose.test.mjs`.
import { test } from "node:test";
import assert from "node:assert/strict";

import { checkCompose, checkDockerfiles } from "./check-compose.mjs";

const PINNED = "@sha256:" + "a".repeat(64);
const hardened = () => ({
  security_opt: ["no-new-privileges:true"],
  restart: "unless-stopped",
  deploy: { resources: { limits: { cpus: "0.5", memory: "268435456" } } },
});

// The shape `docker compose config --format json` resolves, reduced to what the rules read.
function validStack() {
  return {
    services: {
      proxy: {
        ...hardened(),
        build: { context: "apps/web", dockerfile: "Dockerfile.production" },
        ports: [{ target: 80, published: "80" }, { target: 443, published: "443" }, { target: 443, published: "443", protocol: "udp" }],
        networks: { edge: { ipv4_address: "172.30.10.2" } },
        volumes: [{ type: "volume", source: "caddy_data", target: "/data" }],
      },
      api: {
        ...hardened(),
        build: { context: "apps/api", dockerfile: "Dockerfile.production" },
        environment: { NODE_ENV: "production", TRUSTED_PROXIES: "172.30.10.2" },
        networks: { edge: null, data: null, observability: null },
      },
      db: {
        ...hardened(),
        image: `postgres:17-alpine${PINNED}`,
        networks: { data: null },
        volumes: [{ type: "volume", source: "postgres_data", target: "/var/lib/postgresql/data" }],
      },
    },
    networks: {
      edge: { ipam: { config: [{ subnet: "172.30.10.0/24", ip_range: "172.30.10.128/25" }] } },
      data: { internal: true },
      observability: { external: true },
    },
  };
}

function broken(change) {
  const stack = validStack();
  change(stack);
  return checkCompose(stack);
}

test("a valid stack holds every rule", () => {
  assert.deepEqual(checkCompose(validStack()), []);
});

test("the database or the API publishing a port fails", () => {
  assert.match(broken((s) => { s.services.db.ports = [{ target: 5432, published: "5432" }]; }).join("\n"), /db: must not publish any port/);
  assert.match(broken((s) => { s.services.api.ports = [{ target: 3000, published: "3000" }]; }).join("\n"), /api: must not publish any port/);
});

test("the proxy publishing anything but 80 and 443 fails", () => {
  assert.match(broken((s) => { s.services.proxy.ports.push({ target: 2019, published: "2019" }); }).join("\n"), /only 80 and 443/);
});

test("an image not pinned by digest fails", () => {
  assert.match(broken((s) => { s.services.db.image = "postgres:17-alpine"; }).join("\n"), /db: image must be pinned by digest/);
});

test("a missing resource limit fails", () => {
  assert.match(broken((s) => { delete s.services.api.deploy.resources.limits.memory; }).join("\n"), /api: deploy.resources.limits/);
  assert.match(broken((s) => { s.services.db.deploy = {}; }).join("\n"), /db: deploy.resources.limits/);
});

test("privileges, restart policy and host network are checked", () => {
  assert.match(broken((s) => { s.services.api.privileged = true; }).join("\n"), /api: must not be privileged/);
  assert.match(broken((s) => { s.services.proxy.security_opt = []; }).join("\n"), /proxy: security_opt/);
  assert.match(broken((s) => { s.services.db.restart = "no"; }).join("\n"), /db: must set a restart policy/);
  assert.match(broken((s) => { s.services.api.network_mode = "host"; }).join("\n"), /api: must not use the host network/);
});

test("the database on a network that is not internal fails", () => {
  assert.match(broken((s) => { s.services.db.networks.edge = null; }).join("\n"), /db: network "edge" must be internal/);
  assert.match(broken((s) => { s.networks.data.internal = false; }).join("\n"), /db: network "data" must be internal/);
  assert.match(broken((s) => { delete s.services.db.networks; }).join("\n"), /db: must join an internal network/);
});

test("database and certificate data outside a named volume fails", () => {
  assert.match(broken((s) => { s.services.db.volumes = [{ type: "bind", source: "/srv/pg", target: "/var/lib/postgresql/data" }]; }).join("\n"), /db: data at/);
  assert.match(broken((s) => { s.services.proxy.volumes = []; }).join("\n"), /proxy: data at \/data/);
});

test("the API must run in production and trust exactly the proxy address", () => {
  assert.match(broken((s) => { s.services.api.environment.NODE_ENV = "development"; }).join("\n"), /NODE_ENV must be production/);
  assert.match(broken((s) => { s.services.api.environment.TRUSTED_PROXIES = "172.30.10.0/24"; }).join("\n"), /TRUSTED_PROXIES must be exactly the proxy address/);
  assert.match(broken((s) => { delete s.services.api.environment.TRUSTED_PROXIES; }).join("\n"), /TRUSTED_PROXIES/);
  assert.match(broken((s) => { s.services.proxy.networks.edge = null; }).join("\n"), /proxy: must have a fixed ipv4_address/);
});

test("the fixed proxy address must stay out of the dynamic pool of the edge network", () => {
  assert.match(broken((s) => { delete s.networks.edge.ipam; }).join("\n"), /edge must declare an ip_range/);
  assert.match(broken((s) => { s.networks.edge.ipam.config[0].ip_range = "172.30.10.0/25"; }).join("\n"), /leaves the proxy address 172.30.10.2 out/);
  assert.deepEqual(broken((s) => { s.networks.edge.ipam.config[0].ip_range = "172.30.10.4/30"; }), []);
});

test("a missing service fails", () => {
  assert.match(broken((s) => { delete s.services.db; }).join("\n"), /db: service is missing/);
});

const API_DOCKERFILE = `FROM node:24-alpine${PINNED} AS build\nRUN npm ci\nFROM node:24-alpine${PINNED}\nUSER node\nCMD ["node"]\n`;
const WEB_DOCKERFILE = `FROM node:24-alpine${PINNED} AS build\nFROM caddy:2-alpine${PINNED}\n`;

test("the built images are pinned and the API does not run as root", () => {
  assert.deepEqual(checkDockerfiles({ api: API_DOCKERFILE, web: WEB_DOCKERFILE }), []);
  assert.match(checkDockerfiles({ api: API_DOCKERFILE, web: "FROM caddy:2-alpine\n" }).join("\n"), /web .*caddy:2-alpine must be pinned/);
  assert.match(checkDockerfiles({ api: API_DOCKERFILE.replace(`node:24-alpine${PINNED} AS build`, "node:24-alpine AS build"), web: WEB_DOCKERFILE }).join("\n"), /api .*must be pinned/);
  assert.match(checkDockerfiles({ api: API_DOCKERFILE.replace("USER node\n", ""), web: WEB_DOCKERFILE }).join("\n"), /non-root USER/);
  assert.match(checkDockerfiles({ api: API_DOCKERFILE.replace("USER node", "USER root"), web: WEB_DOCKERFILE }).join("\n"), /non-root USER/);
  // A USER in the build stage does not count for the final one.
  const userOnlyInBuild = `FROM node:24-alpine${PINNED} AS build\nUSER node\nFROM node:24-alpine${PINNED}\nCMD ["node"]\n`;
  assert.match(checkDockerfiles({ api: userOnlyInBuild, web: WEB_DOCKERFILE }).join("\n"), /non-root USER/);
});
