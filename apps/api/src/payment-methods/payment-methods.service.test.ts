import assert from "node:assert/strict";
import test from "node:test";
import type { Database, QueryExecutor } from "../database.js";
import { PaymentMethodConflictError, PaymentMethodError } from "./payment-methods.errors.js";
import { PaymentMethodsService } from "./payment-methods.service.js";
import { PostgresPaymentMethodsRepository } from "./postgres-payment-methods.repository.js";
import type { PaymentMethodNature } from "./payment-methods.types.js";

const PAYMENT_METHOD_ID = "00000000-0000-4000-8000-000000000001";
const WALLET_ID = "00000000-0000-4000-8000-000000000002";

function databaseReturning(row: Record<string, unknown> | null): Database {
  const executor: QueryExecutor = {
    query: async <Row>() => ({ rows: (row ? [row] : []) as Row[], rowCount: row ? 1 : 0 }),
  };
  return { ...executor, transaction: async (work) => work(executor) };
}

test("Postgres payment method repository maps list, create, and update rows", async () => {
  const row = { id: PAYMENT_METHOD_ID, name: "Pix", nature: "immediate" as PaymentMethodNature, is_active: true };
  const repository = new PostgresPaymentMethodsRepository(databaseReturning(row));
  assert.deepEqual(await repository.list("user", WALLET_ID), [{ id: PAYMENT_METHOD_ID, name: "Pix", nature: "immediate", isActive: true }]);
  assert.deepEqual(await repository.create("user", WALLET_ID, "Pix", "immediate"), { id: PAYMENT_METHOD_ID, name: "Pix", nature: "immediate", isActive: true });
  assert.deepEqual(await repository.update("user", WALLET_ID, PAYMENT_METHOD_ID, { isActive: false }), { id: PAYMENT_METHOD_ID, name: "Pix", nature: "immediate", isActive: true });
  assert.equal(await new PostgresPaymentMethodsRepository(databaseReturning(null)).update("user", WALLET_ID, PAYMENT_METHOD_ID, { name: "Outro" }), null);
});

test("payment methods validate names and map duplicate errors", async () => {
  const conflictRepository = {
    list: async () => [],
    create: async () => { throw { code: "23505" }; },
    update: async () => { throw { code: "23503" }; },
  };
  const service = new PaymentMethodsService(conflictRepository);
  await assert.rejects(service.create("user", WALLET_ID, "   ", "immediate"), PaymentMethodError);
  await assert.rejects(service.create("user", WALLET_ID, "x".repeat(101), "immediate"), PaymentMethodError);
  await assert.rejects(service.create("user", WALLET_ID, "Cartão", "credit_card"), PaymentMethodConflictError);
  await assert.rejects(service.update("user", WALLET_ID, PAYMENT_METHOD_ID, { name: "Outro" }), PaymentMethodConflictError);
  await assert.rejects(service.update("user", WALLET_ID, "invalid", { name: "Outro" }), /Forma de pagamento não encontrada/);
  await assert.rejects(service.update("user", WALLET_ID, PAYMENT_METHOD_ID, {}), /Informe ao menos uma alteração/);
});
