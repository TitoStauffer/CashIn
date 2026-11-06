import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { Pool } from "pg";
import { createApp } from "../app.js";
import { PostgresAuthRepository } from "../auth/postgres-auth.repository.js";
import { createOpaqueToken, hashToken } from "../auth/token.js";
import { createDatabase, runMigrations } from "../database.js";
import { PostgresFinancialCategorizationRulesRepository } from "./postgres-financial-categorization-rules.repository.js";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

const csvConfiguration = {
  delimiter: ";",
  encoding: "utf-8",
  hasHeader: true,
  dateFormat: "dd/MM/yyyy",
  numberFormat: "pt-BR",
  columns: { date: 0, description: 1, amount: 2, credit: null, debit: null, externalId: null },
};

test("PostgreSQL categorization rules are shared by wallet members, applied to previews, and survive removed categories", {
  skip: !testDatabaseUrl,
}, async () => {
  const schemaName = `categorization_rules_${randomBytes(8).toString("hex")}`;
  const adminPool = new Pool({ connectionString: testDatabaseUrl });
  let scopedPool: Pool | undefined;
  let app: ReturnType<typeof createApp> | undefined;

  try {
    await adminPool.query(`CREATE SCHEMA ${schemaName}`);
    scopedPool = new Pool({ connectionString: testDatabaseUrl, options: `-c search_path=${schemaName}` });
    const database = createDatabase(scopedPool);
    await runMigrations(database);
    const repository = new PostgresFinancialCategorizationRulesRepository(database);

    const users = await database.query<{ id: string; email: string }>(
      `INSERT INTO users (email, password_hash, email_verified_at)
       VALUES ($1, 'test-hash', now()), ($2, 'test-hash', now())
       RETURNING id, email`,
      [`owner-${schemaName}@example.com`, `member-${schemaName}@example.com`],
    );
    const ownerId = users.rows.find((row) => row.email.startsWith("owner-"))!.id;
    const memberId = users.rows.find((row) => row.email.startsWith("member-"))!.id;
    const wallets = await database.query<{ id: string; owner_user_id: string }>(
      "SELECT id, owner_user_id FROM wallets WHERE owner_user_id = ANY($1::uuid[])",
      [[ownerId, memberId]],
    );
    const walletId = wallets.rows.find((row) => row.owner_user_id === ownerId)!.id;
    const memberWalletId = wallets.rows.find((row) => row.owner_user_id === memberId)!.id;
    await database.query("INSERT INTO wallet_members (wallet_id, user_id, role) VALUES ($1, $2, 'member')", [walletId, memberId]);

    const categories = await database.query<{ id: string; name: string }>(
      `INSERT INTO categories (user_id, wallet_id, name, nature)
       VALUES ($1, $2, 'Alimentação', 'expense'), ($1, $2, 'Transporte', 'expense'), ($1, $2, 'Salário', 'income')
       RETURNING id, name`,
      [ownerId, walletId],
    );
    const foodId = categories.rows.find((row) => row.name === "Alimentação")!.id;
    const transportId = categories.rows.find((row) => row.name === "Transporte")!.id;
    const salaryId = categories.rows.find((row) => row.name === "Salário")!.id;
    const subcategories = await database.query<{ id: string }>(
      "INSERT INTO subcategories (user_id, category_id, wallet_id, name) VALUES ($1, $2, $3, 'Mercado') RETURNING id",
      [ownerId, foodId, walletId],
    );
    const marketId = subcategories.rows[0]!.id;

    // Reference validation: category must belong to the wallet, match the type, and own the subcategory.
    assert.equal(await repository.createRule(ownerId, walletId, {
      type: "income", description: "Mercado", normalizedDescription: "mercado", categoryId: foodId,
    }), null);
    assert.equal(await repository.createRule(ownerId, memberWalletId, {
      type: "expense", description: "Mercado", normalizedDescription: "mercado", categoryId: foodId,
    }), null);
    assert.equal(await repository.createRule(ownerId, walletId, {
      type: "expense", description: "Mercado", normalizedDescription: "mercado", categoryId: transportId, subcategoryId: marketId,
    }), null);

    const marketRule = await repository.createRule(ownerId, walletId, {
      type: "expense", description: "Mercado Bom Preço", normalizedDescription: "mercado bom preço", categoryId: foodId, subcategoryId: marketId,
    });
    assert.equal(marketRule?.categoryName, "Alimentação");
    assert.equal(marketRule?.subcategoryName, "Mercado");
    assert.equal(marketRule?.isStale, false);
    await assert.rejects(
      repository.createRule(memberId, walletId, {
        type: "expense", description: "MERCADO BOM PREÇO", normalizedDescription: "mercado bom preço", categoryId: transportId,
      }),
      /financial_import_rules_wallet_type_description_key/,
    );
    const busRule = await repository.createRule(memberId, walletId, {
      type: "expense", description: "Ônibus", normalizedDescription: "ônibus", categoryId: transportId,
    });
    assert.ok(busRule);
    assert.deepEqual((await repository.listRules(memberWalletId)), []);
    assert.equal(await repository.deleteRule(memberWalletId, busRule.id), false);

    const sessionToken = createOpaqueToken();
    await new PostgresAuthRepository(database).createSession(memberId, hashToken(sessionToken), new Date(Date.now() + 60_000));
    app = createApp(database);
    await app.ready();
    const headers = { cookie: `cashin_session=${sessionToken}`, "x-wallet-id": walletId };

    const listed = await app.inject({ method: "GET", url: "/financial-imports/rules", headers });
    assert.equal(listed.statusCode, 200);
    assert.deepEqual(listed.json().items.map((rule: { description: string }) => rule.description).sort(), ["Mercado Bom Preço", "Ônibus"]);

    const salaryRule = await app.inject({
      method: "POST", url: "/financial-imports/rules", headers,
      payload: { type: "income", description: "Empresa XPTO", categoryId: salaryId },
    });
    assert.equal(salaryRule.statusCode, 201);

    const upload = await app.inject({
      method: "POST", url: "/financial-imports",
      headers: {
        ...headers,
        "content-type": "application/octet-stream",
        "x-file-name": "extrato.csv",
        "x-file-format": "csv",
        "x-csv-mapping": encodeURIComponent(JSON.stringify(csvConfiguration)),
      },
      payload: Buffer.from(
        "Data;Descrição;Valor\n"
        + "01/11/2026;  mercado   BOM preço ;-45,90\n"
        + "02/11/2026;Ônibus;-4,40\n"
        + "03/11/2026;Ônibus;4,40\n"
        + "05/11/2026;Empresa XPTO;3000,00\n"
        + "06/11/2026;Padaria;-12,00\n",
      ),
    });
    assert.equal(upload.statusCode, 201);
    const preview = await app.inject({ method: "GET", url: `/financial-imports/${upload.json().id}`, headers });
    const items = preview.json().items as Array<{ id: string; sequence: number; description: string; type: string; categoryId: string | null; subcategoryId: string | null; validationStatus: string; categorizationSource: string | null }>;
    const bySequence = (sequence: number) => items.find((item) => item.sequence === sequence)!;
    assert.equal(bySequence(1).categoryId, foodId);
    assert.equal(bySequence(1).subcategoryId, marketId);
    assert.equal(bySequence(1).validationStatus, "valid");
    assert.equal(bySequence(1).categorizationSource, "rule");
    assert.equal(bySequence(2).categoryId, transportId);
    assert.equal(bySequence(3).categoryId, null, "rules only match the same movement type");
    assert.equal(bySequence(3).validationStatus, "uncategorized");
    assert.equal(bySequence(4).categoryId, salaryId);
    assert.equal(bySequence(5).categoryId, null);
    assert.equal(bySequence(5).categorizationSource, null);

    const importUrl = `/financial-imports/${upload.json().id}/items`;
    const keptRule = await app.inject({
      method: "PATCH", url: `${importUrl}/${bySequence(1).id}`, headers,
      payload: { date: "2026-11-01", description: bySequence(1).description, type: "expense", categoryId: foodId, subcategoryId: marketId },
    });
    assert.equal(keptRule.statusCode, 200);
    assert.equal(keptRule.json().categorizationSource, "rule", "saving a suggestion unchanged keeps its origin");
    const changedChoice = await app.inject({
      method: "PATCH", url: `${importUrl}/${bySequence(2).id}`, headers,
      payload: { date: "2026-11-02", description: "Ônibus", type: "expense", categoryId: foodId, subcategoryId: null },
    });
    assert.equal(changedChoice.json().categorizationSource, "manual");
    const manualChoice = await app.inject({
      method: "PATCH", url: `${importUrl}/${bySequence(5).id}`, headers,
      payload: { date: "2026-11-06", description: "Padaria", type: "expense", categoryId: foodId, subcategoryId: null },
    });
    assert.equal(manualChoice.json().categorizationSource, "manual");
    const cleared = await app.inject({
      method: "PATCH", url: `${importUrl}/${bySequence(5).id}`, headers,
      payload: { date: "2026-11-06", description: "Padaria", type: "expense", categoryId: null, subcategoryId: null },
    });
    assert.equal(cleared.json().categorizationSource, null);
    const discarded = await app.inject({ method: "DELETE", url: `/financial-imports/${upload.json().id}`, headers });
    assert.equal(discarded.statusCode, 200);

    // Removed references keep the rule visible as stale and stop it from classifying new items.
    await database.query("DELETE FROM subcategories WHERE id = $1", [marketId]);
    await database.query("DELETE FROM categories WHERE id = $1", [transportId]);
    const afterRemoval = await repository.listRules(walletId);
    assert.equal(afterRemoval.find((rule) => rule.id === marketRule!.id)?.isStale, true);
    const staleBus = afterRemoval.find((rule) => rule.id === busRule.id);
    assert.equal(staleBus?.isStale, true);
    assert.equal(staleBus?.categoryName, null);

    const staleUpload = await app.inject({
      method: "POST", url: "/financial-imports",
      headers: {
        ...headers,
        "content-type": "application/octet-stream",
        "x-file-name": "extrato-2.csv",
        "x-file-format": "csv",
        "x-csv-mapping": encodeURIComponent(JSON.stringify(csvConfiguration)),
      },
      payload: Buffer.from("Data;Descrição;Valor\n10/11/2026;Ônibus;-4,40\n10/11/2026;Mercado Bom Preço;-20,00\n"),
    });
    assert.equal(staleUpload.statusCode, 201);
    const staleItems = (await app.inject({ method: "GET", url: `/financial-imports/${staleUpload.json().id}`, headers })).json().items;
    assert.deepEqual(staleItems.map((item: { categoryId: string | null }) => item.categoryId), [null, null]);

    const reclassified = await app.inject({
      method: "PATCH", url: `/financial-imports/rules/${busRule.id}`, headers,
      payload: { type: "expense", description: "Ônibus", categoryId: foodId, subcategoryId: null, isActive: true },
    });
    assert.equal(reclassified.statusCode, 200);
    assert.equal(reclassified.json().isStale, false);
    assert.equal(reclassified.json().categoryName, "Alimentação");

    const deleted = await app.inject({ method: "DELETE", url: `/financial-imports/rules/${busRule.id}`, headers });
    assert.equal(deleted.statusCode, 204);
    assert.equal((await repository.listRules(walletId)).some((rule) => rule.id === busRule.id), false);
  } finally {
    await app?.close();
    await scopedPool?.end();
    await adminPool.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
    await adminPool.end();
  }
});
