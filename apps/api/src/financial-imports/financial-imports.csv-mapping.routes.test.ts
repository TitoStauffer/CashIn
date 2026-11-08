// Rotas de inspeção e mapeamento de CSV, regras de categorização e validação do CSV de fatura.
// As rotas de importação em si estão em `financial-imports.routes.test.ts`.

import assert from "node:assert/strict";
import test from "node:test";
import { DefaultFinancialImportParser } from "./financial-imports.parser.js";
import { CATEGORY_A, SESSION_B, CSV_MAPPING_HEADER, createTestApp, authCookie, upload } from "./financial-imports-routes-test-fixture.js";

test("CSV inspection and reusable mappings remain scoped to the current wallet", async () => {
  const { app } = createTestApp(null);
  const inspection = await app.inject({
    method: "POST", url: "/financial-imports/csv/inspect",
    headers: { cookie: authCookie(), "content-type": "application/octet-stream" },
    payload: Buffer.from("Data;Descrição;Valor\n31/10/2026;Mercado;-10,25\n"),
  });
  assert.equal(inspection.statusCode, 200);
  assert.equal(inspection.json().detectedConfiguration.delimiter, ";");
  assert.deepEqual(inspection.json().suggestedMapping, { date: 0, description: 1, amount: 2, credit: null, debit: null, externalId: null });

  const incompleteColumns = { date: 0, description: null, amount: null, credit: null, debit: null, externalId: null };
  const wrongInspectionConfiguration = {
    delimiter: ",", encoding: "utf-8", hasHeader: true, dateFormat: "yyyy-MM-dd", numberFormat: "en-US",
    columns: incompleteColumns,
  };
  const wrongInspection = await app.inject({
    method: "POST", url: "/financial-imports/csv/inspect",
    headers: { cookie: authCookie(), "content-type": "application/octet-stream", "x-csv-mapping": encodeURIComponent(JSON.stringify(wrongInspectionConfiguration)) },
    payload: Buffer.from("Data;Descrição;Valor\n31/10/2026;Mercado;-10,25\n"),
  });
  assert.equal(wrongInspection.statusCode, 200);
  assert.equal(wrongInspection.json().columns.length, 1);
  const correctedInspection = await app.inject({
    method: "POST", url: "/financial-imports/csv/inspect",
    headers: { cookie: authCookie(), "content-type": "application/octet-stream", "x-csv-mapping": encodeURIComponent(JSON.stringify({ ...wrongInspectionConfiguration, delimiter: ";", dateFormat: "dd/MM/yyyy", numberFormat: "pt-BR" })) },
    payload: Buffer.from("Data;Descrição;Valor\n31/10/2026;Mercado;-10,25\n"),
  });
  assert.equal(correctedInspection.statusCode, 200);
  assert.equal(correctedInspection.json().columns.length, 3);
  assert.deepEqual(correctedInspection.json().detectedConfiguration, {
    delimiter: ";", encoding: "utf-8", hasHeader: true, dateFormat: "dd/MM/yyyy", numberFormat: "pt-BR",
  });

  const configuration = {
    delimiter: ";", encoding: "utf-8", hasHeader: true, dateFormat: "dd/MM/yyyy", numberFormat: "pt-BR",
    columns: { date: 0, description: 1, amount: 2, credit: null, debit: null, externalId: null },
  };
  const created = await app.inject({
    method: "POST", url: "/financial-imports/csv-mappings", headers: { cookie: authCookie() },
    payload: { name: "Banco principal", configuration },
  });
  assert.equal(created.statusCode, 201, created.body);
  const mappingId = created.json().id as string;
  const otherUserList = await app.inject({ method: "GET", url: "/financial-imports/csv-mappings", headers: { cookie: authCookie(SESSION_B) } });
  assert.deepEqual(otherUserList.json(), { items: [] });
  const crossWalletUpload = await app.inject({
    method: "POST", url: "/financial-imports",
    headers: { cookie: authCookie(SESSION_B), "content-type": "application/octet-stream", "x-file-name": "statement.csv", "x-file-format": "csv", "x-csv-mapping-id": mappingId },
    payload: Buffer.from("Data;Descrição;Valor\n31/10/2026;Mercado;-10,25\n"),
  });
  assert.equal(crossWalletUpload.statusCode, 404);

  const malformedQuoteUpload = await app.inject({
    method: "POST", url: "/financial-imports",
    headers: { cookie: authCookie(), "content-type": "application/octet-stream", "x-file-name": "malformed.csv", "x-file-format": "csv", "x-csv-mapping-id": mappingId },
    payload: Buffer.from('Data;Descrição;Valor\n31/10/2026;"Mercado"alterado;-10,25\n'),
  });
  assert.equal(malformedQuoteUpload.statusCode, 422);
  assert.match(malformedQuoteUpload.json().message, /conteúdo inválido após aspas/i);

  const uploadResponse = await app.inject({
    method: "POST", url: "/financial-imports",
    headers: { cookie: authCookie(), "content-type": "application/octet-stream", "x-file-name": "statement.csv", "x-file-format": "csv", "x-csv-mapping-id": mappingId },
    payload: Buffer.from("Data;Descrição;Valor\n31/10/2026;Mercado;-10,25\n"),
  });
  assert.equal(uploadResponse.statusCode, 201);
  const detail = await app.inject({ method: "GET", url: `/financial-imports/${uploadResponse.json().id}`, headers: { cookie: authCookie() } });
  assert.equal(detail.json().items[0].amount, "10.25");
  assert.equal(detail.json().items[0].type, "expense");

  const provenanceConfiguration = {
    ...configuration,
    columns: { ...configuration.columns, externalId: 3 },
  };
  const provenanceUpload = await app.inject({
    method: "POST", url: "/financial-imports",
    headers: {
      cookie: authCookie(),
      "content-type": "application/octet-stream",
      "x-file-name": "provenance.csv",
      "x-file-format": "csv",
      "x-csv-mapping": encodeURIComponent(JSON.stringify(provenanceConfiguration)),
    },
    payload: Buffer.from(`Data;Descrição;Valor;ID\n\n31/10/2026;"Primeira\nlinha";1,00;ok\n\n01/11/2026;Inválida;2,00;${"x".repeat(513)}\n`),
  });
  assert.equal(provenanceUpload.statusCode, 201);
  const provenanceDetail = await app.inject({
    method: "GET", url: `/financial-imports/${provenanceUpload.json().id}`,
    headers: { cookie: authCookie() },
  });
  assert.equal(provenanceDetail.statusCode, 200);
  assert.equal(provenanceDetail.json().items[1].sequence, 2);
  assert.equal(provenanceDetail.json().items[1].validationStatus, "invalid");
  assert.match(provenanceDetail.json().items[1].errorMessage, /Linha 6:.*identificador externo/i);

  const patched = await app.inject({
    method: "PATCH", url: `/financial-imports/csv-mappings/${mappingId}`, headers: { cookie: authCookie() },
    payload: { name: "Banco atualizado", configuration },
  });
  assert.equal(patched.statusCode, 200);
  assert.equal(patched.json().name, "Banco atualizado");

  const conflictingMappingSources = await app.inject({
    method: "POST", url: "/financial-imports",
    headers: { cookie: authCookie(), "content-type": "application/octet-stream", "x-file-name": "statement.csv", "x-file-format": "csv", "x-csv-mapping-id": mappingId, "x-csv-mapping": encodeURIComponent(JSON.stringify(configuration)) },
    payload: Buffer.from("Data;Descrição;Valor\n31/10/2026;Mercado;-10,25\n"),
  });
  assert.equal(conflictingMappingSources.statusCode, 400);
  await app.close();
});

