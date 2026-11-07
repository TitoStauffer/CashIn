import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { createDatabase, runMigrations } from "../database.js";
import { ExpensesService } from "../expenses/expenses.service.js";
import { PostgresExpensesRepository } from "../expenses/postgres-expenses.repository.js";
import { PostgresFinancialSummaryRepository } from "../financial-summary/postgres-financial-summary.repository.js";
import { CreditCardError } from "./credit-cards.errors.js";
import { PostgresCreditCardsRepository } from "./postgres-credit-cards.repository.js";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

test("credit-card billing assigns purchases by card close date and pays the statement without duplicating expenses", {
  skip: !testDatabaseUrl,
}, async () => {
  const schemaName = `credit_card_test_${randomBytes(8).toString("hex")}`;
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
      [`card-${schemaName}@example.com`, `other-card-${schemaName}@example.com`],
    );
    const userId = users.rows.find((row) => row.email === `card-${schemaName}@example.com`)!.id;
    const otherUserId = users.rows.find((row) => row.email === `other-card-${schemaName}@example.com`)!.id;
    const wallets = await database.query<{ id: string; owner_user_id: string }>(
      "SELECT id, owner_user_id FROM wallets WHERE owner_user_id = ANY($1::uuid[])", [[userId, otherUserId]],
    );
    const walletId = wallets.rows.find((row) => row.owner_user_id === userId)!.id;
    const otherWalletId = wallets.rows.find((row) => row.owner_user_id === otherUserId)!.id;
    const category = await database.query<{ id: string }>(
      "INSERT INTO categories (user_id, wallet_id, name, nature) VALUES ($1, $2, 'Market', 'expense') RETURNING id",
      [userId, walletId],
    );
    const incomeCategory = await database.query<{ id: string }>(
      "INSERT INTO categories (user_id, wallet_id, name, nature) VALUES ($1, $2, 'Salary', 'income') RETURNING id",
      [userId, walletId],
    );
    const credit = await database.query<{ id: string }>(
      "SELECT id FROM payment_methods WHERE wallet_id = $1 AND nature = 'credit_card' LIMIT 1", [walletId],
    );
    const pix = await database.query<{ id: string }>(
      "SELECT id FROM payment_methods WHERE wallet_id = $1 AND name_normalized = 'pix'", [walletId],
    );
    const cards = new PostgresCreditCardsRepository(database);
    const firstCard = await cards.create(walletId, { nickname: "Gold", closingDay: 10, dueDay: 20 });
    const secondCard = await cards.create(walletId, { nickname: "Travel", closingDay: 5, dueDay: 15 });
    const expenses = new ExpensesService(new PostgresExpensesRepository(database));

    await database.query(
      "INSERT INTO incomes (user_id, wallet_id, category_id, amount, date) VALUES ($1, $2, $3, 100, '2026-10-01')",
      [userId, walletId, incomeCategory.rows[0]!.id],
    );
    const onClosing = await expenses.createExpense(userId, walletId, {
      amount: "10.00", date: "2026-10-10", description: "Closing day purchase", categoryId: category.rows[0]!.id,
      subcategoryId: null, paymentMethodId: credit.rows[0]!.id, creditCardId: firstCard.id,
    });
    const afterClosing = await expenses.createExpense(userId, walletId, {
      amount: "20.00", date: "2026-10-11", description: "Next cycle purchase", categoryId: category.rows[0]!.id,
      subcategoryId: null, paymentMethodId: credit.rows[0]!.id, creditCardId: firstCard.id,
    });
    const otherCardPurchase = await expenses.createExpense(userId, walletId, {
      amount: "30.00", date: "2026-10-10", description: "Second card purchase", categoryId: category.rows[0]!.id,
      subcategoryId: null, paymentMethodId: credit.rows[0]!.id, creditCardId: secondCard.id,
    });
    await expenses.createExpense(userId, walletId, {
      amount: "5.00", date: "2026-10-10", description: "Cash expense", categoryId: category.rows[0]!.id,
      subcategoryId: null, paymentMethodId: pix.rows[0]!.id, creditCardId: null,
    });

    assert.equal(onClosing.creditCardName, "Gold");
    assert.ok(onClosing.creditCardStatementId);
    assert.notEqual(onClosing.creditCardStatementId, afterClosing.creditCardStatementId);
    assert.equal(otherCardPurchase.creditCardId, secondCard.id);
    const goldStatements = await cards.listStatements(walletId, firstCard.id);
    assert.equal(goldStatements?.length, 2);
    assert.equal(goldStatements?.find((statement) => statement.closingDate === "2026-10-10")?.totalAmount, "10.00");
    assert.equal(goldStatements?.find((statement) => statement.closingDate === "2026-11-10")?.totalAmount, "20.00");
    const travelStatements = await cards.listStatements(walletId, secondCard.id);
    assert.equal(travelStatements?.[0]?.closingDate, "2026-11-05");
    assert.equal(travelStatements?.[0]?.dueDate, "2026-11-15");

    const summaryRepository = new PostgresFinancialSummaryRepository(database);
    const beforePayment = await summaryRepository.getSummary(walletId, "2026-10-01", "2026-10-31");
    assert.equal(beforePayment.expenseTotal, "65.00");
    assert.equal(beforePayment.cashIncomeTotal, "100.00");
    assert.equal(beforePayment.cashExpenseTotal, "5.00");
    assert.equal(beforePayment.creditPurchaseTotal, "60.00");
    assert.equal(beforePayment.cardPaymentTotal, "0.00");
    assert.equal(beforePayment.cashBalance, "95.00");

    const octoberStatement = goldStatements!.find((statement) => statement.closingDate === "2026-10-10")!;
    const paid = await cards.payStatement(walletId, firstCard.id, octoberStatement.id, "2026-10-20");
    assert.equal(paid?.paidDate, "2026-10-20");
    assert.equal(paid?.paidAmount, "10.00");
    const afterPayment = await summaryRepository.getSummary(walletId, "2026-10-01", "2026-10-31");
    assert.equal(afterPayment.expenseTotal, "65.00");
    assert.equal(afterPayment.cashExpenseTotal, "5.00");
    assert.equal(afterPayment.creditPurchaseTotal, "60.00");
    assert.equal(afterPayment.cardPaymentTotal, "10.00");
    assert.equal(afterPayment.cashBalance, "85.00");
    assert.equal(afterPayment.availableBalance, "85.00");
    const purchaseDay = await summaryRepository.getSummary(walletId, "2026-10-10", "2026-10-10");
    assert.equal(purchaseDay.expenseTotal, "45.00");
    assert.equal(purchaseDay.cashExpenseTotal, "5.00");
    assert.equal(purchaseDay.creditPurchaseTotal, "40.00");
    assert.equal(purchaseDay.cardPaymentTotal, "0.00");
    assert.equal(purchaseDay.cashBalance, "-5.00");
    const paymentDay = await summaryRepository.getSummary(walletId, "2026-10-20", "2026-10-20");
    assert.equal(paymentDay.expenseTotal, "0.00");
    assert.equal(paymentDay.cashExpenseTotal, "0.00");
    assert.equal(paymentDay.creditPurchaseTotal, "0.00");
    assert.equal(paymentDay.cardPaymentTotal, "10.00");
    assert.equal(paymentDay.cashBalance, "-10.00");
    const afterPaymentDay = await summaryRepository.getSummary(walletId, "2026-10-21", "2026-10-31");
    assert.equal(afterPaymentDay.cardPaymentTotal, "0.00");
    await assert.rejects(
      () => cards.payStatement(walletId, firstCard.id, octoberStatement.id, "2026-10-21"),
      (error: unknown) => error instanceof CreditCardError && error.statusCode === 409,
    );
    await assert.rejects(
      () => expenses.createExpense(userId, walletId, {
        amount: "1.00", date: "2026-10-09", description: "Late entry", categoryId: category.rows[0]!.id,
        subcategoryId: null, paymentMethodId: credit.rows[0]!.id, creditCardId: firstCard.id,
      }),
      (error: unknown) => error instanceof Error && "statusCode" in error && error.statusCode === 409,
    );
    await assert.rejects(
      () => expenses.updateExpense(userId, walletId, onClosing.id, {
        amount: "11.00", date: "2026-10-10", description: "Attempt to alter paid purchase", categoryId: category.rows[0]!.id,
        subcategoryId: null, paymentMethodId: credit.rows[0]!.id, creditCardId: firstCard.id,
      }),
      (error: unknown) => error instanceof Error && "statusCode" in error && error.statusCode === 409,
    );
    await assert.rejects(
      () => expenses.deleteExpense(userId, walletId, onClosing.id),
      (error: unknown) => error instanceof Error && "statusCode" in error && error.statusCode === 409,
    );
    assert.equal(await cards.listStatements(otherWalletId, firstCard.id), null);
  } finally {
    await scopedPool?.end();
    await adminPool.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
    await adminPool.end();
  }
});

