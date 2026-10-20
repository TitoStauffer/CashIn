import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { Pool } from "pg";
import { createDatabase, runMigrations } from "../database.js";
import { ExpensesService } from "./expenses.service.js";
import { PostgresExpensesRepository } from "./postgres-expenses.repository.js";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

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
    const service = new ExpensesService(new PostgresExpensesRepository(database));

    const categories = await database.query<{ id: string; nature: string; user_id: string }>(
      `INSERT INTO categories (user_id, name, nature)
      VALUES ($1, 'Lazer', 'expense'), ($1, 'Salário', 'income'), ($2, 'Lazer', 'expense')
       RETURNING id, nature, user_id`,
      [userId, otherUserId],
    );
    const expenseCategory = categories.rows.find((row) => row.nature === "expense" && row.user_id === userId)!.id;
    const incomeCategory = categories.rows.find((row) => row.nature === "income" && row.user_id === userId)!.id;
    const otherExpenseCategory = categories.rows.find((row) => row.nature === "expense" && row.user_id === otherUserId)!.id;
    const subcategoryResult = await database.query<{ id: string }>(
      `INSERT INTO subcategories (user_id, category_id, name)
       VALUES ($1, $2, 'Mensal') RETURNING id`,
      [userId, expenseCategory],
    );
    const subcategoryId = subcategoryResult.rows[0]!.id;

    const first = await service.createExpense(userId, {
      amount: "123456789012.34",
      date: "2026-10-18",
      description: "Salário",
      categoryId: expenseCategory,
      subcategoryId,
    });
    await service.createExpense(userId, {
      amount: "0.01",
      date: "2026-10-19",
      categoryId: expenseCategory,
    });
    assert.equal(first.amount, "123456789012.34");
    assert.equal(first.subcategoryName, "Mensal");
    assert.deepEqual((await service.listExpenses(userId, "2026-10-18", "2026-10-18")).map((item) => item.id), [first.id]);
    assert.equal((await service.listExpenses(otherUserId)).length, 0);

    await assert.rejects(
      service.createExpense(userId, { amount: "1", date: "2026-10-18", categoryId: incomeCategory }),
      (error: unknown) => typeof error === "object" && error !== null && "statusCode" in error && error.statusCode === 400,
    );
    await assert.rejects(
      service.createExpense(userId, { amount: "1", date: "2026-10-18", categoryId: otherExpenseCategory }),
      (error: unknown) => typeof error === "object" && error !== null && "statusCode" in error && error.statusCode === 400,
    );

    const updated = await service.updateExpense(userId, first.id, {
      amount: "99.90",
      date: "2026-10-20",
      description: null,
      categoryId: expenseCategory,
    });
    assert.equal(updated.amount, "99.90");
    assert.equal(updated.description, null);
    assert.equal(updated.subcategoryId, null);
    await assert.rejects(
      service.updateExpense(otherUserId, first.id, {
        amount: "10", date: "2026-10-20", categoryId: expenseCategory,
      }),
      (error: unknown) => typeof error === "object" && error !== null && "statusCode" in error && error.statusCode === 404,
    );

    await service.deleteExpense(userId, first.id);
    await assert.rejects(
      service.deleteExpense(userId, first.id),
      (error: unknown) => typeof error === "object" && error !== null && "statusCode" in error && error.statusCode === 404,
    );
  } finally {
    await scopedPool?.end();
    await adminPool.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
    await adminPool.end();
  }
});
