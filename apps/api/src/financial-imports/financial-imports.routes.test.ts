// Rotas de importação: upload, prévia, confirmação, desfazer, descarte, falhas e limites.
// Mapeamento CSV, regras de categorização e validação do CSV de fatura estão em
// `financial-imports.csv-mapping.routes.test.ts`; os fakes compartilhados, no arquivo de fixture.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { FinancialImportError } from "./financial-imports.errors.js";
import { FINANCIAL_IMPORT_PROCESSING_TIMEOUT_MINUTES, MAX_FINANCIAL_IMPORT_FILE_SIZE } from "./financial-imports.service.js";
import type { FinancialImportItem, FinancialImportParser, FinancialImportSession } from "./financial-imports.types.js";
import { USER_A, USER_B, CATEGORY_A, SESSION_B, CSV_MAPPING_HEADER, TestParser, InvalidItemsParser, fixtures, createTestApp, authCookie, upload } from "./financial-imports-routes-test-fixture.js";

test("financial import routes require authentication and expose wallet-scoped preview/history", async () => {
  const { app } = createTestApp();
  assert.equal((await app.inject({ method: "GET", url: "/financial-imports" })).statusCode, 401);

  const created = await upload(app);
  assert.equal(created.statusCode, 201, created.body);
  assert.equal(created.json().fileName, "extrato outubro.csv");
  assert.equal(created.json().format, "csv");
  assert.equal(created.json().status, "preview");
  assert.deepEqual(created.json().summary, {
    total: 2, valid: 1, duplicate: 0, invalid: 0, uncategorized: 1, imported: 0,
  });
  assert.match(created.json().fileHash, /^[0-9a-f]{64}$/);

  const list = await app.inject({ method: "GET", url: "/financial-imports", headers: { cookie: authCookie() } });
  assert.equal(list.statusCode, 200);
  assert.equal(list.json().items.length, 1);
  const detail = await app.inject({
    method: "GET", url: `/financial-imports/${created.json().id}`, headers: { cookie: authCookie() },
  });
  assert.equal(detail.statusCode, 200);
  assert.equal(detail.json().items[1].amount, "125.50");
  assert.equal(detail.json().items[1].type, "expense");

  const hidden = await app.inject({
    method: "GET", url: `/financial-imports/${created.json().id}`, headers: { cookie: authCookie(SESSION_B) },
  });
  assert.equal(hidden.statusCode, 404);
  await app.close();
});

test("default API parser creates an editable preview from an OFX bank statement", async () => {
  const { app } = createTestApp(null);
  const response = await app.inject({
    method: "POST",
    url: "/financial-imports",
    headers: {
      cookie: authCookie(),
      "content-type": "application/octet-stream",
      "x-file-name": encodeURIComponent("extrato.ofx"),
      "x-file-format": "ofx",
    },
    payload: await readFile(`${fixtures}valid-bank.ofx`),
  });

  assert.equal(response.statusCode, 201);
  assert.equal(response.json().status, "preview");
  const detail = await app.inject({
    method: "GET",
    url: `/financial-imports/${response.json().id}`,
    headers: { cookie: authCookie() },
  });
  assert.deepEqual(detail.json().items.map((item: FinancialImportItem) => ({
    date: item.date,
    description: item.description,
    amount: item.amount,
    type: item.type,
    status: item.validationStatus,
  })), [
    { date: "2026-10-20", description: "Salário — Pagamento mensal", amount: "1500.50", type: "income", status: "uncategorized" },
    { date: "2026-10-21", description: "Mercado & Companhia", amount: "125.50", type: "expense", status: "uncategorized" },
    { date: "2026-10-22", description: "Transferência entre contas", amount: "300.00", type: "transfer", status: "uncategorized" },
  ]);
  await app.close();
});

test("default API parser preserves literal CDATA content in the persisted preview", async () => {
  const { app } = createTestApp(null);
  const response = await app.inject({
    method: "POST",
    url: "/financial-imports",
    headers: {
      cookie: authCookie(),
      "content-type": "application/octet-stream",
      "x-file-name": encodeURIComponent("extrato-xml.ofx"),
      "x-file-format": "ofx",
    },
    payload: await readFile(`${fixtures}valid-xml.ofx`),
  });

  assert.equal(response.statusCode, 201);
  const detail = await app.inject({
    method: "GET",
    url: `/financial-imports/${response.json().id}`,
    headers: { cookie: authCookie() },
  });
  assert.equal(detail.statusCode, 200);
  assert.equal(
    detail.json().items[0].description,
    "Padaria & Filial </STMTTRN> Centro <STMTTRN> <STMTRS> </STMTRS> <CCACCTFROM> <CCSTMTTRNRS> &amp;",
  );
  await app.close();
});

