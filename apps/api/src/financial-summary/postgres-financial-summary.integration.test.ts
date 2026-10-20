import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { Pool } from "pg";
import { createDatabase, runMigrations } from "../database.js";
import { PostgresFinancialSummaryRepository } from "./postgres-financial-summary.repository.js";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

test("PostgreSQL financial summary filters inclusive dates and subtracts contributions separately from expenses", {
  skip: !testDatabaseUrl,
}, async () => {
  const schemaName = `summary_test_${randomBytes(8).toString("hex")}`;
  const adminPool = new Pool({ connectionString: testDatabaseUrl });
  let scopedPool: Pool | undefined;
  try {
    await adminPool.query(`CREATE SCHEMA ${schemaName}`);
    scopedPool = new Pool({ connectionString: testDatabaseUrl, options: `-c search_path=${schemaName}` });
    const database = createDatabase(scopedPool);
    await runMigrations(database);
    const users = await database.query<{ id: string; email: string }>(
      `INSERT INTO users (email, password_hash, email_verified_at)
       VALUES ($1, 'test-hash', now()), ($2, 'test-hash', now()) RETURNING id, email`,
      [`summary-${schemaName}@example.com`, `other-${schemaName}@example.com`],
    );
    const userId = users.rows.find((row) => row.email === `summary-${schemaName}@example.com`)!.id;
    const otherUserId = users.rows.find((row) => row.email === `other-${schemaName}@example.com`)!.id;
    const repository = new PostgresFinancialSummaryRepository(database);

    const categories = await database.query<{ id: string; name: string; user_id: string }>(
      `INSERT INTO categories (user_id, name, nature)
       VALUES ($1, 'Within start', 'income'), ($1, 'Within end', 'income'), ($1, 'Outside', 'income'),
              ($2, 'Other user', 'income'), ($1, 'Market', 'expense'), ($2, 'Other market', 'expense'),
              ($1, 'Goal', 'investment')
       RETURNING id, name, user_id`,
      [userId, otherUserId],
    );
    const categoryId = (name: string, owner: string) => categories.rows.find((row) => row.name === name && row.user_id === owner)!.id;

    await database.query(
      `INSERT INTO incomes (user_id, category_id, amount, date)
       VALUES ($1, $3, '10.20', '2026-10-01'), ($1, $4, '490.00', '2026-10-31'),
              ($1, $5, '999.00', '2026-11-01'), ($2, $6, '777.00', '2026-10-15')`,
      [userId, otherUserId, categoryId("Within start", userId), categoryId("Within end", userId), categoryId("Outside", userId), categoryId("Other user", otherUserId)],
    );
    await database.query(
      `INSERT INTO expenses (user_id, category_id, amount, date)
       VALUES ($1, $2, '75.10', '2026-10-15'), ($1, $2, '25.00', '2026-09-30'), ($3, $4, '800.00', '2026-10-15')`,
      [userId, categoryId("Market", userId), otherUserId, categoryId("Other market", otherUserId)],
    );
    const goal = await database.query<{ id: string }>(
      "INSERT INTO investment_goals (user_id, title, description, target_amount) VALUES ($1, 'Goal', 'Goal', 100) RETURNING id",
      [userId],
    );
    const otherGoal = await database.query<{ id: string }>(
      "INSERT INTO investment_goals (user_id, title, description, target_amount) VALUES ($1, 'Other Goal', 'Goal', 100) RETURNING id",
      [otherUserId],
    );
    await database.query(
      `INSERT INTO investment_contributions (user_id, goal_id, amount, date)
       VALUES ($1, $2, '100.05', '2026-10-15'), ($1, $2, '300.00', '2026-11-01'), ($3, $4, '900.00', '2026-10-15')`,
      [userId, goal.rows[0]!.id, otherUserId, otherGoal.rows[0]!.id],
    );

    const summary = await repository.getSummary(userId, "2026-10-01", "2026-10-31");
    assert.equal(summary.incomeTotal, "500.20");
    assert.equal(summary.expenseTotal, "75.10");
    assert.equal(summary.contributionTotal, "100.05");
    assert.equal(summary.availableBalance, "325.05");
    const empty = await repository.getSummary(otherUserId, "2026-12-01", "2026-12-31");
    assert.equal(empty.incomeTotal, "0.00");
    assert.equal(empty.expenseTotal, "0.00");
    assert.equal(empty.contributionTotal, "0.00");
    assert.equal(empty.availableBalance, "0.00");
  } finally {
    await scopedPool?.end();
    await adminPool.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
    await adminPool.end();
  }
});