test("categorization rules are wallet scoped, explicit, and applied to future previews", async () => {
  const { app } = createTestApp();
  const rulesUrl = "/financial-imports/rules";
  assert.equal((await app.inject({ method: "GET", url: rulesUrl })).statusCode, 401);

  const created = await app.inject({
    method: "POST", url: rulesUrl, headers: { cookie: authCookie() },
    payload: { type: "expense", description: "  MERCADO  ", categoryId: CATEGORY_A, subcategoryId: null },
  });
  assert.equal(created.statusCode, 201, created.body);
  assert.equal(created.json().description, "MERCADO");
  assert.equal(created.json().isActive, true);
  const ruleId = created.json().id as string;

  const duplicate = await app.inject({
    method: "POST", url: rulesUrl, headers: { cookie: authCookie() },
    payload: { type: "expense", description: "mercado", categoryId: CATEGORY_A },
  });
  assert.equal(duplicate.statusCode, 409);
  const transferRule = await app.inject({
    method: "POST", url: rulesUrl, headers: { cookie: authCookie() },
    payload: { type: "transfer", description: "Pix", categoryId: CATEGORY_A },
  });
  assert.equal(transferRule.statusCode, 400);
  const unknownCategory = await app.inject({
    method: "POST", url: rulesUrl, headers: { cookie: authCookie() },
    payload: { type: "expense", description: "Farmácia", categoryId: "22222222-2222-4222-8222-222222222222" },
  });
  assert.equal(unknownCategory.statusCode, 404);

  const otherWallet = await app.inject({ method: "GET", url: rulesUrl, headers: { cookie: authCookie(SESSION_B) } });
  assert.deepEqual(otherWallet.json(), { items: [] });
  const crossWalletDelete = await app.inject({ method: "DELETE", url: `${rulesUrl}/${ruleId}`, headers: { cookie: authCookie(SESSION_B) } });
  assert.equal(crossWalletDelete.statusCode, 404);

  const categorized = await upload(app);
  const categorizedDetail = await app.inject({ method: "GET", url: `/financial-imports/${categorized.json().id}`, headers: { cookie: authCookie() } });
  assert.equal(categorizedDetail.json().items[1].categoryId, CATEGORY_A);
  assert.equal(categorizedDetail.json().items[1].validationStatus, "valid");
  assert.equal(categorizedDetail.json().items[1].categorizationSource, "rule");
  assert.equal(categorizedDetail.json().items[0].categorizationSource, null);

  const otherWalletUpload = await upload(app, SESSION_B);
  const otherWalletDetail = await app.inject({ method: "GET", url: `/financial-imports/${otherWalletUpload.json().id}`, headers: { cookie: authCookie(SESSION_B) } });
  assert.equal(otherWalletDetail.json().items[1].categoryId, null);
  assert.equal(otherWalletDetail.json().items[1].validationStatus, "uncategorized");

  const otherRule = await app.inject({
    method: "POST", url: rulesUrl, headers: { cookie: authCookie() },
    payload: { type: "expense", description: "Padaria", categoryId: CATEGORY_A },
  });
  assert.equal(otherRule.statusCode, 201);
  const conflictingEdit = await app.inject({
    method: "PATCH", url: `${rulesUrl}/${otherRule.json().id}`, headers: { cookie: authCookie() },
    payload: { type: "expense", description: " mercado ", categoryId: CATEGORY_A, subcategoryId: null, isActive: true },
  });
  assert.equal(conflictingEdit.statusCode, 409);
  assert.match(conflictingEdit.json().message, /Já existe uma regra/);

  const deactivated = await app.inject({
    method: "PATCH", url: `${rulesUrl}/${ruleId}`, headers: { cookie: authCookie() },
    payload: { type: "expense", description: "Mercado", categoryId: CATEGORY_A, subcategoryId: null, isActive: false },
  });
  assert.equal(deactivated.statusCode, 200);
  assert.equal(deactivated.json().isActive, false);
  const uncategorized = await upload(app);
  const uncategorizedDetail = await app.inject({ method: "GET", url: `/financial-imports/${uncategorized.json().id}`, headers: { cookie: authCookie() } });
  assert.equal(uncategorizedDetail.json().items[1].categoryId, null);
  assert.equal(uncategorizedDetail.json().items[1].categorizationSource, null);

  const deleted = await app.inject({ method: "DELETE", url: `${rulesUrl}/${ruleId}`, headers: { cookie: authCookie() } });
  assert.equal(deleted.statusCode, 204);
  const missing = await app.inject({ method: "DELETE", url: `${rulesUrl}/${ruleId}`, headers: { cookie: authCookie() } });
  assert.equal(missing.statusCode, 404);
  await app.close();
});

