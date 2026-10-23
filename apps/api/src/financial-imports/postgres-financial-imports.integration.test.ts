import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { Pool } from "pg";
import { createDatabase, runMigrations } from "../database.js";
import { PostgresFinancialImportsRepository } from "./postgres-financial-imports.repository.js";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

test("PostgreSQL financial import confirms exact amounts, isolates wallets, and safely undoes unchanged movements", {
  skip: !testDatabaseUrl,
}, async () => {
  const schemaName = `financial_import_${randomBytes(8).toString("hex")}`;
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

    const created = await repository.createImport(userId, walletId, {
      format: "csv",
      fileName: "movimentações.csv",
      fileSize: 128,
      fileHash: "a".repeat(64),
    });
    assert.equal(created.status, "processing");
    assert.equal(created.canUndo, false);
    assert.equal(await repository.getImport(userId, otherWalletId, created.id), null);

    const preview = await repository.savePreview(userId, walletId, created.id, [
      {
        sequence: 1,
        date: "2026-10-20",
        description: "Salário",
        signedAmount: "123456789012.34",
        type: "income",
        categoryId: incomeCategoryId,
        validationStatus: "valid",
      },
      {
        sequence: 2,
        date: "2026-10-21",
        description: "Mercado",
        signedAmount: "-87.65",
        type: "expense",
        categoryId: expenseCategoryId,
        validationStatus: "valid",
      },
      {
        sequence: 3,
        date: "2026-10-21",
        description: "Sem categoria",
        signedAmount: "-1.00",
        type: "expense",
        validationStatus: "uncategorized",
      },
    ]);
    assert.deepEqual(preview?.summary, {
      total: 3,
      valid: 2,
      duplicate: 0,
      invalid: 0,
      uncategorized: 1,
      imported: 0,
    });

    const completed = await repository.confirmImport(otherUserId, walletId, created.id);
    assert.equal(completed?.status, "completed");
    assert.equal(completed?.summary.imported, 2);
    assert.equal(completed?.canUndo, true);
    const movements = await database.query<{ source: string; amount: string }>(
      `SELECT 'income' AS source, amount::text FROM incomes WHERE wallet_id = $1
       UNION ALL
       SELECT 'expense' AS source, amount::text FROM expenses WHERE wallet_id = $1
       ORDER BY source`,
      [walletId],
    );
    assert.deepEqual(movements.rows, [
      { source: "expense", amount: "87.65" },
      { source: "income", amount: "123456789012.34" },
    ]);

    const undone = await repository.undoImport(userId, walletId, created.id);
    assert.equal(undone?.status, "undone");
    assert.equal(undone?.summary.imported, 0);
    assert.equal((await database.query("SELECT id FROM incomes WHERE wallet_id = $1", [walletId])).rows.length, 0);
    assert.equal((await database.query("SELECT id FROM expenses WHERE wallet_id = $1", [walletId])).rows.length, 0);

    const changedSession = await repository.createImport(userId, walletId, {
      format: "ofx",
      fileName: "statement.ofx",
      fileSize: 64,
      fileHash: "b".repeat(64),
    });
    await repository.savePreview(userId, walletId, changedSession.id, [{
      sequence: 1,
      date: "2026-10-22",
      signedAmount: "10.00",
      type: "income",
      categoryId: incomeCategoryId,
      validationStatus: "valid",
    }]);
    await repository.confirmImport(userId, walletId, changedSession.id);
    await database.query(
      "UPDATE incomes SET description = 'alterado', updated_at = now() + interval '1 second' WHERE wallet_id = $1",
      [walletId],
    );
    const changed = await repository.getImport(userId, walletId, changedSession.id);
    assert.equal(changed?.canUndo, false);
    assert.equal(changed?.undoBlockedReason, "Um ou mais lançamentos importados foram alterados ou removidos.");
    assert.equal(await repository.undoImport(userId, walletId, changedSession.id), null);
    await database.query("DELETE FROM incomes WHERE wallet_id = $1", [walletId]);
    const removed = await repository.getImport(userId, walletId, changedSession.id);
    assert.equal(removed?.canUndo, false);
    assert.equal(removed?.undoBlockedReason, "Um ou mais lançamentos importados foram alterados ou removidos.");
  } finally {
    await scopedPool?.end();
    await adminPool.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
    await adminPool.end();
  }
});
