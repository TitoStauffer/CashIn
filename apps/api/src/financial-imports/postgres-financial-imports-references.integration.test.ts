import assert from "node:assert/strict";
import { createApp } from "../app.js";
import { financialImportScenarioTest } from "./financial-imports-integration-test-fixture.js";

financialImportScenarioTest("PostgreSQL financial import refuses category and subcategory references that do not belong to the line", async (scenario) => {
  const { database, repository, userId, otherUserId, walletId, otherWalletId, categories, incomeCategoryId, expenseCategoryId, authenticatedHeaders, csvMappingHeader } = scenario;
  let app = scenario.app;
  const crossWalletCategory = await database.query<{ id: string }>(
    `INSERT INTO categories (user_id, wallet_id, name, nature)
     VALUES ($1, $2, 'Categoria externa', 'income') RETURNING id`,
    [otherUserId, otherWalletId],
  );
  const incompatibleSubcategory = await database.query<{ id: string }>(
    `INSERT INTO subcategories (user_id, wallet_id, category_id, name)
     VALUES ($1, $2, $3, 'Subcategoria incompatível') RETURNING id`,
    [userId, walletId, expenseCategoryId],
  );
  await app.close();
  app = createApp(database, {
    financialImportRepository: repository,
    financialImportParser: {
      parse: async () => [
        {
          sequence: 1,
          date: "2026-10-25",
          description: "Referência válida",
          signedAmount: "40.00",
          type: "income",
          categoryId: incomeCategoryId,
        },
        {
          sequence: 2,
          date: "2026-10-25",
          description: "Categoria inexistente",
          signedAmount: "1.00",
          type: "income",
          categoryId: "33333333-3333-4333-8333-333333333333",
          validationStatus: "invalid",
          errorMessage: "Inválida pelo parser.",
        },
        {
          sequence: 3,
          date: "2026-10-25",
          description: "Categoria de outra carteira",
          signedAmount: "2.00",
          type: "income",
          categoryId: crossWalletCategory.rows[0]!.id,
        },
        {
          sequence: 4,
          date: "2026-10-25",
          description: "Categoria de outra natureza",
          signedAmount: "3.00",
          type: "income",
          categoryId: expenseCategoryId,
        },
        {
          sequence: 5,
          date: "2026-10-25",
          description: "Subcategoria incompatível",
          signedAmount: "4.00",
          type: "income",
          categoryId: incomeCategoryId,
          subcategoryId: incompatibleSubcategory.rows[0]!.id,
        },
      ],
    },
  });
  await app.ready();
  scenario.app = app;
  const invalidReferences = await app.inject({
    method: "POST",
    url: "/financial-imports",
    headers: {
      ...authenticatedHeaders,
      "content-type": "application/octet-stream",
      "x-file-name": "references.csv",
      "x-file-format": "csv",
      "x-csv-mapping": csvMappingHeader,
    },
    payload: Buffer.from("reference-test"),
  });
  assert.equal(invalidReferences.statusCode, 201);
  assert.deepEqual(invalidReferences.json().summary, {
    total: 5,
    valid: 1,
    duplicate: 0,
    invalid: 4,
    uncategorized: 0,
    imported: 0,
  });
  assert.equal(invalidReferences.json().items.length, 5);
  for (const invalidItem of invalidReferences.json().items.slice(1, 4)) {
    assert.equal(invalidItem.validationStatus, "invalid");
    assert.equal(invalidItem.categoryId, null);
    assert.equal(invalidItem.subcategoryId, null);
    assert.match(invalidItem.errorMessage, /categoria informada não existe nesta carteira|não corresponde ao tipo/i);
  }
  assert.match(invalidReferences.json().items[1].errorMessage, /Inválida pelo parser/);
  assert.equal(invalidReferences.json().items[4].validationStatus, "invalid");
  assert.equal(invalidReferences.json().items[4].categoryId, incomeCategoryId);
  assert.equal(invalidReferences.json().items[4].subcategoryId, null);
  assert.match(invalidReferences.json().items[4].errorMessage, /subcategoria informada não pertence/i);

  const confirmedReferences = await app.inject({
    method: "POST",
    url: `/financial-imports/${invalidReferences.json().id}/confirm`,
    headers: authenticatedHeaders,
  });
  assert.equal(confirmedReferences.statusCode, 200);
  assert.equal(confirmedReferences.json().summary.imported, 1);
  assert.equal(confirmedReferences.json().summary.invalid, 4);
  assert.equal(
    (await database.query(
      "SELECT count(*)::integer AS count FROM incomes WHERE wallet_id = $1 AND description = 'Referência válida'",
      [walletId],
    )).rows[0]!.count,
    1,
  );
});
