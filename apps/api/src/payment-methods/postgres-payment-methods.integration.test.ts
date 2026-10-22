import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { createDatabase } from "../database.js";
import { PostgresExpensesRepository } from "../expenses/postgres-expenses.repository.js";
import { PostgresFinancialSummaryRepository } from "../financial-summary/postgres-financial-summary.repository.js";
import { PostgresPaymentMethodsRepository } from "./postgres-payment-methods.repository.js";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

for (const collision of [
  { label: "active immediate", nature: "immediate", isActive: true, cashBalance: "92.50", benefitBalance: "295.00", updatedBenefitBalance: "290.00" },
  { label: "inactive legacy benefit", nature: "meal_benefit", isActive: false, cashBalance: "100.00", benefitBalance: "287.50", updatedBenefitBalance: "282.50" },
]) {
  test(`unified benefit migration preserves colliding ${collision.label} methods and their history`, {
    skip: !testDatabaseUrl,
  }, async () => {
    const schemaName = `benefit_collision_${randomBytes(8).toString("hex")}`;
    const adminPool = new Pool({ connectionString: testDatabaseUrl });
    let scopedPool: Pool | undefined;

    try {
      await adminPool.query(`CREATE SCHEMA ${schemaName}`);
      scopedPool = new Pool({ connectionString: testDatabaseUrl, options: `-c search_path=${schemaName}` });
      const database = createDatabase(scopedPool);
      const migrationDirectory = fileURLToPath(new URL("../../migrations/", import.meta.url));
      const unifiedVersion = "013_unified_benefit_balance.sql";
      const earlierVersions = (await readdir(migrationDirectory))
        .filter((version) => /^\d+_[a-z0-9_-]+\.sql$/i.test(version) && version < unifiedVersion)
        .sort();
      for (const version of earlierVersions) {
        const sql = await readFile(join(migrationDirectory, version), "utf8");
        await database.transaction(async (transaction) => { await transaction.query(sql); });
      }

      const user = await database.query<{ id: string }>(
        "INSERT INTO users (email, password_hash, email_verified_at) VALUES ($1, 'test-hash', now()) RETURNING id",
        [`benefit-${schemaName}@example.com`],
      );
      const userId = user.rows[0]!.id;
      const wallet = await database.query<{ id: string }>(
        "SELECT id FROM wallets WHERE owner_user_id = $1 AND is_personal", [userId],
      );
      const walletId = wallet.rows[0]!.id;
      const otherWallet = await database.query<{ id: string }>(
        "INSERT INTO wallets (owner_user_id, name, is_personal) VALUES ($1, 'Other wallet', false) RETURNING id", [userId],
      );
      const categories = await database.query<{ id: string; nature: string }>(
        `INSERT INTO categories (user_id, wallet_id, name, nature)
         VALUES ($1, $2, 'Benefits', 'income'), ($1, $2, 'Food', 'expense') RETURNING id, nature`,
        [userId, walletId],
      );
      const incomeCategoryId = categories.rows.find((category) => category.nature === "income")!.id;
      const expenseCategoryId = categories.rows.find((category) => category.nature === "expense")!.id;
      const customMethods = await database.query<{ id: string; name: string }>(
        `INSERT INTO payment_methods (wallet_id, name, nature, is_active)
         SELECT $1, name, $2, $3 FROM unnest($4::text[]) AS names(name) RETURNING id, name`,
        [walletId, collision.nature, collision.isActive, [
          "CARTAO DE BENEFICIOS (VA/VR)",
          "Cartão de benefícios (VA/VR) (1)",
          "Cartão de benefícios (VA/VR) (2)",
        ]],
      );
      const customMethodIds = customMethods.rows.map((method) => method.id);
      const customMethodId = customMethods.rows.find((method) => method.name === "CARTAO DE BENEFICIOS (VA/VR)")!.id;
      await database.query(
        `INSERT INTO incomes (user_id, wallet_id, category_id, amount, date, balance_type)
         VALUES ($1, $2, $3, '150.00', '2026-10-12', 'food_benefit'),
                ($1, $2, $3, '200.00', '2026-10-13', 'meal_benefit'),
                ($1, $2, $3, '100.00', '2026-10-13', 'cash'),
                ($1, $2, $3, '30.00', '2026-10-13', 'home_office_benefit')`,
        [userId, walletId, incomeCategoryId],
      );
      await database.query(
        `INSERT INTO expenses (user_id, wallet_id, category_id, payment_method_id, payment_method_nature, amount, date)
         SELECT $1, $2, $3, method.id, method.nature, amounts.amount, '2026-10-14'
         FROM (VALUES ('Vale-Alimentação', '20.00'::numeric), ('Vale-Refeição', '35.00'::numeric)) AS amounts(name, amount)
         JOIN payment_methods AS method ON method.wallet_id = $2 AND method.name = amounts.name`,
        [userId, walletId, expenseCategoryId],
      );
      await database.query(
        `INSERT INTO expenses (user_id, wallet_id, category_id, payment_method_id, payment_method_nature, amount, date)
         VALUES ($1, $2, $3, $4, $5, 7.50, '2026-10-14')`,
        [userId, walletId, expenseCategoryId, customMethodId, collision.nature],
      );
      const methodsBefore = await database.query("SELECT * FROM payment_methods WHERE id = ANY($1::uuid[]) ORDER BY id", [customMethodIds]);
      const incomesBefore = await database.query("SELECT * FROM incomes WHERE wallet_id = $1 ORDER BY id", [walletId]);
      const expensesBefore = await database.query("SELECT * FROM expenses WHERE wallet_id = $1 ORDER BY id", [walletId]);

      const migration = await readFile(join(migrationDirectory, unifiedVersion), "utf8");
      await database.transaction(async (transaction) => { await transaction.query(migration); });

      assert.deepEqual((await database.query("SELECT * FROM payment_methods WHERE id = ANY($1::uuid[]) ORDER BY id", [customMethodIds])).rows, methodsBefore.rows);
      assert.deepEqual((await database.query("SELECT * FROM incomes WHERE wallet_id = $1 ORDER BY id", [walletId])).rows, incomesBefore.rows);
      assert.deepEqual((await database.query("SELECT * FROM expenses WHERE wallet_id = $1 ORDER BY id", [walletId])).rows, expensesBefore.rows);
      const activeBenefits = await database.query<{ id: string; name: string }>(
        "SELECT id, name FROM payment_methods WHERE wallet_id = $1 AND nature = 'food_meal_benefit' AND is_active", [walletId],
      );
      assert.equal(activeBenefits.rows.length, 1, "a name collision must not suppress the active unified benefit method");
      assert.equal(activeBenefits.rows[0]!.name, "Cartão de benefícios (VA/VR) (3)");
      assert.deepEqual((await database.query(
        "SELECT name FROM payment_methods WHERE wallet_id = $1 AND nature = 'food_meal_benefit' AND is_active", [otherWallet.rows[0]!.id],
      )).rows, [{ name: "Cartão de benefícios (VA/VR)" }]);
      const methodsAfter = await database.query("SELECT * FROM payment_methods WHERE wallet_id = $1 ORDER BY id", [walletId]);
      await database.transaction(async (transaction) => { await transaction.query(migration); });
      assert.deepEqual((await database.query("SELECT * FROM payment_methods WHERE wallet_id = $1 ORDER BY id", [walletId])).rows, methodsAfter.rows);
      const summaryRepository = new PostgresFinancialSummaryRepository(database);
      const beforeNewExpense = await summaryRepository.getSummary(walletId);
      assert.equal(beforeNewExpense.cashBalance, collision.cashBalance);
      assert.deepEqual(beforeNewExpense.benefitBalances, [
        { balanceType: "food_meal_benefit", amount: collision.benefitBalance },
        { balanceType: "home_office_benefit", amount: "30.00" },
      ]);
      const expense = await new PostgresExpensesRepository(database).createExpense(userId, walletId, {
        amount: "5.00", date: "2026-10-15", description: null, categoryId: expenseCategoryId,
        subcategoryId: null, paymentMethodId: activeBenefits.rows[0]!.id, creditCardId: null,
      });
      assert.equal(expense?.paymentMethodNature, "food_meal_benefit");
      const afterNewExpense = await summaryRepository.getSummary(walletId);
      assert.equal(afterNewExpense.cashBalance, collision.cashBalance);
      assert.deepEqual(afterNewExpense.benefitBalances, [
        { balanceType: "food_meal_benefit", amount: collision.updatedBenefitBalance },
        { balanceType: "home_office_benefit", amount: "30.00" },
      ]);
    } finally {
      await scopedPool?.end();
      await adminPool.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
      await adminPool.end();
    }
  });
}

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
    for (const version of ["011_income_balance_type.sql", "012_expense_payment_method_nature_snapshot.sql", "013_credit_cards_and_statements.sql"]) {
      const sql = await readFile(join(migrationDirectory, version), "utf8");
      await database.transaction(async (transaction) => {
        await transaction.query(sql);
        await transaction.query("INSERT INTO schema_migrations (version) VALUES ($1)", [version]);
      });
    }

    const wallets = await database.query<{ id: string; owner_user_id: string }>(
      "SELECT id, owner_user_id FROM wallets WHERE owner_user_id = ANY($1::uuid[]) ORDER BY owner_user_id",
      [users],
    );
    assert.equal(wallets.rows.length, 2);
    const walletA = wallets.rows.find((wallet) => wallet.owner_user_id === users[0])!;
    const walletB = wallets.rows.find((wallet) => wallet.owner_user_id === users[1])!;

    const categories = await database.query<{ id: string; nature: string }>(
      `INSERT INTO categories (user_id, wallet_id, name, nature)
       VALUES ($1, $2, 'Legacy income', 'income'), ($1, $2, 'Legacy expense', 'expense')
       RETURNING id, nature`,
      [users[0], walletA.id],
    );
    const incomeCategoryId = categories.rows.find((category) => category.nature === "income")!.id;
    const expenseCategoryId = categories.rows.find((category) => category.nature === "expense")!.id;
    await database.query(
      `INSERT INTO incomes (user_id, wallet_id, category_id, amount, date, description, balance_type)
       VALUES ($1, $2, $3, '150.00', '2026-10-12', 'Legacy VA income', 'food_benefit'),
              ($1, $2, $3, '200.00', '2026-10-13', 'Legacy VR income', 'meal_benefit')`,
      [users[0], walletA.id, incomeCategoryId],
    );
    await database.query(
      `INSERT INTO expenses (user_id, wallet_id, category_id, payment_method_id, payment_method_nature, amount, date, description)
       SELECT $1, $2, $3, method.id, method.nature, amounts.amount, '2026-10-14', amounts.description
       FROM (VALUES ('Vale-Alimentação', '20.00'::numeric, 'Legacy VA expense'),
                    ('Vale-Refeição', '35.00'::numeric, 'Legacy VR expense')) AS amounts(name, amount, description)
       JOIN payment_methods AS method ON method.wallet_id = $2 AND method.name = amounts.name`,
      [users[0], walletA.id, expenseCategoryId],
    );

    const unifiedMigration = await readFile(join(migrationDirectory, "013_unified_benefit_balance.sql"), "utf8");
    await database.transaction(async (transaction) => {
      await transaction.query(unifiedMigration);
      await transaction.query("INSERT INTO schema_migrations (version) VALUES ('013_unified_benefit_balance.sql')");
    });

    const historicalIncomes = await database.query<{ amount: string; balance_type: string }>(
      "SELECT amount::text, balance_type FROM incomes WHERE wallet_id = $1 ORDER BY description",
      [walletA.id],
    );
    assert.deepEqual(historicalIncomes.rows, [
      { amount: "150.00", balance_type: "food_benefit" },
      { amount: "200.00", balance_type: "meal_benefit" },
    ]);
    const historicalExpenses = await database.query<{ amount: string; payment_method_nature: string }>(
      "SELECT amount::text, payment_method_nature FROM expenses WHERE wallet_id = $1 ORDER BY description",
      [walletA.id],
    );
    assert.deepEqual(historicalExpenses.rows, [
      { amount: "20.00", payment_method_nature: "food_benefit" },
      { amount: "35.00", payment_method_nature: "meal_benefit" },
    ]);
    const summary = await new PostgresFinancialSummaryRepository(database).getSummary(walletA.id);
    assert.deepEqual(summary.benefitBalances, [
      { balanceType: "food_meal_benefit", amount: "295.00" },
      { balanceType: "home_office_benefit", amount: "0.00" },
    ]);

    const defaults = await database.query<{ name: string; nature: string; is_active: boolean }>(
      "SELECT name, nature, is_active FROM payment_methods WHERE wallet_id = $1 ORDER BY name_normalized",
      [walletA.id],
    );
    assert.deepEqual(
      defaults.rows.map(({ name, nature, is_active }) => ({ name, nature, is_active })),
      [
        { name: "Auxílio Home Office", nature: "home_office_benefit", is_active: true },
        { name: "Cartão de benefícios (VA/VR)", nature: "food_meal_benefit", is_active: true },
        { name: "Crédito", nature: "credit_card", is_active: true },
        { name: "Débito", nature: "immediate", is_active: true },
        { name: "Pix", nature: "immediate", is_active: true },
        { name: "Vale-Alimentação", nature: "food_meal_benefit", is_active: false },
        { name: "Vale-Refeição", nature: "food_meal_benefit", is_active: false },
      ],
    );
    assert.equal((await database.query("SELECT count(*) FROM payment_methods WHERE wallet_id = $1", [walletB.id])).rows[0]?.count, "7");

    const repository = new PostgresPaymentMethodsRepository(database);
    const listedMethods = await repository.list(users[0]!, walletA.id);
    assert.equal(listedMethods.length, 7);
    assert.equal(listedMethods.find((item) => item.name === "Crédito")?.nature, "credit_card");
    assert.equal(listedMethods.find((item) => item.name === "Cartão de benefícios (VA/VR)")?.isActive, true);
    assert.equal(listedMethods.find((item) => item.name === "Vale-Refeição")?.isActive, false);
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
      "5",
    );
  } finally {
    await scopedPool?.end();
    await adminPool.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
    await adminPool.end();
  }
});
