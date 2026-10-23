import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
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
