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
    assert.deepEqual(summary.contributionsByGoal, [{ goalId: goal.rows[0]!.id, amount: "100.05" }]);
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
    assert.deepEqual(empty.contributionsByGoal, []);
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
    const statements = await database.query<{ id: string; closing_date: string; wallet_id: string }>(
      `INSERT INTO credit_card_statements (wallet_id, credit_card_id, closing_date, due_date, paid_date)
       VALUES ($1, $2, '2026-09-20', '2026-10-01', '2026-10-01'),
              ($1, $2, '2026-10-20', '2026-11-01', '2026-10-31'),
              ($1, $2, '2026-08-20', '2026-09-01', '2026-09-30'),
              ($1, $2, '2026-10-21', '2026-11-01', '2026-11-01'),
              ($1, $2, '2026-12-20', '2027-01-01', NULL),
              ($3, $4, '2026-09-20', '2026-10-01', '2026-10-15')
       RETURNING id, closing_date::text AS closing_date, wallet_id`,
      [walletId, cardId(walletId), otherWalletId, cardId(otherWalletId)],
    );
    const statementId = (wallet: string, closingDate: string) =>
      statements.rows.find((row) => row.wallet_id === wallet && row.closing_date === closingDate)!.id;
    await database.query(
      `INSERT INTO credit_card_statement_payments (wallet_id, user_id, credit_card_statement_id, amount, date)
       VALUES ($1, $3, $4, '0.10', '2026-10-01'),
              ($1, $3, $5, '0.20', '2026-10-31'),
              ($1, $3, $6, '0.30', '2026-09-30'),
              ($1, $3, $7, '0.40', '2026-11-01'),
              ($2, $3, $8, '70.00', '2026-10-15')`,
      [
        walletId, otherWalletId, userId,
        statementId(walletId, "2026-09-20"),
        statementId(walletId, "2026-10-20"),
        statementId(walletId, "2026-08-20"),
        statementId(walletId, "2026-10-21"),
        statementId(otherWalletId, "2026-09-20"),
      ],
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

test("PostgreSQL summary groups contributions by goal with exact cents and inclusive wallet-scoped periods", {
  skip: !testDatabaseUrl,
}, async () => {
  const schemaName = `summary_goals_test_${randomBytes(8).toString("hex")}`;
  const adminPool = new Pool({ connectionString: testDatabaseUrl });
  let scopedPool: Pool | undefined;
  try {
    await adminPool.query(`CREATE SCHEMA ${schemaName}`);
    scopedPool = new Pool({ connectionString: testDatabaseUrl, options: `-c search_path=${schemaName}` });
    const database = createDatabase(scopedPool);
    await runMigrations(database);
    const users = await database.query<{ id: string }>(
      "INSERT INTO users (email, password_hash, email_verified_at) VALUES ($1, 'test-hash', now()) RETURNING id",
      [`goal-summary-${schemaName}@example.com`],
    );
    const userId = users.rows[0]!.id;
    const personal = await database.query<{ id: string }>(
      "SELECT id FROM wallets WHERE owner_user_id = $1 AND is_personal", [userId],
    );
    const walletId = personal.rows[0]!.id;
    const otherWallet = await database.query<{ id: string }>(
      "INSERT INTO wallets (owner_user_id, name) VALUES ($1, 'Other wallet') RETURNING id", [userId],
    );
    const otherWalletId = otherWallet.rows[0]!.id;
    const goals = await database.query<{ id: string; title: string }>(
      `INSERT INTO investment_goals (user_id, wallet_id, title, target_amount, closed_at)
       VALUES ($1, $2, 'Cents', 100, NULL), ($1, $2, 'Closed', 100, now()),
              ($1, $2, 'Outside period', 100, NULL), ($1, $2, 'No contributions', 100, NULL),
              ($1, $3, 'Other wallet goal', 100, NULL) RETURNING id, title`,
      [userId, walletId, otherWalletId],
    );
    const goalId = (title: string) => goals.rows.find((row) => row.title === title)!.id;
    await database.query(
      `INSERT INTO investment_contributions (user_id, wallet_id, goal_id, amount, date)
       VALUES ($1, $2, $3, '0.10', '2026-10-01'), ($1, $2, $3, '0.20', '2026-10-31'),
              ($1, $2, $3, '9.00', '2026-09-30'), ($1, $2, $3, '10', '2026-11-01'),
              ($1, $2, $4, '0.40', '2026-10-15'), ($1, $2, $5, '20', '2026-11-01'),
              ($1, $6, $7, '900.00', '2026-10-15')`,
      [userId, walletId, goalId("Cents"), goalId("Closed"), goalId("Outside period"), otherWalletId, goalId("Other wallet goal")],
    );
    const repository = new PostgresFinancialSummaryRepository(database);
    const byGoalId = (left: { goalId: string }, right: { goalId: string }) => left.goalId.localeCompare(right.goalId);
    const summary = await repository.getSummary(walletId, "2026-10-01", "2026-10-31");
    assert.deepEqual(summary.contributionsByGoal, [
      { goalId: goalId("Cents"), amount: "0.30" },
      { goalId: goalId("Closed"), amount: "0.40" },
    ].sort(byGoalId));
    assert.equal(summary.contributionTotal, "0.70");
    assert.equal(summary.cashBalance, "-0.70");
    assert.equal(summary.availableBalance, "-0.70");
    const firstDay = await repository.getSummary(walletId, "2026-10-01", "2026-10-01");
    assert.deepEqual(firstDay.contributionsByGoal, [{ goalId: goalId("Cents"), amount: "0.10" }]);
    const lastDay = await repository.getSummary(walletId, "2026-10-31", "2026-10-31");
    assert.deepEqual(lastDay.contributionsByGoal, [{ goalId: goalId("Cents"), amount: "0.20" }]);
    const fromOnly = await repository.getSummary(walletId, "2026-11-01");
    assert.deepEqual(fromOnly.contributionsByGoal, [
      { goalId: goalId("Cents"), amount: "10.00" },
      { goalId: goalId("Outside period"), amount: "20.00" },
    ].sort(byGoalId));
    assert.equal(fromOnly.contributionTotal, "30");
    const toOnly = await repository.getSummary(walletId, undefined, "2026-09-30");
    assert.deepEqual(toOnly.contributionsByGoal, [{ goalId: goalId("Cents"), amount: "9.00" }]);
    const allTime = await repository.getSummary(walletId);
    assert.deepEqual(allTime.contributionsByGoal, [
      { goalId: goalId("Cents"), amount: "19.30" },
      { goalId: goalId("Closed"), amount: "0.40" },
      { goalId: goalId("Outside period"), amount: "20.00" },
    ].sort(byGoalId));
    assert.equal(allTime.contributionTotal, "39.70");
    const otherSummary = await repository.getSummary(otherWalletId, "2026-10-01", "2026-10-31");
    assert.deepEqual(otherSummary.contributionsByGoal, [{ goalId: goalId("Other wallet goal"), amount: "900.00" }]);
    assert.equal(otherSummary.contributionTotal, "900.00");
    const empty = await repository.getSummary(walletId, "2026-11-02", "2026-11-30");
    assert.deepEqual(empty.contributionsByGoal, []);
    assert.equal(empty.contributionTotal, "0.00");
  } finally {
    await scopedPool?.end();
    await adminPool.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
    await adminPool.end();
  }
});


// A refund gives the money back, so the purchase it reverses stops being a cost — in the totals and
// in the category of that purchase. The credit belongs to the period of its own date, which is what
// makes a refund of an older purchase able to push a period below zero.
test("PostgreSQL summary subtracts statement credits from expense totals and from the reversed purchase's category", {
  skip: !testDatabaseUrl,
}, async () => {
  const schemaName = `summary_credits_${randomBytes(8).toString("hex")}`;
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
      [`credits-${schemaName}@example.com`, `other-${schemaName}@example.com`],
    );
    const userId = users.rows.find((row) => row.email.startsWith("credits-"))!.id;
    const otherUserId = users.rows.find((row) => row.email.startsWith("other-"))!.id;
    const wallets = await database.query<{ owner_user_id: string; id: string }>(
      "SELECT owner_user_id, id FROM wallets WHERE owner_user_id = ANY($1::uuid[])",
      [[userId, otherUserId]],
    );
    const walletId = wallets.rows.find((row) => row.owner_user_id === userId)!.id;
    const otherWalletId = wallets.rows.find((row) => row.owner_user_id === otherUserId)!.id;
    const repository = new PostgresFinancialSummaryRepository(database);

    const categories = await database.query<{ id: string; name: string; wallet_id: string }>(
      `INSERT INTO categories (user_id, wallet_id, name, nature)
       VALUES ($1, $3, 'Eletrônicos', 'expense'), ($1, $3, 'Mercado', 'expense'), ($1, $3, 'Viagem', 'expense'),
              ($2, $4, 'Outra carteira', 'expense')
       RETURNING id, name, wallet_id`,
      [userId, otherUserId, walletId, otherWalletId],
    );
    const categoryId = (name: string) => categories.rows.find((row) => row.name === name)!.id;

    const cards = await database.query<{ id: string; wallet_id: string }>(
      `INSERT INTO credit_cards (wallet_id, alias, closing_day, due_day)
       VALUES ($1, 'Cartão', 10, 20), ($2, 'Cartão da outra', 10, 20)
       RETURNING id, wallet_id`,
      [walletId, otherWalletId],
    );
    const cardId = cards.rows.find((row) => row.wallet_id === walletId)!.id;
    const otherCardId = cards.rows.find((row) => row.wallet_id === otherWalletId)!.id;
    const statements = await database.query<{ id: string; wallet_id: string }>(
      `INSERT INTO credit_card_statements (wallet_id, credit_card_id, closing_date, due_date)
       VALUES ($1, $3, '2026-10-10', '2026-10-20'), ($2, $4, '2026-10-10', '2026-10-20')
       RETURNING id, wallet_id`,
      [walletId, otherWalletId, cardId, otherCardId],
    );
    const statementId = statements.rows.find((row) => row.wallet_id === walletId)!.id;
    const otherStatementId = statements.rows.find((row) => row.wallet_id === otherWalletId)!.id;

    // Three purchases in October and one in September, which is the one a later refund reverses.
    const purchases = await database.query<{ id: string; description: string }>(
      `INSERT INTO expenses (user_id, wallet_id, category_id, amount, date, payment_method_nature, description)
       VALUES ($1, $2, $3, '30.00', '2026-10-05', 'credit_card', 'fone'),
              ($1, $2, $4, '80.00', '2026-10-06', 'credit_card', 'compra do mes'),
              ($1, $2, $5, '500.00', '2026-09-20', 'credit_card', 'passagem'),
              ($1, $2, $4, '12.34', '2026-10-07', 'immediate', 'pao')
       RETURNING id, description`,
      [userId, walletId, categoryId("Eletrônicos"), categoryId("Mercado"), categoryId("Viagem")],
    );
    const purchaseId = (description: string) => purchases.rows.find((row) => row.description === description)!.id;
    const otherPurchase = await database.query<{ id: string }>(
      `INSERT INTO expenses (user_id, wallet_id, category_id, amount, date, payment_method_nature)
       VALUES ($1, $2, $3, '70.00', '2026-10-05', 'credit_card') RETURNING id`,
      [otherUserId, otherWalletId, categoryId("Outra carteira")],
    );

    await database.query(
      `INSERT INTO credit_card_statement_credits (wallet_id, user_id, credit_card_statement_id, original_expense_id, amount, date, description)
       VALUES ($1, $2, $3, $4, '30.00', '2026-10-15', 'estorno integral'),
              ($1, $2, $3, $5, '20.00', '2026-10-16', 'estorno parcial'),
              ($1, $2, $3, NULL, '7.77', '2026-10-17', 'credito sem compra')`,
      [walletId, userId, statementId, purchaseId("fone"), purchaseId("compra do mes")],
    );
    // The September purchase is refunded in October: the credit belongs to October even though the
    // money was spent in September.
    await database.query(
      `INSERT INTO credit_card_statement_credits (wallet_id, user_id, credit_card_statement_id, original_expense_id, amount, date, description)
       VALUES ($1, $2, $3, $4, '500.00', '2026-10-18', 'estorno de compra anterior')`,
      [walletId, userId, statementId, purchaseId("passagem")],
    );
    await database.query(
      `INSERT INTO credit_card_statement_credits (wallet_id, user_id, credit_card_statement_id, original_expense_id, amount, date)
       VALUES ($1, $2, $3, $4, '70.00', '2026-10-19')`,
      [otherWalletId, otherUserId, otherStatementId, otherPurchase.rows[0]!.id],
    );

    const october = await repository.getSummary(walletId, "2026-10-01", "2026-10-31");

    // Purchases in October: 30 + 80 + 12.34 immediate = 122.34. Credits in October: 30 + 20 + 7.77 + 500 = 557.77.
    assert.equal(october.cardCreditTotal, "557.77");
    assert.equal(october.unlinkedCardCreditTotal, "7.77");
    assert.equal(october.expenseTotal, "-435.43");
    // Credit purchases in October are 110.00, and every credit of the period is subtracted from them.
    assert.equal(october.creditPurchaseTotal, "-447.77");
    // The immediate expense and the cash balance are untouched: a statement credit is neither.
    assert.equal(october.cashExpenseTotal, "12.34");
    assert.equal(october.cashBalance, "-12.34");
    // A credit is never income.
    assert.equal(october.incomeTotal, "0.00");
    assert.deepEqual(october.incomeByCategory, []);

    const byName = (name: string) => october.expenseByCategory.find((item) => item.categoryName === name);
    // Fully refunded: the category stays in the list at zero, because it did have movement.
    assert.deepEqual(byName("Eletrônicos"), { categoryId: categoryId("Eletrônicos"), categoryName: "Eletrônicos", amount: "0.00" });
    // Partially refunded, plus the immediate purchase in the same category: 80 + 12.34 - 20.
    assert.deepEqual(byName("Mercado"), { categoryId: categoryId("Mercado"), categoryName: "Mercado", amount: "72.34" });
    // The refund of a September purchase lands in October, so October's category is negative.
    assert.deepEqual(byName("Viagem"), { categoryId: categoryId("Viagem"), categoryName: "Viagem", amount: "-500.00" });
    // The credit with no known purchase lowers no category at all.
    assert.equal(october.expenseByCategory.length, 3);

    // September keeps the purchase at its full value: the refund is not retroactive.
    const september = await repository.getSummary(walletId, "2026-09-01", "2026-09-30");
    assert.equal(september.expenseTotal, "500.00");
    assert.equal(september.creditPurchaseTotal, "500.00");
    assert.equal(september.cardCreditTotal, "0.00");
    assert.deepEqual(september.expenseByCategory, [
      { categoryId: categoryId("Viagem"), categoryName: "Viagem", amount: "500.00" },
    ]);

    // Over the whole history the refunded purchases net out and only what was kept remains.
    const allTime = await repository.getSummary(walletId);
    assert.equal(allTime.expenseTotal, "64.57");
    assert.equal(allTime.creditPurchaseTotal, "52.23");
    assert.equal(allTime.unlinkedCardCreditTotal, "7.77");

    // Another wallet's credits never reach this one, and the reverse holds too.
    const other = await repository.getSummary(otherWalletId, "2026-10-01", "2026-10-31");
    assert.equal(other.cardCreditTotal, "70.00");
    assert.equal(other.expenseTotal, "0.00");
    assert.deepEqual(other.expenseByCategory, [
      { categoryId: categoryId("Outra carteira"), categoryName: "Outra carteira", amount: "0.00" },
    ]);

    // A period with no movement at all answers in zeros, not in the credits of other periods.
    const empty = await repository.getSummary(walletId, "2026-12-01", "2026-12-31");
    assert.equal(empty.expenseTotal, "0.00");
    assert.equal(empty.cardCreditTotal, "0.00");
    assert.equal(empty.unlinkedCardCreditTotal, "0.00");
    assert.deepEqual(empty.expenseByCategory, []);
  } finally {
    await scopedPool?.end();
    await adminPool.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
    await adminPool.end();
  }
});
