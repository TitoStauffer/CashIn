import assert from "node:assert/strict";
import { createApp } from "../app.js";
import { financialImportScenarioTest } from "./financial-imports-integration-test-fixture.js";

financialImportScenarioTest("PostgreSQL financial import keeps duplicates and PostgreSQL-incompatible lines out and confirms a 10,000-line batch", async (scenario) => {
  const { database, repository, userId, walletId, incomeCategoryId, authenticatedHeaders, csvMappingHeader } = scenario;
  let app = scenario.app;
  await app.close();
  app = createApp(database, {
    financialImportRepository: repository,
    financialImportParser: {
      parse: async () => [
        {
          sequence: 1,
          date: "2026-10-25",
          description: "Linha permitida da regressão",
          signedAmount: "50.00",
          type: "income",
          categoryId: incomeCategoryId,
        },
        {
          sequence: 2,
          date: "2026-02-30",
          description: "Duplicidade com data inválida",
          signedAmount: "51.00",
          type: "income",
          categoryId: incomeCategoryId,
          validationStatus: "duplicate",
          errorMessage: "A movimentação já existe.",
        },
        {
          sequence: 3,
          date: "2026-10-25",
          description: "Duplicidade com categoria inexistente",
          signedAmount: "52.00",
          type: "income",
          categoryId: "44444444-4444-4444-8444-444444444444",
          validationStatus: "duplicate",
          errorMessage: "A movimentação já existe.",
        },
        {
          sequence: 4,
          date: "2026-02-30",
          description: "Invalidação permanente do parser",
          signedAmount: "53.00",
          type: "income",
          categoryId: incomeCategoryId,
          validationStatus: "invalid",
          errorMessage: "A origem não permite importar esta movimentação.",
          isRepairable: false,
        },
        {
          sequence: 5,
          date: "0000-01-01",
          description: "Ano incompatível com PostgreSQL",
          signedAmount: "54.00",
          type: "income",
          categoryId: incomeCategoryId,
        },
        {
          sequence: 6,
          date: "2026-10-25",
          description: "Descrição\u0000incompatível",
          signedAmount: "55.00",
          type: "income",
          categoryId: incomeCategoryId,
        },
      ],
    },
  });
  await app.ready();
  scenario.app = app;
  const duplicatePreview = await app.inject({
    method: "POST",
    url: "/financial-imports",
    headers: {
      ...authenticatedHeaders,
      "content-type": "application/octet-stream",
      "x-file-name": "duplicates.csv",
      "x-file-format": "csv",
      "x-csv-mapping": csvMappingHeader,
    },
    payload: Buffer.from("duplicate-regression"),
  });
  assert.equal(duplicatePreview.statusCode, 201);
  assert.deepEqual(duplicatePreview.json().summary, {
    total: 6,
    valid: 1,
    duplicate: 2,
    invalid: 3,
    uncategorized: 0,
    imported: 0,
  });
  const duplicateItems = duplicatePreview.json().items.filter(
    (item: { validationStatus: string }) => item.validationStatus === "duplicate",
  );
  for (const duplicateItem of duplicateItems) {
    assert.equal(duplicateItem.validationStatus, "duplicate");
    assert.equal(duplicateItem.canEdit, false);
    const patchDuplicateStatus: number = (await app.inject({
      method: "PATCH",
      url: `/financial-imports/${duplicatePreview.json().id}/items/${duplicateItem.id}`,
      headers: authenticatedHeaders,
      payload: {
        date: "2026-10-25",
        description: duplicateItem.description,
        type: "income",
        categoryId: incomeCategoryId,
        subcategoryId: null,
      },
    })).statusCode;
    assert.equal(patchDuplicateStatus, 409);
  }
  assert.match(duplicateItems[0].errorMessage, /data da movimentação é inválida/i);
  assert.match(duplicateItems[1].errorMessage, /categoria informada não existe nesta carteira/i);
  const parserInvalidItem = duplicatePreview.json().items.find(
    (item: { description: string }) => item.description === "Invalidação permanente do parser",
  );
  assert.ok(parserInvalidItem);
  assert.equal(parserInvalidItem.validationStatus, "invalid");
  assert.equal(parserInvalidItem.canEdit, false);
  assert.match(parserInvalidItem.errorMessage, /origem não permite importar/i);
  assert.match(parserInvalidItem.errorMessage, /data da movimentação é inválida/i);
  const patchParserInvalidStatus: number = (await app.inject({
    method: "PATCH",
    url: `/financial-imports/${duplicatePreview.json().id}/items/${parserInvalidItem.id}`,
    headers: authenticatedHeaders,
    payload: {
      date: "2026-10-25",
      description: parserInvalidItem.description,
      type: "income",
      categoryId: incomeCategoryId,
      subcategoryId: null,
    },
  })).statusCode;
  assert.equal(patchParserInvalidStatus, 409);
  const postgresInvalidDateItem = duplicatePreview.json().items.find(
    (item: { description: string }) => item.description === "Ano incompatível com PostgreSQL",
  );
  assert.ok(postgresInvalidDateItem);
  assert.equal(postgresInvalidDateItem.date, "");
  assert.equal(postgresInvalidDateItem.validationStatus, "invalid");
  assert.equal(postgresInvalidDateItem.canEdit, true);
  assert.match(postgresInvalidDateItem.errorMessage, /data da movimentação é inválida/i);
  const patchPostgresInvalidDateStatus: number = (await app.inject({
    method: "PATCH",
    url: `/financial-imports/${duplicatePreview.json().id}/items/${postgresInvalidDateItem.id}`,
    headers: authenticatedHeaders,
    payload: {
      date: "0000-01-01",
      description: postgresInvalidDateItem.description,
      type: "income",
      categoryId: incomeCategoryId,
      subcategoryId: null,
    },
  })).statusCode;
  assert.equal(patchPostgresInvalidDateStatus, 400);

  const postgresInvalidDescriptionItem = duplicatePreview.json().items.find(
    (item: { amount: string }) => item.amount === "55.00",
  );
  assert.ok(postgresInvalidDescriptionItem);
  assert.equal(postgresInvalidDescriptionItem.description, "Descriçãoincompatível");
  assert.equal(postgresInvalidDescriptionItem.validationStatus, "invalid");
  assert.equal(postgresInvalidDescriptionItem.canEdit, true);
  assert.match(postgresInvalidDescriptionItem.errorMessage, /não pode conter caractere nulo/i);
  const patchPostgresInvalidDescription = await app.inject({
    method: "PATCH",
    url: `/financial-imports/${duplicatePreview.json().id}/items/${postgresInvalidDescriptionItem.id}`,
    headers: authenticatedHeaders,
    payload: {
      date: "2026-10-25",
      description: "Descrição\u0000incompatível",
      type: "income",
      categoryId: incomeCategoryId,
      subcategoryId: null,
    },
  });
  assert.equal(patchPostgresInvalidDescription.statusCode, 400);
  assert.match(patchPostgresInvalidDescription.json().message, /não pode conter caractere nulo/i);

  const confirmedDuplicatePreview = await app.inject({
    method: "POST",
    url: `/financial-imports/${duplicatePreview.json().id}/confirm`,
    headers: authenticatedHeaders,
  });
  assert.equal(confirmedDuplicatePreview.statusCode, 200);
  assert.equal(confirmedDuplicatePreview.json().summary.imported, 1);
  assert.equal(confirmedDuplicatePreview.json().summary.duplicate, 2);
  assert.equal(confirmedDuplicatePreview.json().summary.invalid, 3);
  assert.equal(
    (await database.query(
      "SELECT count(*)::integer AS count FROM incomes WHERE wallet_id = $1 AND description LIKE 'Duplicidade %'",
      [walletId],
    )).rows[0]!.count,
    0,
  );

  const batchSession = await repository.createImport(userId, walletId, {
    format: "csv",
    fileName: "limite-10000.csv",
    fileSize: 1024,
    fileHash: "9".repeat(64),
  });
  const batchPreview = await repository.savePreview(
    userId,
    walletId,
    batchSession.id,
    Array.from({ length: 10_000 }, (_, index) => ({
      sequence: index + 1,
      date: "2026-10-25",
      description: `Movimentação em lote ${index + 1}`,
      signedAmount: "1.00",
      type: "income" as const,
      categoryId: incomeCategoryId,
      validationStatus: "valid" as const,
    })),
  );
  assert.equal(batchPreview?.summary.total, 10_000);
  assert.equal(batchPreview?.items?.length, 10_000);
  const batchCompleted = await repository.confirmImport(userId, walletId, batchSession.id);
  assert.equal(batchCompleted?.summary.imported, 10_000);
  assert.equal(batchCompleted?.items?.length, 10_000);
  assert.equal(
    (await database.query(
      "SELECT count(*)::integer AS count FROM incomes WHERE wallet_id = $1 AND description LIKE 'Movimentação em lote %'",
      [walletId],
    )).rows[0]!.count,
    10_000,
  );
});
