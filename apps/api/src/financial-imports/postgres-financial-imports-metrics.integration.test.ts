import assert from "node:assert/strict";
import type { Database, QueryExecutor } from "../database.js";
import { DefaultFinancialImportParser } from "./financial-imports.parser.js";
import { FinancialImportsService } from "./financial-imports.service.js";
import type { FinancialImportConfirmedEvent, FinancialImportMetrics, FinancialImportOrigin } from "./financial-imports.metrics.js";
import { financialImportScenarioTest, type FinancialImportScenario } from "./financial-imports-integration-test-fixture.js";
import { PostgresFinancialImportsRepository } from "./postgres-financial-imports.repository.js";

// DEV-135 against PostgreSQL: the confirmation is counted only after its transaction committed. The
// rollback case is a real one — the movement insert fails inside the repository's transaction — not a
// stubbed repository.

class RecordingMetrics implements FinancialImportMetrics {
  readonly confirmed: FinancialImportConfirmedEvent[] = [];
  readonly undone: FinancialImportOrigin[] = [];
  readonly failed: FinancialImportOrigin[] = [];
  importConfirmed(event: FinancialImportConfirmedEvent): void { this.confirmed.push(event); }
  importUndone(event: FinancialImportOrigin): void { this.undone.push(event); }
  importFailed(event: FinancialImportOrigin): void { this.failed.push(event); }
}

async function previewWithTwoValidLines(scenario: FinancialImportScenario, repository: PostgresFinancialImportsRepository) {
  const { userId, walletId, incomeCategoryId, expenseCategoryId } = scenario;
  const created = await repository.createImport(userId, walletId, {
    format: "csv", fileName: "extrato.csv", fileSize: 64, fileHash: "c".repeat(64),
  });
  const preview = await repository.savePreview(userId, walletId, created.id, [
    { sequence: 1, date: "2026-10-20", description: "Salário", signedAmount: "1000.00", type: "income", categoryId: incomeCategoryId, validationStatus: "valid", recordHash: "1".repeat(64) },
    { sequence: 2, date: "2026-10-21", description: "Mercado", signedAmount: "-125.50", type: "expense", categoryId: expenseCategoryId, validationStatus: "valid", recordHash: "2".repeat(64) },
  ]);
  assert.ok(preview);
  return preview;
}

financialImportScenarioTest("PostgreSQL import metrics: a committed confirmation and an undo are each counted once", async (scenario) => {
  const metrics = new RecordingMetrics();
  const service = new FinancialImportsService(scenario.repository, new DefaultFinancialImportParser(), undefined, metrics);
  const preview = await previewWithTwoValidLines(scenario, scenario.repository);

  await service.confirmImport(scenario.userId, scenario.walletId, preview.id);
  assert.deepEqual(metrics.confirmed, [{ format: "csv", kind: "bank_statement", imported: 2, skippedDuplicate: 0, rejectedInvalid: 0 }]);

  await service.undoImport(scenario.userId, scenario.walletId, preview.id);
  assert.deepEqual(metrics.undone, [{ format: "csv", kind: "bank_statement" }]);
  assert.equal(metrics.confirmed.length, 1);
});

financialImportScenarioTest("PostgreSQL import metrics: a confirmation rolled back by its transaction is not counted", async (scenario) => {
  // Same database, but every movement insert inside a transaction fails, so the repository's confirmation
  // transaction rolls back in PostgreSQL.
  const failingInserts = (executor: QueryExecutor): QueryExecutor => ({
    query: (queryText, values) => /INSERT INTO (incomes|expenses)\b/i.test(queryText)
      ? Promise.reject(new Error("forced failure inside the confirmation transaction"))
      : executor.query(queryText, values),
  });
  const database: Database = {
    query: scenario.database.query,
    transaction: (work) => scenario.database.transaction((executor) => work(failingInserts(executor))),
  };
  const repository = new PostgresFinancialImportsRepository(database);
  const metrics = new RecordingMetrics();
  const service = new FinancialImportsService(repository, new DefaultFinancialImportParser(), undefined, metrics);
  const preview = await previewWithTwoValidLines(scenario, repository);

  await assert.rejects(service.confirmImport(scenario.userId, scenario.walletId, preview.id), /forced failure/);
  assert.deepEqual(metrics.confirmed, []);
  // The rollback really happened: the import is still a preview and no movement was written.
  const session = await scenario.repository.getImport(scenario.userId, scenario.walletId, preview.id);
  assert.equal(session?.status, "preview");
  const movements = await scenario.database.query<{ count: string }>(
    "SELECT (SELECT count(*) FROM incomes WHERE wallet_id = $1) + (SELECT count(*) FROM expenses WHERE wallet_id = $1) AS count",
    [scenario.walletId],
  );
  assert.equal(movements.rows[0].count, "0");
});
