import assert from "node:assert/strict";
import test from "node:test";
import type { QueryExecutor } from "../database.js";
import { FinancialImportError } from "./financial-imports.errors.js";
import { cardPurchasePosting, prepareCardPosting } from "./postgres-card-statement-imports.js";

// `prepareCardPosting` takes the executor, so these cases need no schema: the queries it makes are
// the observable behaviour, and a fake executor records them. The integration test covers the posting
// itself; what matters here is which queries happen at all.

const card = { id: "11111111-1111-4111-8111-111111111111", closingDay: 10, dueDay: 20 };
const walletId = "22222222-2222-4222-8222-222222222222";
const statementId = "33333333-3333-4333-8333-333333333333";

function createExecutor(paymentMethodRows: Array<{ id: string }>) {
  const queries: string[] = [];
  const executor: QueryExecutor = {
    query: async <Row extends import("pg").QueryResultRow>(queryText: string) => {
      queries.push(queryText);
      if (queryText.includes("FROM payment_methods")) {
        return { rows: paymentMethodRows as unknown as Row[], rowCount: paymentMethodRows.length };
      }
      if (queryText.includes("SELECT id, paid_date FROM credit_card_statements")) {
        return { rows: [{ id: statementId, paid_date: null }] as unknown as Row[], rowCount: 1 };
      }
      return { rows: [] as Row[], rowCount: 0 };
    },
  };
  return { executor, queries };
}

// The payment method exists to post a purchase. Demanding it from a session that carries only refunds
// refused a legitimate import with a 409 asking for something nothing in the session would use.
test("a statement session with only refunds is prepared without a credit payment method", async () => {
  const { executor, queries } = createExecutor([]);

  const result = await prepareCardPosting(executor, walletId, card, [
    { type: "card_credit", statement_closing_date: "2026-10-10" },
    { type: "card_credit", statement_closing_date: "2026-10-10" },
  ]);

  assert.equal(result.paymentMethodId, null);
  assert.deepEqual([...result.statementIds.entries()], [["2026-10-10", statementId]]);
  // Not merely tolerated: the payment method is never even looked up, so an inactive or missing one
  // cannot affect a session that has no purchase to post.
  assert.equal(queries.some((queryText) => queryText.includes("FROM payment_methods")), false);
});

test("a statement session with a purchase still requires an active credit payment method", async () => {
  const { executor, queries } = createExecutor([]);

  await assert.rejects(
    prepareCardPosting(executor, walletId, card, [
      { type: "card_credit", statement_closing_date: "2026-10-10" },
      { type: "expense", statement_closing_date: "2026-10-10" },
    ]),
    (error: unknown) => error instanceof FinancialImportError
      && error.statusCode === 409
      && /forma de pagamento do tipo cartão de crédito/.test(error.message),
  );
  assert.equal(queries.some((queryText) => queryText.includes("FROM payment_methods")), true);
});

test("a statement session with a purchase resolves the payment method it will post with", async () => {
  const methodId = "44444444-4444-4444-8444-444444444444";
  const { executor } = createExecutor([{ id: methodId }]);

  const result = await prepareCardPosting(executor, walletId, card, [
    { type: "expense", statement_closing_date: "2026-10-10" },
  ]);

  assert.equal(result.paymentMethodId, methodId);
});

// `cardPurchasePosting` is the single place that decides what a purchase posts with, so its guard
// needs its own cases: `prepareCardPosting` refuses first in practice, which is exactly why a silent
// null here would never be noticed.
test("only a purchase posts with the payment method and the statement", () => {
  const posting = { paymentMethodId: "44444444-4444-4444-8444-444444444444", statementIds: new Map([["2026-10-10", statementId]]) };

  assert.deepEqual(cardPurchasePosting("expense", posting), posting);
  assert.equal(cardPurchasePosting("card_credit", posting), null);
  assert.equal(cardPurchasePosting("income", posting), null);
  assert.equal(cardPurchasePosting("expense", null), null);
});

test("a purchase without its payment method is refused instead of posted as a plain expense", () => {
  assert.throws(
    () => cardPurchasePosting("expense", { paymentMethodId: null, statementIds: new Map() }),
    (error: unknown) => error instanceof FinancialImportError
      && error.statusCode === 409
      && /forma de pagamento do tipo cartão de crédito/.test(error.message),
  );
});