test("migration 019 turns every settled statement into a payment and keeps the amount paid", {
  skip: !testDatabaseUrl,
}, async () => {
  const schemaName = `payment_migration_${randomBytes(8).toString("hex")}`;
  const adminPool = new Pool({ connectionString: testDatabaseUrl });
  let scopedPool: Pool | undefined;
  try {
    await adminPool.query(`CREATE SCHEMA ${schemaName}`);
    scopedPool = new Pool({ connectionString: testDatabaseUrl, options: `-c search_path=${schemaName}` });
    const database = createDatabase(scopedPool);
    const migrationDirectory = fileURLToPath(new URL("../../migrations/", import.meta.url));
    const paymentsVersion = "019_credit_card_statement_payments.sql";
    // Applied versions are recorded, so the rerun at the end of this test behaves like a real deploy.
    await database.query("CREATE TABLE schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
    for (const version of (await readdir(migrationDirectory))
      .filter((name) => /^\d+_[a-z0-9_-]+\.sql$/i.test(name) && name < paymentsVersion)
      .sort()) {
      const sql = await readFile(join(migrationDirectory, version), "utf8");
      await database.transaction(async (transaction) => {
        await transaction.query(sql);
        await transaction.query("INSERT INTO schema_migrations (version) VALUES ($1)", [version]);
      });
    }

    const user = await database.query<{ id: string }>(
      "INSERT INTO users (email, password_hash, email_verified_at) VALUES ($1, 'test-hash', now()) RETURNING id",
      [`migration-${schemaName}@example.com`],
    );
    const userId = user.rows[0]!.id;
    const wallet = await database.query<{ id: string }>(
      "SELECT id FROM wallets WHERE owner_user_id = $1 AND is_personal", [userId],
    );
    const walletId = wallet.rows[0]!.id;
    const card = await database.query<{ id: string }>(
      "INSERT INTO credit_cards (wallet_id, alias, closing_day, due_day) VALUES ($1, 'Principal', 10, 20) RETURNING id",
      [walletId],
    );
    // One settled statement and one still open, as the schema before this migration allowed.
    const statements = await database.query<{ id: string; closing_date: string }>(
      `INSERT INTO credit_card_statements (wallet_id, credit_card_id, closing_date, due_date, paid_date, paid_amount)
       VALUES ($1, $2, '2026-09-10', '2026-09-20', '2026-09-19', '123.45'),
              ($1, $2, '2026-10-10', '2026-10-20', NULL, NULL)
       RETURNING id, closing_date::text AS closing_date`,
      [walletId, card.rows[0]!.id],
    );
    const settledId = statements.rows.find((row) => row.closing_date === "2026-09-10")!.id;
    const openId = statements.rows.find((row) => row.closing_date === "2026-10-10")!.id;

    const migration = await readFile(join(migrationDirectory, paymentsVersion), "utf8");
    await database.transaction(async (transaction) => {
      await transaction.query(migration);
      await transaction.query("INSERT INTO schema_migrations (version) VALUES ($1)", [paymentsVersion]);
    });

    const payments = await database.query<{ statement: string; amount: string; date: string; source: string; user_id: string }>(
      `SELECT credit_card_statement_id AS statement, amount::text, date::text, source, user_id
       FROM credit_card_statement_payments WHERE wallet_id = $1`,
      [walletId],
    );
    assert.deepEqual(payments.rows, [
      { statement: settledId, amount: "123.45", date: "2026-09-19", source: "manual", user_id: userId },
    ]);
    // The settlement marker survives; the open statement gains no payment.
    const kept = await database.query<{ id: string; paid_date: string | null }>(
      "SELECT id, paid_date::text AS paid_date FROM credit_card_statements WHERE wallet_id = $1 ORDER BY closing_date",
      [walletId],
    );
    assert.deepEqual(kept.rows, [{ id: settledId, paid_date: "2026-09-19" }, { id: openId, paid_date: null }]);
    // The duplicated amount column is gone, so the payments are the single source of truth.
    const columns = await database.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = $1 AND table_name = 'credit_card_statements' AND column_name = 'paid_amount'`,
      [schemaName],
    );
    assert.deepEqual(columns.rows, []);

    // Re-running it is safe, as runMigrations may retry a failed deploy.
    await runMigrations(database);
    assert.equal(
      (await database.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM credit_card_statement_payments WHERE wallet_id = $1", [walletId],
      )).rows[0]!.count,
      "1",
    );
  } finally {
    await scopedPool?.end();
    await adminPool.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
    await adminPool.end();
  }
});