test("preview items can be classified, confirmed atomically, and undone", async () => {
  const { app } = createTestApp();
  const created = await upload(app);
  const detail = await app.inject({
    method: "GET", url: `/financial-imports/${created.json().id}`, headers: { cookie: authCookie() },
  });
  const secondItem = detail.json().items[1];
  const classified = await app.inject({
    method: "PATCH",
    url: `/financial-imports/${created.json().id}/items/${secondItem.id}`,
    headers: { cookie: authCookie() },
    payload: {
      date: "2026-10-21",
      description: "Mercado do bairro",
      type: "expense",
      categoryId: CATEGORY_A,
      subcategoryId: null,
    },
  });
  assert.equal(classified.statusCode, 200);
  assert.equal(classified.json().validationStatus, "valid");

  const confirmed = await app.inject({
    method: "POST", url: `/financial-imports/${created.json().id}/confirm`, headers: { cookie: authCookie() },
  });
  assert.equal(confirmed.statusCode, 200);
  assert.equal(confirmed.json().status, "completed");
  assert.equal(confirmed.json().summary.imported, 2);
  assert.equal(confirmed.json().canUndo, true);

  const editAfterConfirmation = await app.inject({
    method: "PATCH",
    url: `/financial-imports/${created.json().id}/items/${secondItem.id}`,
    headers: { cookie: authCookie() },
    payload: { date: "2026-10-21", type: "expense", categoryId: CATEGORY_A },
  });
  assert.equal(editAfterConfirmation.statusCode, 409);

  const undone = await app.inject({
    method: "POST", url: `/financial-imports/${created.json().id}/undo`, headers: { cookie: authCookie() },
  });
  assert.equal(undone.statusCode, 200);
  assert.equal(undone.json().status, "undone");
  assert.equal(undone.json().summary.imported, 0);
  assert.equal(undone.json().canUndo, false);
  await app.close();
});

test("preview can be discarded without creating movements and remains wallet scoped", async () => {
  const { app } = createTestApp();
  const created = await upload(app);

  const hidden = await app.inject({
    method: "DELETE",
    url: `/financial-imports/${created.json().id}`,
    headers: { cookie: authCookie(SESSION_B) },
  });
  assert.equal(hidden.statusCode, 409);

  const discarded = await app.inject({
    method: "DELETE",
    url: `/financial-imports/${created.json().id}`,
    headers: { cookie: authCookie() },
  });
  assert.equal(discarded.statusCode, 200);
  assert.equal(discarded.json().status, "failed");
  assert.equal(discarded.json().failureMessage, "Importação descartada pelo usuário.");
  assert.equal(discarded.json().summary.valid, 0);
  assert.equal(discarded.json().summary.uncategorized, 2);
  assert.ok(discarded.json().items.every((item: FinancialImportItem) => item.categoryId === null));

  const repeated = await app.inject({
    method: "DELETE",
    url: `/financial-imports/${created.json().id}`,
    headers: { cookie: authCookie() },
  });
  assert.equal(repeated.statusCode, 409);
  await app.close();
});

test("upload failures are safe, validated, and retained as failed history", async () => {
  const { app } = createTestApp(new TestParser(true));
  const failed = await upload(app);
  assert.equal(failed.statusCode, 422);
  assert.equal(failed.json().message, "Arquivo inválido para o teste.");
  const list = await app.inject({ method: "GET", url: "/financial-imports", headers: { cookie: authCookie() } });
  assert.equal(list.json().items[0].status, "failed");

  const wrongExtension = await app.inject({
    method: "POST",
    url: "/financial-imports",
    headers: {
      cookie: authCookie(),
      "content-type": "application/octet-stream",
      "x-file-name": "statement.txt",
      "x-file-format": "csv",
      "x-csv-mapping": CSV_MAPPING_HEADER,
    },
    payload: Buffer.from("content"),
  });
  assert.equal(wrongExtension.statusCode, 400);

  const invalidDate = await app.inject({
    method: "PATCH",
    url: "/financial-imports/10000000-0000-4000-8000-000000000001/items/20000000-0000-4000-8000-000000000001",
    headers: { cookie: authCookie() },
    payload: { date: "2026-02-30", type: "income", categoryId: CATEGORY_A },
  });
  assert.equal(invalidDate.statusCode, 400);
  await app.close();
});

