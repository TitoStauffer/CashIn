// Runs the compiled API (apps/api/dist) with its telemetry pointed at the observability stack, and drives
// real traffic through it, so dashboard-check.mjs can prove every dashboard query has data (DEV-136).
//
// Started by dashboard-check.mjs inside a container on the saldocerto-observability network, as
//   node --import /app/dist/instrumentation.js /probe/drive-api.mjs
// so the instrumentation is loaded before the API, exactly as `npm start` does.
import { createRequire } from "node:module";
import { createApp } from "/app/dist/app.js";
import { createDatabase } from "/app/dist/database.js";
import { OpenTelemetryFinancialImportMetrics } from "/app/dist/business-metrics.js";

// pg is resolved from the API package, like the API itself does; this file lives outside it.
const pg = createRequire("/app/package.json")("pg");

const ROUNDS = Number(process.env.DRIVE_ROUNDS ?? 10);
const ROUND_DELAY_MS = 2500;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
const app = createApp(createDatabase(pool), { logger: true });
// A route that fails, so the 5xx panel has a numerator. Only in this probe, never in the API.
app.get("/probe/failure", async () => { throw new Error("probe failure"); });
await app.listen({ port: 3000, host: "127.0.0.1" });
const base = "http://127.0.0.1:3000";

// The import metrics come from the real adapter the API wires into FinancialImportsService (DEV-135).
const imports = new OpenTelemetryFinancialImportMetrics();

for (let round = 1; round <= ROUNDS; round += 1) {
  await fetch(`${base}/health`); // a database query inside a request: pool metrics
  await fetch(`${base}/probe/failure`); // 500
  await fetch(`${base}/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "probe@example.test", password: "not-a-real-password" }),
  }); // 401 or 400, either way a request on a real route
  imports.importConfirmed({ format: "csv", kind: "bank_statement", imported: 20 + round, skippedDuplicate: 2, rejectedInvalid: 1 });
  imports.importUndone({ format: "csv", kind: "bank_statement" });
  imports.importFailed({ format: "ofx", kind: "credit_card_statement" });
  console.log(`round ${round}/${ROUNDS} done`);
  await sleep(ROUND_DELAY_MS);
}

await app.close();
await pool.end();
// SIGTERM makes instrumentation.js shut the SDK down, which flushes the last metrics, logs and spans.
process.kill(process.pid, "SIGTERM");
