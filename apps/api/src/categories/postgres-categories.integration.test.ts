import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { Pool } from "pg";
import { createDatabase, runMigrations } from "../database.js";
import { CategoriesService } from "./categories.service.js";
import { PostgresCategoriesRepository } from "./postgres-categories.repository.js";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

test("PostgreSQL category CRUD, uniqueness, ownership, and referenced deletion behavior", {
  skip: !testDatabaseUrl,
}, async () => {
  const schemaName = `category_test_${randomBytes(8).toString("hex")}`;
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

    const userResult = await database.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, email_verified_at)
       VALUES ($1, 'test-hash', now())
       RETURNING id`,
      [`category-${schemaName}@example.com`],
    );
    const secondUserResult = await database.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, email_verified_at)
       VALUES ($1, 'test-hash', now())
       RETURNING id`,
      [`other-${schemaName}@example.com`],
    );
    const userId = userResult.rows[0]!.id;
    const secondUserId = secondUserResult.rows[0]!.id;
    const walletIds = await database.query<{ owner_user_id: string; id: string }>(
      "SELECT owner_user_id, id FROM wallets WHERE owner_user_id = ANY($1::uuid[])",
      [[userId, secondUserId]],
    );
    const walletId = walletIds.rows.find((row) => row.owner_user_id === userId)!.id;
    const secondWalletId = walletIds.rows.find((row) => row.owner_user_id === secondUserId)!.id;
    const service = new CategoriesService(new PostgresCategoriesRepository(database));

    const category = await service.createCategory(userId, walletId, "  Casa ", "expense");
    const sameNameOtherNature = await service.createCategory(userId, walletId, "Casa", "income");
    const sameNameOtherUser = await service.createCategory(secondUserId, secondWalletId, "Casa", "expense");
    assert.equal(category.name, "Casa");
    assert.equal(sameNameOtherNature.nature, "income");
    assert.notEqual(sameNameOtherUser.id, category.id);

    const displayName = "  Árvore  ";
    const persistedDisplayName = await database.query<{ name: string; name_normalized: string }>(
      `INSERT INTO categories (user_id, wallet_id, name, nature)
       VALUES ($1, $2, $3, 'income')
       RETURNING name, name_normalized`,
      [userId, walletId, displayName],
    );
    assert.equal(persistedDisplayName.rows[0]?.name, displayName);
    assert.equal(persistedDisplayName.rows[0]?.name_normalized, "arvore");
    await database.query("DELETE FROM categories WHERE name = $1 AND user_id = $2", [displayName, userId]);

    await assert.rejects(
      service.createCategory(userId, walletId, " casa ", "expense"),
      (error: unknown) => typeof error === "object" && error !== null && "statusCode" in error && error.statusCode === 409,
    );
    const salaryCategory = await service.createCategory(userId, walletId, "Salário", "expense");
    await assert.rejects(
      service.createCategory(userId, walletId, "salario", "expense"),
      (error: unknown) => typeof error === "object" && error !== null && "statusCode" in error && error.statusCode === 409,
    );
    await service.deleteCategory(userId, walletId, salaryCategory.id);

    const subcategory = await service.createSubcategory(userId, walletId, category.id, "Moradia");
    await assert.rejects(
      service.createSubcategory(userId, walletId, category.id, " moradia "),
      (error: unknown) => typeof error === "object" && error !== null && "statusCode" in error && error.statusCode === 409,
    );
    await assert.rejects(
      service.createSubcategory(userId, walletId, category.id, "moradía"),
      (error: unknown) => typeof error === "object" && error !== null && "statusCode" in error && error.statusCode === 409,
    );
    const listed = await service.listCategories(userId, walletId, "expense");
    assert.deepEqual(listed, [{
      id: category.id,
      name: "Casa",
      nature: "expense",
      subcategories: [subcategory],
    }]);
    assert.deepEqual(await service.listCategories(secondUserId, secondWalletId), [{
      id: sameNameOtherUser.id,
      name: "Casa",
      nature: "expense",
      subcategories: [],
    }]);

    await database.query(`
      CREATE TABLE financial_movements (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id uuid NOT NULL,
        category_id uuid NOT NULL,
        subcategory_id uuid NOT NULL,
        CONSTRAINT financial_movements_category_fk
          FOREIGN KEY (category_id, user_id)
          REFERENCES categories (id, user_id) ON DELETE RESTRICT,
        CONSTRAINT financial_movements_subcategory_fk
          FOREIGN KEY (subcategory_id, user_id, category_id)
          REFERENCES subcategories (id, user_id, category_id) ON DELETE RESTRICT
      )
    `);
    await database.query(
      `INSERT INTO financial_movements (user_id, category_id, subcategory_id)
       VALUES ($1, $2, $3)`,
      [userId, category.id, subcategory.id],
    );

    await assert.rejects(
      service.deleteSubcategory(userId, walletId, category.id, subcategory.id),
      (error: unknown) => typeof error === "object" && error !== null && "statusCode" in error && error.statusCode === 409,
    );
    await assert.rejects(
      service.deleteCategory(userId, walletId, category.id),
      (error: unknown) => typeof error === "object" && error !== null && "statusCode" in error && error.statusCode === 409,
    );

    await database.query("DELETE FROM financial_movements WHERE category_id = $1", [category.id]);
    await service.deleteCategory(userId, walletId, category.id);
    assert.deepEqual(await service.listCategories(userId, walletId), [sameNameOtherNature]);

    const investmentCategory = await service.createCategory(userId, walletId, "Reserva", "investment_goal");
    await database.query(
      `INSERT INTO investment_goals (user_id, wallet_id, title, description, target_amount, category_id, category_nature)
       VALUES ($1, $2, 'Reserva', 'Meta de investimento', 100, $3, 'investment_goal')`,
      [userId, walletId, investmentCategory.id],
    );
    await assert.rejects(
      service.deleteCategory(userId, walletId, investmentCategory.id),
      (error: unknown) => typeof error === "object" && error !== null && "statusCode" in error && error.statusCode === 409,
    );
    await database.query("DELETE FROM investment_goals WHERE category_id = $1", [investmentCategory.id]);
    await service.deleteCategory(userId, walletId, investmentCategory.id);
  } finally {
    await scopedPool?.end();
    await adminPool.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
    await adminPool.end();
  }
});