test("persisted import failures respect the UTF-8 database limit", async () => {
  const parser: FinancialImportParser = {
    parse: async () => {
      throw new FinancialImportError(`Falha ${"界".repeat(500)}`, 422);
    },
  };
  const { app } = createTestApp(parser);
  const failed = await upload(app);
  assert.equal(failed.statusCode, 422);

  const list = await app.inject({ method: "GET", url: "/financial-imports", headers: { cookie: authCookie() } });
  const failureMessage = list.json().items[0].failureMessage as string;
  assert.ok(Buffer.byteLength(failureMessage, "utf8") <= 1_000);
  assert.match(failureMessage, /^Falha /);
  await app.close();
});

test("upload and preview edits enforce UTF-8 byte limits before persistence", async () => {
  const { app } = createTestApp();
  const fileNameAtLimit = `${"界".repeat(168)}${"á".repeat(2)}.csv`;
  assert.equal(Buffer.byteLength(fileNameAtLimit, "utf8"), 512);
  const acceptedUpload = await app.inject({
    method: "POST",
    url: "/financial-imports",
    headers: {
      cookie: authCookie(),
      "content-type": "application/octet-stream",
      "x-file-name": encodeURIComponent(fileNameAtLimit),
      "x-file-format": "csv",
      "x-csv-mapping": CSV_MAPPING_HEADER,
    },
    payload: Buffer.from("content"),
  });
  assert.equal(acceptedUpload.statusCode, 201);
  assert.equal(acceptedUpload.json().fileName, fileNameAtLimit);

  const oversizedFileName = `${"界".repeat(169)}á.csv`;
  assert.equal(Buffer.byteLength(oversizedFileName, "utf8"), 513);
  const rejectedUpload = await app.inject({
    method: "POST",
    url: "/financial-imports",
    headers: {
      cookie: authCookie(),
      "content-type": "application/octet-stream",
      "x-file-name": encodeURIComponent(oversizedFileName),
      "x-file-format": "csv",
    },
    payload: Buffer.from("content"),
  });
  assert.equal(rejectedUpload.statusCode, 400);
  assert.equal(rejectedUpload.json().message, "O nome do arquivo é inválido.");

  const detail = await app.inject({
    method: "GET",
    url: `/financial-imports/${acceptedUpload.json().id}`,
    headers: { cookie: authCookie() },
  });
  const itemId = detail.json().items[0].id;
  const descriptionAtLimit = `${"界".repeat(1_332)}${"á".repeat(2)}`;
  assert.equal(Buffer.byteLength(descriptionAtLimit, "utf8"), 4_000);
  const acceptedEdit = await app.inject({
    method: "PATCH",
    url: `/financial-imports/${acceptedUpload.json().id}/items/${itemId}`,
    headers: { cookie: authCookie() },
    payload: {
      date: "2026-10-20",
      description: descriptionAtLimit,
      type: "income",
      categoryId: CATEGORY_A,
    },
  });
  assert.equal(acceptedEdit.statusCode, 200);
  assert.equal(acceptedEdit.json().description, descriptionAtLimit);

  const oversizedDescription = `${descriptionAtLimit}a`;
  assert.equal(Buffer.byteLength(oversizedDescription, "utf8"), 4_001);
  const rejectedEdit = await app.inject({
    method: "PATCH",
    url: `/financial-imports/${acceptedUpload.json().id}/items/${itemId}`,
    headers: { cookie: authCookie() },
    payload: {
      date: "2026-10-20",
      description: oversizedDescription,
      type: "income",
      categoryId: CATEGORY_A,
    },
  });
  assert.equal(rejectedEdit.statusCode, 400);
  assert.equal(rejectedEdit.json().message, "A descrição da movimentação deve ter no máximo 4.000 bytes.");

  const unchangedDetail = await app.inject({
    method: "GET",
    url: `/financial-imports/${acceptedUpload.json().id}`,
    headers: { cookie: authCookie() },
  });
  assert.equal(unchangedDetail.json().items[0].description, descriptionAtLimit);
  await app.close();
});

