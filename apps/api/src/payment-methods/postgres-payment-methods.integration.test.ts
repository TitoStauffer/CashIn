import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { createDatabase } from "../database.js";
import { PostgresPaymentMethodsRepository } from "./postgres-payment-methods.repository.js";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

test("PostgreSQL payment methods seed wallet defaults and enforce wallet-scoped persistence rules", {
  skip: !testDatabaseUrl,
}, async () => {
  const schemaName = `payment_methods_${randomBytes(8).toString("hex")}`;
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
      "007_wallets.sql",
      "008_wallet_invitations.sql",
      "009_wallet_access_requests.sql",
    ]) {
      const sql = await readFile(join(migrationDirectory, version), "utf8");
      await database.transaction(async (transaction) => {
        await transaction.query(sql);
        await transaction.query("INSERT INTO schema_migrations (version) VALUES ($1)", [version]);
      });
    }

    const users = [
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    ];
    await database.query(
      `INSERT INTO users (id, email, password_hash, email_verified_at) VALUES
        ($1, 'payment-owner-a@example.com', 'test-hash', now()),
        ($2, 'payment-owner-b@example.com', 'test-hash', now())`,
      users,
    );

    const migration = await readFile(join(migrationDirectory, "010_payment_methods.sql"), "utf8");
    await database.transaction(async (transaction) => {
      await transaction.query(migration);
      await transaction.query("INSERT INTO schema_migrations (version) VALUES ('010_payment_methods.sql')");
    });

    const wallets = await database.query<{ id: string; owner_user_id: string }>(
      "SELECT id, owner_user_id FROM wallets WHERE owner_user_id = ANY($1::uuid[]) ORDER BY owner_user_id",
      [users],
    );
    assert.equal(wallets.rows.length, 2);
    const walletA = wallets.rows.find((wallet) => wallet.owner_user_id === users[0])!;
    const walletB = wallets.rows.find((wallet) => wallet.owner_user_id === users[1])!;

    const defaults = await database.query<{ name: string; nature: string; is_active: boolean }>(
      "SELECT name, nature, is_active FROM payment_methods WHERE wallet_id = $1 ORDER BY name_normalized",
      [walletA.id],
    );
    assert.deepEqual(
      defaults.rows.map(({ name, nature, is_active }) => ({ name, nature, is_active })),
      [
        { name: "Auxílio Home Office", nature: "home_office_benefit", is_active: true },
        { name: "Crédito", nature: "credit_card", is_active: true },
        { name: "Débito", nature: "immediate", is_active: true },
        { name: "Pix", nature: "immediate", is_active: true },
        { name: "Vale-Alimentação", nature: "food_benefit", is_active: true },
        { name: "Vale-Refeição", nature: "meal_benefit", is_active: true },
      ],
    );
    assert.equal((await database.query("SELECT count(*) FROM payment_methods WHERE wallet_id = $1", [walletB.id])).rows[0]?.count, "6");

    const repository = new PostgresPaymentMethodsRepository(database);
    const listedMethods = await repository.list(users[0]!, walletA.id);
    assert.equal(listedMethods.length, 6);
    assert.equal(listedMethods.find((item) => item.name === "Crédito")?.nature, "credit_card");
    const customMethod = await repository.create(users[0]!, walletA.id, "Conta corrente", "immediate");
    assert.equal(customMethod.isActive, true);
    const renamedMethod = await repository.update(users[0]!, walletA.id, customMethod.id, { name: "Conta principal", isActive: false });
    assert.deepEqual(renamedMethod, { ...customMethod, name: "Conta principal", isActive: false });

    const credit = await database.query<{ id: string }>(
      "SELECT id FROM payment_methods WHERE wallet_id = $1 AND name_normalized = 'credito'",
      [walletA.id],
    );
    await assert.rejects(
      database.query("INSERT INTO payment_methods (wallet_id, name, nature) VALUES ($1, 'CRÉDITO', 'credit_card')", [walletA.id]),
      { code: "23505" },
    );

    const walletACustom = await database.query<{ id: string }>(
      "INSERT INTO payment_methods (wallet_id, name, nature) VALUES ($1, 'Carteira', 'immediate') RETURNING id",
      [walletA.id],
    );
    const walletBCustom = await database.query<{ id: string }>(
      "INSERT INTO payment_methods (wallet_id, name, nature) VALUES ($1, 'Carteira', 'immediate') RETURNING id",
      [walletB.id],
    );
    assert.notEqual(walletACustom.rows[0]?.id, walletBCustom.rows[0]?.id);

    const foodBenefit = await database.query<{ id: string; nature: string }>(
      `INSERT INTO payment_methods (wallet_id, name, nature)
       VALUES ($1, 'Benefício customizado', 'food_benefit') RETURNING id, nature`,
      [walletA.id],
    );
    assert.equal(foodBenefit.rows[0]?.nature, "food_benefit");
    await assert.rejects(
      database.query("INSERT INTO payment_methods (wallet_id, name, nature) VALUES ($1, 'Invalid nature', 'invalid')", [walletA.id]),
      { code: "23514" },
    );

    await database.query("UPDATE payment_methods SET is_active = false WHERE id = $1", [credit.rows[0]?.id]);
    const deactivated = await database.query<{ is_active: boolean }>(
      "SELECT is_active FROM payment_methods WHERE id = $1",
      [credit.rows[0]?.id],
    );
    assert.equal(deactivated.rows[0]?.is_active, false);

    const categoryA = await database.query<{ id: string }>(
      "INSERT INTO categories (user_id, wallet_id, name, nature) VALUES ($1, $2, 'Housing', 'expense') RETURNING id",
      [users[0], walletA.id],
    );
    await assert.rejects(
      database.query(
        `INSERT INTO expenses (user_id, wallet_id, category_id, payment_method_id, amount, date)
         VALUES ($1, $2, $3, $4, 12.34, '2026-10-20')`,
        [users[0], walletA.id, categoryA.rows[0]?.id, walletBCustom.rows[0]?.id],
      ),
      { code: "23503" },
    );

    const newWallet = await database.query<{ id: string }>(
      "INSERT INTO wallets (owner_user_id, name, is_personal) VALUES ($1, 'Second wallet', false) RETURNING id",
      [users[0]],
    );
    assert.equal(
      (await database.query("SELECT count(*) FROM payment_methods WHERE wallet_id = $1", [newWallet.rows[0]?.id])).rows[0]?.count,
      "6",
    );
  } finally {
    await scopedPool?.end();
    await adminPool.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
    await adminPool.end();
  }
});
