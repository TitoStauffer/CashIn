import { Pool } from "pg";
import { createApp } from "./app.js";
import { createDatabase, runMigrations } from "./database.js";
import { createEmailSenderFromEnvironment } from "./auth/email-sender.js";

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error("DATABASE_URL must be configured");
}

const pool = new Pool({ connectionString: databaseUrl });
const database = createDatabase(pool);

function positiveIntegerFromEnvironment(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

const app = createApp(database, {
  logger: true,
  emailSender: createEmailSenderFromEnvironment(),
  authConfiguration: {
    webBaseUrl: process.env.WEB_BASE_URL ?? "http://localhost:5173",
    verificationTokenTtlHours: positiveIntegerFromEnvironment("EMAIL_VERIFICATION_TOKEN_TTL_HOURS", 24),
    sessionTtlDays: positiveIntegerFromEnvironment("AUTH_SESSION_TTL_DAYS", 7),
  },
  walletInvitationTokenTtlHours: positiveIntegerFromEnvironment("WALLET_INVITATION_TOKEN_TTL_HOURS", 168),
  secureCookies: process.env.NODE_ENV === "production",
});

const port = Number(process.env.PORT ?? 3000);

try {
  await runMigrations(database);
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