// The request below is larger than the upload accepts, so the answer says where it was stopped: a
// 413 means the API read the file and only then looked at who was sending it, while 401 and 404 mean
// authorization came first and the payload was never buffered.
test("an unauthorized upload is refused before the file is read", async () => {
  const { app, repository } = createTestApp();
  const oversized = Buffer.alloc(MAX_FINANCIAL_IMPORT_FILE_SIZE + 1_024, 0x41);
  const uploadHeaders = {
    "content-type": "application/octet-stream",
    "x-file-name": encodeURIComponent("extrato.csv"),
    "x-file-format": "csv",
    "x-csv-mapping": CSV_MAPPING_HEADER,
  };

  const anonymous = await app.inject({ method: "POST", url: "/financial-imports", headers: uploadHeaders, payload: oversized });
  assert.equal(anonymous.statusCode, 401);
  assert.equal(anonymous.json().message, "Autenticação necessária.");

  const otherWallet = await app.inject({
    method: "POST",
    url: "/financial-imports",
    headers: { ...uploadHeaders, cookie: authCookie(), "x-wallet-id": USER_B },
    payload: oversized,
  });
  assert.equal(otherWallet.statusCode, 404);

  const anonymousInspection = await app.inject({
    method: "POST",
    url: "/financial-imports/csv/inspect",
    headers: { "content-type": "application/octet-stream" },
    payload: oversized,
  });
  assert.equal(anonymousInspection.statusCode, 401);

  // Nothing about the refused requests was recorded, and the limit still applies once authorized.
  assert.equal(repository.sessions.size, 0);
  const authorized = await app.inject({
    method: "POST",
    url: "/financial-imports",
    headers: { ...uploadHeaders, cookie: authCookie() },
    payload: oversized,
  });
  assert.equal(authorized.statusCode, 413);
  assert.equal(authorized.json().message, "O arquivo deve ter no máximo 10 MB.");
  await app.close();
});

// The history is the audit trail, so it has to say who imported each file.
test("the import history attributes each import to the member who sent it", async () => {
  const { app } = createTestApp();
  const created = (await upload(app)).json() as FinancialImportSession;
  assert.deepEqual(created.importedBy, { userId: USER_A, email: "usuario-a@example.test", isCurrentUser: true });

  const list = await app.inject({ method: "GET", url: "/financial-imports", headers: { cookie: authCookie() } });
  assert.deepEqual(
    (list.json() as { items: FinancialImportSession[] }).items.map((session) => session.importedBy),
    [{ userId: USER_A, email: "usuario-a@example.test", isCurrentUser: true }],
  );
  await app.close();
});

// An upload that died between its session row and its preview has nothing left to advance it. The
// history closes it out, so the import stops being one that never ends and says why it failed.
test("an import interrupted before its preview expires into a traceable failure", async () => {
  const { app, repository } = createTestApp();
  const created = (await upload(app)).json() as FinancialImportSession;
  const stuck = repository.sessions.get(created.id)!;
  stuck.status = "processing";
  stuck.createdAt = new Date(Date.now() - (FINANCIAL_IMPORT_PROCESSING_TIMEOUT_MINUTES + 5) * 60_000).toISOString();

  const list = await app.inject({ method: "GET", url: "/financial-imports", headers: { cookie: authCookie() } });
  const session = (list.json() as { items: FinancialImportSession[] }).items[0]!;
  assert.equal(session.status, "failed");
  assert.equal(session.failureMessage, "A importação foi interrompida antes de gerar a prévia. Envie o arquivo novamente.");
  assert.ok(session.failedAt, "an expired import must record when it was closed out");
  await app.close();
});

test("an import still inside the processing window is left alone", async () => {
  const { app, repository } = createTestApp();
  const created = (await upload(app)).json() as FinancialImportSession;
  repository.sessions.get(created.id)!.status = "processing";

  const list = await app.inject({ method: "GET", url: "/financial-imports", headers: { cookie: authCookie() } });
  assert.equal((list.json() as { items: FinancialImportSession[] }).items[0]!.status, "processing");
  await app.close();
});

