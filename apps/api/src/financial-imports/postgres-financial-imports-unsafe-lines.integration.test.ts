import assert from "node:assert/strict";
import { createApp } from "../app.js";
import { financialImportScenarioTest } from "./financial-imports-integration-test-fixture.js";

financialImportScenarioTest("PostgreSQL financial import keeps lines it cannot store safely visible and imports only the valid ones", async (scenario) => {
  const { database, repository, walletId, incomeCategoryId, authenticatedHeaders, csvMappingHeader } = scenario;
  let app = scenario.app;
  await app.close();
  app = createApp(database, {
    financialImportRepository: repository,
    financialImportParser: {
      parse: async () => [
        {
          sequence: 1,
          date: "2026-10-24",
          description: "Linha válida",
          signedAmount: "30.00",
          type: "income",
          categoryId: incomeCategoryId,
        },
        {
          sequence: 2,
          date: "2026-10-24",
          description: "á".repeat(2_001),
          signedAmount: "5.00",
          type: "income",
          categoryId: incomeCategoryId,
        },
        {
          sequence: 3,
          date: "2026-10-24",
          description: "Referências incompatíveis",
          signedAmount: "7.00",
          type: "expense",
          categoryId: "categoria-malformada",
          subcategoryId: "22222222-2222-4222-8222-222222222222",
        },
      ],
    },
  });
  await app.ready();
  scenario.app = app;
  const oversizedDescription = await app.inject({
    method: "POST",
    url: "/financial-imports",
    headers: {
      ...authenticatedHeaders,
      "content-type": "application/octet-stream",
      "x-file-name": "description.csv",
      "x-file-format": "csv",
      "x-csv-mapping": csvMappingHeader,
    },
    payload: Buffer.from("description-test"),
  });
  assert.equal(oversizedDescription.statusCode, 201);
  assert.deepEqual(oversizedDescription.json().summary, {
    total: 3,
    valid: 1,
    duplicate: 0,
    invalid: 2,
    uncategorized: 0,
    imported: 0,
  });
  assert.equal(Buffer.byteLength(oversizedDescription.json().items[1].description, "utf8"), 4_000);
  assert.match(oversizedDescription.json().items[1].errorMessage, /máximo 4\.000 bytes/i);
  assert.equal(oversizedDescription.json().items[1].canEdit, true);
  assert.equal(oversizedDescription.json().items[2].validationStatus, "invalid");
  assert.equal(oversizedDescription.json().items[2].categoryId, null);
  assert.equal(oversizedDescription.json().items[2].subcategoryId, null);
  assert.match(oversizedDescription.json().items[2].errorMessage, /categoria ou subcategoria.+inválida/i);

  const repairedDescription = await app.inject({
    method: "PATCH",
    url: `/financial-imports/${oversizedDescription.json().id}/items/${oversizedDescription.json().items[1].id}`,
    headers: authenticatedHeaders,
    payload: {
      date: "2026-10-24",
      description: "Descrição corrigida",
      type: "income",
      categoryId: incomeCategoryId,
      subcategoryId: null,
    },
  });
  assert.equal(repairedDescription.statusCode, 200);
  assert.equal(repairedDescription.json().validationStatus, "valid");

  const confirmedDescriptionImport = await app.inject({
    method: "POST",
    url: `/financial-imports/${oversizedDescription.json().id}/confirm`,
    headers: authenticatedHeaders,
  });
  assert.equal(confirmedDescriptionImport.statusCode, 200);
  assert.equal(confirmedDescriptionImport.json().summary.imported, 2);
  assert.equal(confirmedDescriptionImport.json().summary.invalid, 1);
  assert.equal(
    (await database.query(
      "SELECT count(*)::integer AS count FROM incomes WHERE wallet_id = $1 AND description = 'Linha válida'",
      [walletId],
    )).rows[0]!.count,
    1,
  );
});
