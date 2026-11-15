import assert from "node:assert/strict";
import test from "node:test";
import { FinancialImportsService } from "./financial-imports.service.js";
import { confirmedEventOf, type FinancialImportConfirmedEvent, type FinancialImportMetrics, type FinancialImportOrigin } from "./financial-imports.metrics.js";
import { MemoryFinancialImportRepository, TestParser, USER_A } from "./financial-imports-routes-test-fixture.js";

// DEV-135. The import use cases report confirmations, undos and failures through `FinancialImportMetrics`.
// These tests use a recording fake — no OpenTelemetry SDK — and assert each event happens exactly once,
// and only when the operation really happened.

const WALLET = "22222222-2222-4222-8222-222222222222";
const CSV_CONFIGURATION = {
  delimiter: ";",
  encoding: "utf-8",
  hasHeader: true,
  dateFormat: "dd/MM/yyyy",
  numberFormat: "pt-BR",
  columns: { date: 0, description: 1, amount: 2, credit: null, debit: null, externalId: null },
} as const;

class RecordingMetrics implements FinancialImportMetrics {
  readonly confirmed: FinancialImportConfirmedEvent[] = [];
  readonly undone: FinancialImportOrigin[] = [];
  readonly failed: FinancialImportOrigin[] = [];
  importConfirmed(event: FinancialImportConfirmedEvent): void { this.confirmed.push(event); }
  importUndone(event: FinancialImportOrigin): void { this.undone.push(event); }
  importFailed(event: FinancialImportOrigin): void { this.failed.push(event); }
}

function setup(parser = new TestParser()) {
  const repository = new MemoryFinancialImportRepository();
  const metrics = new RecordingMetrics();
  const service = new FinancialImportsService(repository, parser, undefined, metrics);
  const upload = () => service.createImport(USER_A, WALLET, "csv", "extrato.csv", Buffer.from("data;descricao;valor\n"), {
    configuration: CSV_CONFIGURATION,
  });
  return { repository, metrics, service, upload };
}

test("a confirmed import is recorded once, with its line outcomes and origin", async () => {
  const { metrics, service, upload } = setup();
  const preview = await upload();
  const confirmed = await service.confirmImport(USER_A, WALLET, preview.id);

  assert.deepEqual(metrics.confirmed, [{
    format: "csv",
    kind: "bank_statement",
    imported: confirmed.summary.imported,
    skippedDuplicate: confirmed.summary.duplicate,
    rejectedInvalid: confirmed.summary.invalid,
  }]);
  assert.ok(confirmed.summary.imported > 0);
  assert.deepEqual(metrics.failed, []);
  assert.deepEqual(metrics.undone, []);
});

test("a confirmation the repository refuses is not recorded", async () => {
  const { metrics, service, upload } = setup();
  const preview = await upload();
  await service.confirmImport(USER_A, WALLET, preview.id);
  // The second confirmation finds the import already completed: the repository returns nothing.
  await assert.rejects(service.confirmImport(USER_A, WALLET, preview.id), /não pode ser confirmada/);
  assert.equal(metrics.confirmed.length, 1);
});

test("a confirmation whose transaction fails is not recorded", async () => {
  const { repository, metrics, service, upload } = setup();
  const preview = await upload();
  repository.confirmImport = async () => { throw new Error("transaction rolled back"); };
  await assert.rejects(service.confirmImport(USER_A, WALLET, preview.id), /rolled back/);
  assert.deepEqual(metrics.confirmed, []);
});

test("a confirmation that leaves the import in preview, with nothing imported, is not recorded", async () => {
  const { repository, metrics, service, upload } = setup();
  const preview = await upload();
  // What the PostgreSQL repository returns when it detects new duplicates during the confirmation, or no
  // valid line is left: the session, still in preview. The memory repository never does this by itself.
  repository.confirmImport = async (userId, walletId, importId) => repository.getImport(userId, walletId, importId);
  const session = await service.confirmImport(USER_A, WALLET, preview.id);
  assert.equal(session.status, "preview");
  assert.deepEqual(metrics.confirmed, []);
});

test("an undone import is recorded once, and a refused undo is not", async () => {
  const { metrics, service, upload } = setup();
  const preview = await upload();
  await service.confirmImport(USER_A, WALLET, preview.id);
  await service.undoImport(USER_A, WALLET, preview.id);
  await assert.rejects(service.undoImport(USER_A, WALLET, preview.id), /não pode ser desfeita/);
  assert.deepEqual(metrics.undone, [{ format: "csv", kind: "bank_statement" }]);
});

test("an upload that cannot become a preview is recorded as failed once, and a good one is not", async () => {
  const failing = setup(new TestParser(true));
  await assert.rejects(failing.upload(), /Arquivo inválido/);
  assert.deepEqual(failing.metrics.failed, [{ format: "csv", kind: "bank_statement" }]);

  const working = setup();
  await working.upload();
  assert.deepEqual(working.metrics.failed, []);
});

test("the service works without any metrics recorder", async () => {
  const repository = new MemoryFinancialImportRepository();
  const service = new FinancialImportsService(repository, new TestParser());
  const preview = await service.createImport(USER_A, WALLET, "csv", "extrato.csv", Buffer.from("x"), { configuration: CSV_CONFIGURATION });
  assert.equal((await service.confirmImport(USER_A, WALLET, preview.id)).status, "completed");
});

test("the confirmed event maps each summary count to its own outcome", () => {
  assert.deepEqual(
    confirmedEventOf({ format: "ofx", kind: "credit_card_statement", summary: { total: 9, valid: 0, duplicate: 2, invalid: 1, uncategorized: 1, imported: 5 } }),
    { format: "ofx", kind: "credit_card_statement", imported: 5, skippedDuplicate: 2, rejectedInvalid: 1 },
  );
});
