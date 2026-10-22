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
    const walletRows = await database.query<{ owner_user_id: string; id: string }>(
      "SELECT owner_user_id, id FROM wallets WHERE owner_user_id = ANY($1::uuid[])", [[userId, otherUserId]],
    );
    const walletId = walletRows.rows.find((row) => row.owner_user_id === userId)!.id;
    const otherWalletId = walletRows.rows.find((row) => row.owner_user_id === otherUserId)!.id;
    const repository = new PostgresFinancialSummaryRepository(database);

    const categories = await database.query<{ id: string; name: string; user_id: string }>(
      `INSERT INTO categories (user_id, wallet_id, name, nature)
       VALUES ($1, $3, 'Within start', 'income'), ($1, $3, 'Within end', 'income'), ($1, $3, 'Outside', 'income'),
              ($2, $4, 'Other user', 'income'), ($1, $3, 'Market', 'expense'), ($2, $4, 'Other market', 'expense'),
              ($1, $3, 'Goal', 'investment')
       RETURNING id, name, user_id`,
      [userId, otherUserId, walletId, otherWalletId],
    );
    const categoryId = (name: string, owner: string) => categories.rows.find((row) => row.name === name && row.user_id === owner)!.id;

    await database.query(
      `INSERT INTO incomes (user_id, wallet_id, category_id, amount, date)
       VALUES ($1, $2, $5, '10.20', '2026-10-01'), ($1, $2, $5, '1.80', '2026-10-15'),
              ($1, $2, $6, '490.00', '2026-10-31'),
              ($1, $2, $7, '999.00', '2026-11-01'), ($3, $4, $8, '777.00', '2026-10-15')`,
      [userId, walletId, otherUserId, otherWalletId, categoryId("Within start", userId), categoryId("Within end", userId), categoryId("Outside", userId), categoryId("Other user", otherUserId)],
    );
    await database.query(
      `INSERT INTO incomes (user_id, wallet_id, category_id, amount, date, balance_type)
       VALUES ($1, $2, $3, '150.00', '2026-10-12', 'food_benefit'),
              ($1, $2, $3, '200.00', '2026-10-15', 'meal_benefit')`,
      [userId, walletId, categoryId("Within start", userId)],
    );
    await database.query(
      `INSERT INTO expenses (user_id, wallet_id, category_id, amount, date)
       VALUES ($1, $2, $5, '75.10', '2026-10-15'), ($1, $2, $5, '4.90', '2026-10-16'),
              ($1, $2, $5, '25.00', '2026-09-30'), ($3, $4, $6, '800.00', '2026-10-15')`,
      [userId, walletId, otherUserId, otherWalletId, categoryId("Market", userId), categoryId("Other market", otherUserId)],
    );
    await database.query(
      `INSERT INTO expenses (user_id, wallet_id, category_id, payment_method_nature, amount, date)
       SELECT $1, $2, $3, amounts.expected_nature, amounts.amount, '2026-10-17'
       FROM (VALUES ('food_benefit'::text, '20.00'::numeric),
                    ('meal_benefit', '35.00'::numeric),
                    ('credit_card', '50.00'::numeric)) AS amounts(expected_nature, amount)`,
      [userId, walletId, categoryId("Market", userId)],
    );
    const goal = await database.query<{ id: string }>(
      "INSERT INTO investment_goals (user_id, wallet_id, title, description, target_amount) VALUES ($1, $2, 'Goal', 'Goal', 100) RETURNING id",
      [userId, walletId],
    );
    const otherGoal = await database.query<{ id: string }>(
      "INSERT INTO investment_goals (user_id, wallet_id, title, description, target_amount) VALUES ($1, $2, 'Other Goal', 'Goal', 100) RETURNING id",
      [otherUserId, otherWalletId],
    );
    await database.query(
      `INSERT INTO investment_contributions (user_id, wallet_id, goal_id, amount, date)
       VALUES ($1, $2, $3, '100.05', '2026-10-15'), ($1, $2, $3, '300.00', '2026-11-01'), ($4, $5, $6, '900.00', '2026-10-15')`,
      [userId, walletId, goal.rows[0]!.id, otherUserId, otherWalletId, otherGoal.rows[0]!.id],
    );

    const summary = await repository.getSummary(walletId, "2026-10-01", "2026-10-31");
    assert.equal(summary.incomeTotal, "852.00");
    assert.equal(summary.expenseTotal, "185.00");
    assert.equal(summary.cashIncomeTotal, "502.00");
    assert.equal(summary.cashExpenseTotal, "80.00");
    assert.equal(summary.creditPurchaseTotal, "50.00");
    assert.equal(summary.cardPaymentTotal, "0.00");
    assert.equal(summary.contributionTotal, "100.05");
    assert.equal(summary.availableBalance, "321.95");
    assert.equal(summary.cashBalance, "321.95");
    assert.deepEqual(summary.benefitBalances, [
      { balanceType: "food_meal_benefit", amount: "295.00" },
      { balanceType: "home_office_benefit", amount: "0.00" },
    ]);
    assert.deepEqual(summary.incomeByCategory, [
      { categoryId: categoryId("Within end", userId), categoryName: "Within end", amount: "490.00" },
      { categoryId: categoryId("Within start", userId), categoryName: "Within start", amount: "362.00" },
    ]);
    assert.deepEqual(summary.expenseByCategory, [
      { categoryId: categoryId("Market", userId), categoryName: "Market", amount: "185.00" },
    ]);
    await database.query(
      "UPDATE expenses SET payment_method_nature = 'immediate' WHERE wallet_id = $1 AND amount = '20.00'::numeric",
      [walletId],
    );
    assert.equal((await repository.getSummary(walletId, "2026-10-01", "2026-10-31")).benefitBalances[0]?.amount, "315.00");
    const empty = await repository.getSummary(otherWalletId, "2026-12-01", "2026-12-31");
    assert.equal(empty.incomeTotal, "0.00");
    assert.equal(empty.expenseTotal, "0.00");
    assert.equal(empty.cashIncomeTotal, "0.00");
    assert.equal(empty.cashExpenseTotal, "0.00");
    assert.equal(empty.creditPurchaseTotal, "0.00");
    assert.equal(empty.cardPaymentTotal, "0.00");
    assert.equal(empty.contributionTotal, "0.00");
    assert.equal(empty.availableBalance, "0.00");
    assert.equal(empty.cashBalance, "0.00");
    assert.deepEqual(empty.benefitBalances, [
      { balanceType: "food_meal_benefit", amount: "0.00" },
      { balanceType: "home_office_benefit", amount: "0.00" },
    ]);
    assert.deepEqual(empty.incomeByCategory, []);
    assert.deepEqual(empty.expenseByCategory, []);
  } finally {
    await scopedPool?.end();
    await adminPool.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
    await adminPool.end();
  }
});

