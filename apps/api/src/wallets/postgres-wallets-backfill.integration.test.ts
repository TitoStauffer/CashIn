import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { createDatabase } from "../database.js";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

test("migration 007 backfills existing financial records into each user's personal wallet without changing data or links", {
  skip: !testDatabaseUrl,
}, async () => {
  const schemaName = `wallet_backfill_${randomBytes(8).toString("hex")}`;
  const adminPool = new Pool({ connectionString: testDatabaseUrl });
  let scopedPool: Pool | undefined;

  try {
    await adminPool.query(`CREATE SCHEMA ${schemaName}`);
    scopedPool = new Pool({ connectionString: testDatabaseUrl, options: `-c search_path=${schemaName}` });
    const database = createDatabase(scopedPool);
    await database.query(`
      CREATE TABLE schema_migrations (
        version text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    const migrationDirectory = fileURLToPath(new URL("../../migrations/", import.meta.url));
    for (const version of [
      "001_auth.sql",
      "002_categories.sql",
      "003_incomes.sql",
      "004_expenses.sql",
      "005_investment_goals.sql",
      "006_financial_precision_and_name_uniqueness.sql",
    ]) {
      const sql = await readFile(join(migrationDirectory, version), "utf8");
      await database.transaction(async (transaction) => {
        await transaction.query("SELECT pg_advisory_xact_lock(6052252091476)");
        await transaction.query(sql);
        await transaction.query("INSERT INTO schema_migrations (version) VALUES ($1)", [version]);
      });
    }

    const users = [
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    ];
    const records = users.map((userId, index) => {
      const suffix = index === 0 ? "1111" : "2222";
      return {
        userId,
        incomeCategoryId: `10000000-0000-4000-8000-${suffix}00000001`,
        expenseCategoryId: `20000000-0000-4000-8000-${suffix}00000001`,
        investmentCategoryId: `30000000-0000-4000-8000-${suffix}00000001`,
        subcategoryId: `40000000-0000-4000-8000-${suffix}00000001`,
        incomeId: `50000000-0000-4000-8000-${suffix}00000001`,
        expenseId: `60000000-0000-4000-8000-${suffix}00000001`,
        goalId: `70000000-0000-4000-8000-${suffix}00000001`,
        contributionId: `80000000-0000-4000-8000-${suffix}00000001`,
      };
    });

    for (const [index, record] of records.entries()) {
      const email = `wallet-backfill-${index}-${schemaName}@example.com`;
      await database.query("INSERT INTO users (id, email, password_hash, email_verified_at) VALUES ($1, $2, 'test-hash', now())", [record.userId, email]);
      await database.query(
        `INSERT INTO categories (id, user_id, name, nature) VALUES
         ($1, $4, 'Salary', 'income'), ($2, $4, 'Housing', 'expense'), ($3, $4, 'Car', 'investment')`,
        [record.incomeCategoryId, record.expenseCategoryId, record.investmentCategoryId, record.userId],
      );
      await database.query(
        "INSERT INTO subcategories (id, user_id, category_id, name) VALUES ($1, $2, $3, 'Monthly')",
        [record.subcategoryId, record.userId, record.investmentCategoryId],
      );
      await database.query(
        `INSERT INTO incomes (id, user_id, category_id, amount, date, description)
         VALUES ($1, $2, $3, 1234.56, '2026-01-15', 'Salary')`,
        [record.incomeId, record.userId, record.incomeCategoryId],
      );
      await database.query(
        `INSERT INTO expenses (id, user_id, category_id, amount, date, description)
         VALUES ($1, $2, $3, 234.56, '2026-01-16', 'Housing')`,
        [record.expenseId, record.userId, record.expenseCategoryId],
      );
      await database.query(
        `INSERT INTO investment_goals (id, user_id, title, description, target_amount, category_id, subcategory_id)
         VALUES ($1, $2, 'New car', 'Savings goal', 120000.00, $3, $4)`,
        [record.goalId, record.userId, record.investmentCategoryId, record.subcategoryId],
      );
      await database.query(
        `INSERT INTO investment_contributions (id, user_id, goal_id, amount, date, description)
         VALUES ($1, $2, $3, 15000.25, '2026-01-17', 'Monthly contribution')`,
        [record.contributionId, record.userId, record.goalId],
      );
    }

    const migration007 = await readFile(join(migrationDirectory, "007_wallets.sql"), "utf8");
    await database.transaction(async (transaction) => {
      await transaction.query("SELECT pg_advisory_xact_lock(6052252091476)");
      await transaction.query(migration007);
      await transaction.query("INSERT INTO schema_migrations (version) VALUES ('007_wallets.sql')");
    });

    const walletRows = await database.query<{ id: string; owner_user_id: string; is_personal: boolean }>(
      "SELECT id, owner_user_id, is_personal FROM wallets WHERE owner_user_id = ANY($1::uuid[])",
      [users],
    );
    assert.equal(walletRows.rows.length, 2);
    const walletByUser = new Map(walletRows.rows.map((wallet) => [wallet.owner_user_id, wallet]));
    for (const record of records) {
      const wallet = walletByUser.get(record.userId);
      assert.ok(wallet?.is_personal);
      const persisted = await database.query<{
        income_id: string; expense_id: string; goal_id: string; contribution_id: string;
        income_wallet: string; income_amount: string;
        expense_wallet: string; expense_amount: string;
        category_wallet: string; subcategory_wallet: string;
        goal_wallet: string; contribution_wallet: string;
        goal_category: string; goal_subcategory: string; contribution_goal: string;
      }>(
        `SELECT income.id AS income_id, expense.id AS expense_id,
                goal.id AS goal_id, contribution.id AS contribution_id,
                income.wallet_id AS income_wallet, income.amount::text AS income_amount,
                expense.wallet_id AS expense_wallet, expense.amount::text AS expense_amount,
                investment_category.wallet_id AS category_wallet,
                subcategory.wallet_id AS subcategory_wallet,
                goal.wallet_id AS goal_wallet, contribution.wallet_id AS contribution_wallet,
                goal.category_id AS goal_category, goal.subcategory_id AS goal_subcategory,
                contribution.goal_id AS contribution_goal
         FROM incomes AS income
         JOIN expenses AS expense ON expense.user_id = income.user_id
         JOIN categories AS investment_category ON investment_category.id = $3
         JOIN subcategories AS subcategory ON subcategory.id = $4
         JOIN investment_goals AS goal ON goal.id = $5
         JOIN investment_contributions AS contribution ON contribution.id = $6
         WHERE income.id = $1 AND expense.id = $2`,
        [record.incomeId, record.expenseId, record.investmentCategoryId, record.subcategoryId, record.goalId, record.contributionId],
      );
      assert.equal(persisted.rows.length, 1);
      const row = persisted.rows[0]!;
      assert.equal(row.income_id, record.incomeId);
      assert.equal(row.expense_id, record.expenseId);
      assert.equal(row.goal_id, record.goalId);
      assert.equal(row.contribution_id, record.contributionId);
      assert.equal(row.income_wallet, wallet!.id);
      assert.equal(row.expense_wallet, wallet!.id);
      assert.equal(row.category_wallet, wallet!.id);
      assert.equal(row.subcategory_wallet, wallet!.id);
      assert.equal(row.goal_wallet, wallet!.id);
      assert.equal(row.contribution_wallet, wallet!.id);
      assert.equal(row.income_amount, "1234.56");
      assert.equal(row.expense_amount, "234.56");
      assert.equal(row.goal_category, record.investmentCategoryId);
      assert.equal(row.goal_subcategory, record.subcategoryId);
      assert.equal(row.contribution_goal, record.goalId);
    }
  } finally {
    await scopedPool?.end();
    await adminPool.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
    await adminPool.end();
  }
});