test("upload enforces the 10 MB and 10,000 movement limits", async () => {
  const tooMany = createTestApp(new TestParser(false, 10_001));
  const tooManyResponse = await upload(tooMany.app);
  assert.equal(tooManyResponse.statusCode, 413);
  assert.equal(tooManyResponse.json().message, "O arquivo deve ter no máximo 10.000 movimentações.");
  const retained = await tooMany.app.inject({
    method: "GET",
    url: "/financial-imports",
    headers: { cookie: authCookie() },
  });
  assert.equal(retained.json().items[0].status, "failed");
  await tooMany.app.close();

  const csv = createTestApp(null);
  const excessiveCsv = Buffer.from([
    "Data;Descrição;Valor",
    ...Array.from({ length: 10_001 }, (_value, index) => `31/10/2026;Linha ${index + 1};1,00`),
  ].join("\n"));
  const excessiveInspection = await csv.app.inject({
    method: "POST",
    url: "/financial-imports/csv/inspect",
    headers: { cookie: authCookie(), "content-type": "application/octet-stream" },
    payload: excessiveCsv,
  });
  assert.equal(excessiveInspection.statusCode, 413);
  assert.equal(excessiveInspection.json().message, "O arquivo deve ter no máximo 10.000 movimentações.");
  const excessiveUpload = await csv.app.inject({
    method: "POST",
    url: "/financial-imports",
    headers: {
      cookie: authCookie(),
      "content-type": "application/octet-stream",
      "x-file-name": "oversized.csv",
      "x-file-format": "csv",
      "x-csv-mapping": encodeURIComponent(JSON.stringify({
        delimiter: ";", encoding: "utf-8", hasHeader: true, dateFormat: "dd/MM/yyyy", numberFormat: "pt-BR",
        columns: { date: 0, description: 1, amount: 2, credit: null, debit: null, externalId: null },
      })),
    },
    payload: excessiveCsv,
  });
  assert.equal(excessiveUpload.statusCode, 413);
  assert.equal(excessiveUpload.json().message, "O arquivo deve ter no máximo 10.000 movimentações.");

  const excessiveColumns = Buffer.from(
    `${Array.from({ length: 100 }, (_value, index) => `column-${index + 1}`).join(";")};"trailing malformed`,
  );
  const excessiveColumnsInspection = await csv.app.inject({
    method: "POST",
    url: "/financial-imports/csv/inspect",
    headers: { cookie: authCookie(), "content-type": "application/octet-stream" },
    payload: excessiveColumns,
  });
  assert.equal(excessiveColumnsInspection.statusCode, 422);
  assert.equal(excessiveColumnsInspection.json().message, "O arquivo CSV deve ter no máximo 100 colunas.");
  const excessiveColumnsUpload = await csv.app.inject({
    method: "POST",
    url: "/financial-imports",
    headers: {
      cookie: authCookie(),
      "content-type": "application/octet-stream",
      "x-file-name": "too-many-columns.csv",
      "x-file-format": "csv",
      "x-csv-mapping": encodeURIComponent(JSON.stringify({
        delimiter: ";", encoding: "utf-8", hasHeader: false, dateFormat: "yyyy-MM-dd", numberFormat: "pt-BR",
        columns: { date: 0, description: 1, amount: 2, credit: null, debit: null, externalId: null },
      })),
    },
    payload: excessiveColumns,
  });
  assert.equal(excessiveColumnsUpload.statusCode, 422);
  assert.equal(excessiveColumnsUpload.json().message, "O arquivo CSV deve ter no máximo 100 colunas.");
  await csv.app.close();

  const oversized = createTestApp();
  const oversizedResponse = await oversized.app.inject({
    method: "POST",
    url: "/financial-imports",
    headers: {
      cookie: authCookie(),
      "content-type": "application/octet-stream",
      "x-file-name": "statement.csv",
      "x-file-format": "csv",
    },
    payload: Buffer.alloc(10 * 1024 * 1024 + 1, "a"),
  });
  assert.equal(oversizedResponse.statusCode, 413);
  assert.deepEqual(oversizedResponse.json(), { message: "O arquivo deve ter no máximo 10 MB." });
  await oversized.app.close();
});

test("impossible dates, zero values, and repeated source sequences remain in preview without blocking valid items", async () => {
  const { app } = createTestApp(new InvalidItemsParser());
  const created = await upload(app);
  assert.equal(created.statusCode, 201, created.body);
  assert.deepEqual(created.json().summary, {
    total: 4,
    valid: 1,
    duplicate: 0,
    invalid: 3,
    uncategorized: 0,
    imported: 0,
  });

  const detail = await app.inject({
    method: "GET",
    url: `/financial-imports/${created.json().id}`,
    headers: { cookie: authCookie() },
  });
  assert.equal(detail.statusCode, 200);
  assert.deepEqual(detail.json().items.map((item: FinancialImportItem) => item.sequence), [1, 2, 3, 4]);
  assert.equal(detail.json().items[1].date, "");
  assert.match(detail.json().items[1].errorMessage, /data da movimentação é inválida/i);
  assert.equal(detail.json().items[2].amount, "0.00");
  assert.match(detail.json().items[2].errorMessage, /diferente de zero/i);
  assert.match(detail.json().items[3].errorMessage, /sequência original.+duplicada/i);

  const confirmed = await app.inject({
    method: "POST",
    url: `/financial-imports/${created.json().id}/confirm`,
    headers: { cookie: authCookie() },
  });
  assert.equal(confirmed.statusCode, 200);
  assert.equal(confirmed.json().summary.imported, 1);
  assert.equal(confirmed.json().summary.invalid, 3);

  const afterConfirmation = await app.inject({
    method: "GET",
    url: `/financial-imports/${created.json().id}`,
    headers: { cookie: authCookie() },
  });
  assert.equal(afterConfirmation.json().items.filter((item: FinancialImportItem) => item.validationStatus === "invalid").length, 3);
  await app.close();
});
