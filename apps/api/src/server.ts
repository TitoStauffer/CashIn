import { Pool } from "pg";
import { createApp } from "./app.js";

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error("DATABASE_URL must be configured");
}

const pool = new Pool({ connectionString: databaseUrl });
const app = createApp(
  { query: (queryText) => pool.query(queryText) },
  { logger: true },
);

const port = Number(process.env.PORT ?? 3000);

try {
  await app.listen({ port, host: "0.0.0.0" });
} catch (error) {
  app.log.error(error);
  await pool.end();
  process.exitCode = 1;
}

const shutdown = async () => {
  await app.close();
  await pool.end();
};

process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