test("PostgreSQL summary preserves exact cents, benefit separation and wallet boundaries for dashboard components", {
  skip: !testDatabaseUrl,
}, async () => {
  const schemaName = `summary_components_test_${randomBytes(8).toString("hex")}`;
  const adminPool = new Pool({ connectionString: testDatabaseUrl });
  let scopedPool: Pool | undefined;
  try {
    await adminPool.query(`CREATE SCHEMA ${schemaName}`);
    scopedPool = new Pool({ connectionString: testDatabaseUrl, options: `-c search_path=${schemaName}` });
    const database = createDatabase(scopedPool);
    await runMigrations(database);
    const users = await database.query<{ id: string }>(
      "INSERT INTO users (email, password_hash, email_verified_at) VALUES ($1, 'test-hash', now()) RETURNING id",
      [`components-${schemaName}@example.com`],
    );
    const userId = users.rows[0]!.id;
    const wallets = await database.query<{ id: string; is_personal: boolean }>(
      `INSERT INTO wallets (owner_user_id, name) VALUES ($1, 'Other wallet') RETURNING id, is_personal`, [userId],
    );
    const otherWalletId = wallets.rows[0]!.id;
    const personal = await database.query<{ id: string }>(
      "SELECT id FROM wallets WHERE owner_user_id = $1 AND is_personal", [userId],
    );
    const walletId = personal.rows[0]!.id;
    const categories = await database.query<{ id: string; wallet_id: string; nature: string }>(
      `INSERT INTO categories (user_id, wallet_id, name, nature)
       SELECT $1, wallet.id, kind.name, kind.nature
       FROM wallets AS wallet
       CROSS JOIN (VALUES ('Salary', 'income'), ('Market', 'expense')) AS kind(name, nature)
       WHERE wallet.owner_user_id = $1 RETURNING id, wallet_id, nature`, [userId],
    );
    const categoryId = (wallet: string, nature: string) => categories.rows.find(
      (row) => row.wallet_id === wallet && row.nature === nature,
    )!.id;
    await database.query(
      `INSERT INTO incomes (user_id, wallet_id, category_id, amount, date, balance_type)
       VALUES ($1, $2, $3, '0.10', '2026-10-01', 'cash'),
              ($1, $2, $3, '0.20', '2026-10-31', 'cash'),
              ($1, $2, $3, '0.10', '2026-10-15', 'food_benefit'),
              ($1, $2, $3, '0.20', '2026-10-15', 'meal_benefit'),
              ($1, $2, $3, '0.30', '2026-10-15', 'food_meal_benefit'),
              ($1, $2, $3, '0.40', '2026-10-15', 'home_office_benefit'),
              ($1, $2, $3, '7.00', '2026-09-30', 'cash'),
              ($1, $2, $3, '8.00', '2026-11-01', 'cash'),
              ($1, $4, $5, '40.00', '2026-10-15', 'cash')`,
      [userId, walletId, categoryId(walletId, "income"), otherWalletId, categoryId(otherWalletId, "income")],
    );
    await database.query(
      `INSERT INTO expenses (user_id, wallet_id, category_id, amount, date, payment_method_nature)
       VALUES ($1, $2, $3, '0.10', '2026-10-01', NULL),
              ($1, $2, $3, '0.20', '2026-10-31', 'immediate'),
              ($1, $2, $3, '0.10', '2026-10-01', 'credit_card'),
              ($1, $2, $3, '0.20', '2026-10-31', 'credit_card'),
              ($1, $2, $3, '0.01', '2026-10-15', 'food_benefit'),
              ($1, $2, $3, '0.02', '2026-10-15', 'meal_benefit'),
              ($1, $2, $3, '0.03', '2026-10-15', 'food_meal_benefit'),
              ($1, $2, $3, '0.04', '2026-10-15', 'home_office_benefit'),
              ($1, $2, $3, '9.00', '2026-09-30', 'credit_card'),
              ($1, $2, $3, '10.00', '2026-11-01', 'credit_card'),
              ($1, $4, $5, '50.00', '2026-10-15', 'immediate'),
              ($1, $4, $5, '60.00', '2026-10-15', 'credit_card')`,
      [userId, walletId, categoryId(walletId, "expense"), otherWalletId, categoryId(otherWalletId, "expense")],
    );
    const cards = await database.query<{ id: string; wallet_id: string }>(
      `INSERT INTO credit_cards (wallet_id, alias, closing_day, due_day)
       SELECT id, 'Test card', 20, 1 FROM wallets WHERE owner_user_id = $1 RETURNING id, wallet_id`, [userId],
    );
    const cardId = (wallet: string) => cards.rows.find((row) => row.wallet_id === wallet)!.id;
    await database.query(
      `INSERT INTO credit_card_statements (wallet_id, credit_card_id, closing_date, due_date, paid_date, paid_amount)
       VALUES ($1, $2, '2026-09-20', '2026-10-01', '2026-10-01', '0.10'),
              ($1, $2, '2026-10-20', '2026-11-01', '2026-10-31', '0.20'),
              ($1, $2, '2026-08-20', '2026-09-01', '2026-09-30', '0.30'),
              ($1, $2, '2026-10-21', '2026-11-01', '2026-11-01', '0.40'),
              ($1, $2, '2026-12-20', '2027-01-01', NULL, NULL),
              ($3, $4, '2026-09-20', '2026-10-01', '2026-10-15', '70.00')`,
      [walletId, cardId(walletId), otherWalletId, cardId(otherWalletId)],
    );
    const repository = new PostgresFinancialSummaryRepository(database);
    const summary = await repository.getSummary(walletId, "2026-10-01", "2026-10-31");
    assert.equal(summary.incomeTotal, "1.30");
    assert.equal(summary.expenseTotal, "0.70");
    assert.equal(summary.cashIncomeTotal, "0.30");
    assert.equal(summary.cashExpenseTotal, "0.30");
    assert.equal(summary.creditPurchaseTotal, "0.30");
    assert.equal(summary.cardPaymentTotal, "0.30");
    assert.equal(summary.cashBalance, "-0.30");
    assert.equal(summary.availableBalance, "-0.30");
    assert.deepEqual(summary.benefitBalances, [
      { balanceType: "food_meal_benefit", amount: "0.54" },
      { balanceType: "home_office_benefit", amount: "0.36" },
    ]);
    const otherSummary = await repository.getSummary(otherWalletId, "2026-10-01", "2026-10-31");
    assert.equal(otherSummary.cashIncomeTotal, "40.00");
    assert.equal(otherSummary.cashExpenseTotal, "50.00");
    assert.equal(otherSummary.creditPurchaseTotal, "60.00");
    assert.equal(otherSummary.cardPaymentTotal, "70.00");
    assert.equal(otherSummary.cashBalance, "-80.00");
    const firstDay = await repository.getSummary(walletId, "2026-10-01", "2026-10-01");
    assert.equal(firstDay.cashIncomeTotal, "0.10");
    assert.equal(firstDay.cashExpenseTotal, "0.10");
    assert.equal(firstDay.creditPurchaseTotal, "0.10");
    assert.equal(firstDay.cardPaymentTotal, "0.10");
    const fromOnly = await repository.getSummary(walletId, "2026-11-01");
    assert.equal(fromOnly.cashIncomeTotal, "8.00");
    assert.equal(fromOnly.creditPurchaseTotal, "10.00");
    assert.equal(fromOnly.cardPaymentTotal, "0.40");
    const toOnly = await repository.getSummary(walletId, undefined, "2026-09-30");
    assert.equal(toOnly.cashIncomeTotal, "7.00");
    assert.equal(toOnly.creditPurchaseTotal, "9.00");
    assert.equal(toOnly.cardPaymentTotal, "0.30");
  } finally {
    await scopedPool?.end();
    await adminPool.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
    await adminPool.end();
  }
});
