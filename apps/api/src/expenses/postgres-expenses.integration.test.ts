import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { createDatabase, runMigrations } from "../database.js";
import { ExpensesService } from "./expenses.service.js";
import { PostgresExpensesRepository } from "./postgres-expenses.repository.js";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

test("migration 012 backfills expense payment nature as an immutable historical snapshot", {
  skip: !testDatabaseUrl,
}, async () => {
  const schemaName = `expense_nature_migration_${randomBytes(8).toString("hex")}`;
  const adminPool = new Pool({ connectionString: testDatabaseUrl });
  let scopedPool: Pool | undefined;
  try {
    await adminPool.query(`CREATE SCHEMA ${schemaName}`);
    scopedPool = new Pool({ connectionString: testDatabaseUrl, options: `-c search_path=${schemaName}` });
    const database = createDatabase(scopedPool);
    const migrationDirectory = fileURLToPath(new URL("../../migrations/", import.meta.url));
    for (const version of [
      "001_auth.sql", "002_categories.sql", "003_incomes.sql", "004_expenses.sql",
      "005_investment_goals.sql", "006_financial_precision_and_name_uniqueness.sql", "007_wallets.sql",
      "008_wallet_invitations.sql", "009_wallet_access_requests.sql", "010_payment_methods.sql", "011_income_balance_type.sql",
    ]) {
      await database.query(await readFile(join(migrationDirectory, version), "utf8"));
    }
    const user = await database.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, email_verified_at) VALUES ($1, 'test-hash', now()) RETURNING id`,
      [`expense-nature-${schemaName}@example.com`],
    );
    const userId = user.rows[0]!.id;
    const wallet = await database.query<{ id: string }>(
      "SELECT id FROM wallets WHERE owner_user_id = $1 AND is_personal = true", [userId],
    );
    const walletId = wallet.rows[0]!.id;
    const category = await database.query<{ id: string }>(
      `INSERT INTO categories (user_id, wallet_id, name, nature) VALUES ($1, $2, 'Food', 'expense') RETURNING id`,
      [userId, walletId],
    );
    const method = await database.query<{ id: string }>(
      "SELECT id FROM payment_methods WHERE wallet_id = $1 AND name_normalized = 'vale-refeicao'", [walletId],
    );
    const expense = await database.query<{ id: string }>(
      `INSERT INTO expenses (user_id, wallet_id, category_id, payment_method_id, amount, date)
       VALUES ($1, $2, $3, $4, 15, '2026-10-20') RETURNING id`,
      [userId, walletId, category.rows[0]!.id, method.rows[0]!.id],
    );
    await database.query(await readFile(join(migrationDirectory, "012_expense_payment_method_nature_snapshot.sql"), "utf8"));
    const migrated = await database.query<{ payment_method_nature: string }>(
      "SELECT payment_method_nature FROM expenses WHERE id = $1", [expense.rows[0]!.id],
    );
    assert.equal(migrated.rows[0]?.payment_method_nature, "meal_benefit");
    await database.query("UPDATE payment_methods SET nature = 'immediate' WHERE id = $1", [method.rows[0]!.id]);
    const preserved = await database.query<{ payment_method_nature: string }>(
      "SELECT payment_method_nature FROM expenses WHERE id = $1", [expense.rows[0]!.id],
    );
    assert.equal(preserved.rows[0]?.payment_method_nature, "meal_benefit");
  } finally {
    await scopedPool?.end();
    await adminPool.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
    await adminPool.end();
  }
});

test("PostgreSQL expense CRUD enforces ownership, category nature, references, and date filters", {
  skip: !testDatabaseUrl,
}, async () => {
  const schemaName = `expense_test_${randomBytes(8).toString("hex")}`;
  const adminPool = new Pool({ connectionString: testDatabaseUrl });
  let scopedPool: Pool | undefined;

  try {
    await adminPool.query(`CREATE SCHEMA ${schemaName}`);
    scopedPool = new Pool({
      connectionString: testDatabaseUrl,
      options: `-c search_path=${schemaName}`,
    });
    const database = createDatabase(scopedPool);
    await runMigrations(database);

    const users = await database.query<{ id: string; email: string }>(
      `INSERT INTO users (email, password_hash, email_verified_at)
       VALUES ($1, 'test-hash', now()), ($2, 'test-hash', now())
       RETURNING id, email`,
      [`expense-${schemaName}@example.com`, `other-${schemaName}@example.com`],
    );
    const userId = users.rows.find((row) => row.email === `expense-${schemaName}@example.com`)?.id;
    const otherUserId = users.rows.find((row) => row.email === `other-${schemaName}@example.com`)?.id;
    assert.ok(userId && otherUserId);
    const walletRows = await database.query<{ owner_user_id: string; id: string }>(
      "SELECT owner_user_id, id FROM wallets WHERE owner_user_id = ANY($1::uuid[])", [[userId, otherUserId]],
    );
    const walletId = walletRows.rows.find((row) => row.owner_user_id === userId)!.id;
    const otherWalletId = walletRows.rows.find((row) => row.owner_user_id === otherUserId)!.id;
    const service = new ExpensesService(new PostgresExpensesRepository(database));

    const categories = await database.query<{ id: string; nature: string; user_id: string }>(
      `INSERT INTO categories (user_id, wallet_id, name, nature)
      VALUES ($1, $3, 'Lazer', 'expense'), ($1, $3, 'Salário', 'income'), ($2, $4, 'Lazer', 'expense')
       RETURNING id, nature, user_id`,
      [userId, otherUserId, walletId, otherWalletId],
    );
    const expenseCategory = categories.rows.find((row) => row.nature === "expense" && row.user_id === userId)!.id;
    const incomeCategory = categories.rows.find((row) => row.nature === "income" && row.user_id === userId)!.id;
    const otherExpenseCategory = categories.rows.find((row) => row.nature === "expense" && row.user_id === otherUserId)!.id;
    const subcategoryResult = await database.query<{ id: string }>(
      `INSERT INTO subcategories (user_id, wallet_id, category_id, name)
       VALUES ($1, $2, $3, 'Mensal') RETURNING id`,
      [userId, walletId, expenseCategory],
    );
    const subcategoryId = subcategoryResult.rows[0]!.id;
    const paymentMethodResult = await database.query<{ id: string }>(
      "SELECT id FROM payment_methods WHERE wallet_id = $1 AND name_normalized = 'pix'",
      [walletId],
    );
    const paymentMethodId = paymentMethodResult.rows[0]!.id;

    const first = await service.createExpense(userId, walletId, {
      amount: "123456789012.34",
      date: "2026-10-18",
      description: "Salário",
      categoryId: expenseCategory,
      subcategoryId,
      paymentMethodId,
    });
    await service.createExpense(userId, walletId, {
      amount: "0.01",
      date: "2026-10-19",
      categoryId: expenseCategory,
    });
    assert.equal(first.amount, "123456789012.34");
    assert.equal(first.subcategoryName, "Mensal");
    assert.equal(first.paymentMethodId, paymentMethodId);
    assert.equal(first.paymentMethodName, "Pix");
    assert.equal(first.paymentMethodNature, "immediate");

    const foodBenefitMethod = await database.query<{ id: string }>(
      "SELECT id FROM payment_methods WHERE wallet_id = $1 AND name_normalized = 'vale-alimentacao'",
      [walletId],
    );
    const foodExpense = await service.createExpense(userId, walletId, {
      amount: "10.00",
      date: "2026-10-18",
      categoryId: expenseCategory,
      paymentMethodId: foodBenefitMethod.rows[0]!.id,
    });
    assert.equal(foodExpense.paymentMethodNature, "food_benefit");
    await database.query("UPDATE payment_methods SET nature = 'immediate' WHERE id = $1", [foodBenefitMethod.rows[0]!.id]);
    const preservedFoodExpense = (await service.listExpenses(userId, walletId)).find((expense) => expense.id === foodExpense.id);
    assert.equal(preservedFoodExpense?.paymentMethodNature, "food_benefit");
    assert.deepEqual((await service.listExpenses(userId, walletId, "2026-10-18", "2026-10-18")).map((item) => item.id), [foodExpense.id, first.id]);
    assert.equal((await service.listExpenses(otherUserId, otherWalletId)).length, 0);

    await assert.rejects(
      service.createExpense(userId, walletId, { amount: "1", date: "2026-10-18", categoryId: incomeCategory }),
      (error: unknown) => typeof error === "object" && error !== null && "statusCode" in error && error.statusCode === 400,
    );
    await assert.rejects(
      service.createExpense(userId, walletId, { amount: "1", date: "2026-10-18", categoryId: otherExpenseCategory }),
      (error: unknown) => typeof error === "object" && error !== null && "statusCode" in error && error.statusCode === 400,
    );

    const updated = await service.updateExpense(userId, walletId, first.id, {
      amount: "99.90",
      date: "2026-10-20",
      description: null,
      categoryId: expenseCategory,
      paymentMethodId,
    });
    assert.equal(updated.amount, "99.90");
    assert.equal(updated.description, null);
    assert.equal(updated.subcategoryId, null);
    assert.equal(updated.paymentMethodId, paymentMethodId);

    await database.query("UPDATE payment_methods SET is_active = false WHERE id = $1", [paymentMethodId]);
    const preservedInactive = await service.updateExpense(userId, walletId, first.id, {
      amount: "100.00", date: "2026-10-20", categoryId: expenseCategory, paymentMethodId,
    });
    assert.equal(preservedInactive.paymentMethodName, "Pix");
    await assert.rejects(
      service.createExpense(userId, walletId, { amount: "5.00", date: "2026-10-20", categoryId: expenseCategory, paymentMethodId }),
      (error: unknown) => typeof error === "object" && error !== null && "statusCode" in error && error.statusCode === 400,
    );
    await assert.rejects(
      service.updateExpense(otherUserId, otherWalletId, first.id, {
        amount: "10", date: "2026-10-20", categoryId: expenseCategory,
      }),
      (error: unknown) => typeof error === "object" && error !== null && "statusCode" in error && error.statusCode === 404,
    );

    await service.deleteExpense(userId, walletId, first.id);
    await assert.rejects(
      service.deleteExpense(userId, walletId, first.id),
      (error: unknown) => typeof error === "object" && error !== null && "statusCode" in error && error.statusCode === 404,
    );
  } finally {
    await scopedPool?.end();
    await adminPool.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
    await adminPool.end();
  }
});