test("card statement uploads validate the card and the CSV purchase sign before parsing", async () => {
  const { app, repository } = createTestApp(new DefaultFinancialImportParser());
  const bankImport = await upload(app);
  const walletId = repository.sessions.get(bankImport.json().id)!.walletId;
  const cardId = "40000000-0000-4000-8000-000000000001";
  repository.creditCards.set(cardId, { walletId, card: { id: cardId, closingDay: 10, dueDay: 20 } });
  const sendCard = (headers: Record<string, string>, fileName = "fatura.csv", format = "csv") => app.inject({
    method: "POST",
    url: "/financial-imports",
    headers: {
      cookie: authCookie(),
      "content-type": "application/octet-stream",
      "x-file-name": fileName,
      "x-file-format": format,
      ...(format === "csv" ? { "x-csv-mapping": CSV_MAPPING_HEADER } : {}),
      ...headers,
    },
    payload: Buffer.from("date,description,amount\n2026-10-11,Livraria,50.25\n2026-10-12,Estorno Livraria,-20.25\n"),
  });

  const signWithoutCard = await sendCard({ "x-card-amount-sign": "purchases_positive" });
  assert.equal(signWithoutCard.statusCode, 400);
  assert.match(signWithoutCard.json().message, /só se aplica a faturas de cartão/);
  assert.equal((await sendCard({ "x-credit-card-id": "40000000-0000-4000-8000-000000000099", "x-card-amount-sign": "purchases_positive" })).statusCode, 404);
  assert.equal((await sendCard({ "x-credit-card-id": "not-a-card", "x-card-amount-sign": "purchases_positive" })).statusCode, 404);
  assert.match((await sendCard({ "x-credit-card-id": cardId })).json().message, /representa as compras/);
  assert.equal((await sendCard({ "x-credit-card-id": cardId, "x-card-amount-sign": "purchases_positive" }, "fatura.ofx", "ofx")).statusCode, 400);

  const created = await sendCard({ "x-credit-card-id": cardId, "x-card-amount-sign": "purchases_positive" });
  assert.equal(created.statusCode, 201, created.body);
  assert.equal(created.json().kind, "credit_card_statement");
  assert.deepEqual(repository.sessions.get(created.json().id)!.items.map((item) => [item.type, item.amount]), [
    ["expense", "50.25"],
    ["card_credit", "20.25"],
  ]);
  await app.close();
});
