import { randomBytes } from "node:crypto";
import test from "node:test";
import { Pool } from "pg";
import { createApp } from "../app.js";
import { PostgresAuthRepository } from "../auth/postgres-auth.repository.js";
import { createOpaqueToken, hashToken } from "../auth/token.js";
import { createDatabase, runMigrations } from "../database.js";
import { PostgresFinancialImportsRepository } from "./postgres-financial-imports.repository.js";

// DEV-108: the PostgreSQL financial import suite was one `test` of 1,231 lines, the last file above the
// 40 KB module-size guard. This fixture holds the lifecycle every phase needs — a throwaway schema with the
// official migrations, two users with their wallets, a membership, two categories, a session and an app —
// so each phase can be its own `test` in its own file. The setup below is the one the monolithic test ran,
// moved here unchanged; the phases keep their assertions as they were.

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

export type FinancialImportScenario = {
  database: ReturnType<typeof createDatabase>;
  scopedPool: Pool;
  repository: PostgresFinancialImportsRepository;
  userId: string;
  otherUserId: string;
  walletId: string;
  otherWalletId: string;
  categories: { rows: Array<{ id: string; nature: "income" | "expense" }> };
  incomeCategoryId: string;
  expenseCategoryId: string;
  authenticatedHeaders: { cookie: string; "x-wallet-id": string };
  csvConfiguration: {
    delimiter: ";";
    encoding: "utf-8";
    hasHeader: true;
    dateFormat: "dd/MM/yyyy";
    numberFormat: "pt-BR";
    columns: { date: number; description: number; amount: number; credit: null; debit: null; externalId: null };
  };
  csvMappingHeader: string;
  /**
   * The app that teardown closes. A phase that replaces the app — to inject a stub parser — assigns the new
   * one here after `ready()`, so the app that is current when the phase ends is the one that gets closed.
   */
  app: ReturnType<typeof createApp>;
};

/** Registers one PostgreSQL integration phase, skipped without `TEST_DATABASE_URL`, on a fresh schema. */
export function financialImportScenarioTest(name: string, body: (scenario: FinancialImportScenario) => Promise<void>): void {
  test(name, { skip: !testDatabaseUrl }, async () => {
    const schemaName = `financial_import_${randomBytes(8).toString("hex")}`;
    const adminPool = new Pool({ connectionString: testDatabaseUrl });
    let scopedPool: Pool | undefined;
    let scenario: FinancialImportScenario | undefined;

    try {
      await adminPool.query(`CREATE SCHEMA ${schemaName}`);
      scopedPool = new Pool({
        connectionString: testDatabaseUrl,
        options: `-c search_path=${schemaName}`,
      });
      const database = createDatabase(scopedPool);
      await runMigrations(database);
      const repository = new PostgresFinancialImportsRepository(database);

      const users = await database.query<{ id: string; email: string }>(
        `INSERT INTO users (email, password_hash, email_verified_at)
         VALUES ($1, 'test-hash', now()), ($2, 'test-hash', now())
         RETURNING id, email`,
        [`import-${schemaName}@example.com`, `other-${schemaName}@example.com`],
      );
      const userId = users.rows.find((row) => row.email.startsWith("import-"))!.id;
      const otherUserId = users.rows.find((row) => row.email.startsWith("other-"))!.id;
      const wallets = await database.query<{ id: string; owner_user_id: string }>(
        "SELECT id, owner_user_id FROM wallets WHERE owner_user_id = ANY($1::uuid[])",
        [[userId, otherUserId]],
      );
      const walletId = wallets.rows.find((row) => row.owner_user_id === userId)!.id;
      const otherWalletId = wallets.rows.find((row) => row.owner_user_id === otherUserId)!.id;
      await database.query(
        "INSERT INTO wallet_members (wallet_id, user_id, role) VALUES ($1, $2, 'member')",
        [walletId, otherUserId],
      );
      const categories = await database.query<{ id: string; nature: "income" | "expense" }>(
        `INSERT INTO categories (user_id, wallet_id, name, nature)
         VALUES ($1, $2, 'Salário', 'income'), ($1, $2, 'Alimentação', 'expense')
         RETURNING id, nature`,
        [userId, walletId],
      );
      const incomeCategoryId = categories.rows.find((row) => row.nature === "income")!.id;
      const expenseCategoryId = categories.rows.find((row) => row.nature === "expense")!.id;
      const sessionToken = createOpaqueToken();
      await new PostgresAuthRepository(database).createSession(
        userId,
        hashToken(sessionToken),
        new Date(Date.now() + 60_000),
      );
      const app = createApp(database, { financialImportRepository: repository });
      await app.ready();
      const authenticatedHeaders = {
        cookie: `cashin_session=${sessionToken}`,
        "x-wallet-id": walletId,
      };

      const csvConfiguration = {
        delimiter: ";" as const,
        encoding: "utf-8" as const,
        hasHeader: true as const,
        dateFormat: "dd/MM/yyyy" as const,
        numberFormat: "pt-BR" as const,
        columns: { date: 0, description: 1, amount: 2, credit: null, debit: null, externalId: null },
      };
      const csvMappingHeader = encodeURIComponent(JSON.stringify(csvConfiguration));

      scenario = {
        database, scopedPool, repository, userId, otherUserId, walletId, otherWalletId, categories,
        incomeCategoryId, expenseCategoryId, authenticatedHeaders, csvConfiguration, csvMappingHeader, app,
      };
      await body(scenario);
    } finally {
      await scenario?.app.close();
      await scopedPool?.end();
      await adminPool.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
      await adminPool.end();
    }
  });
}
