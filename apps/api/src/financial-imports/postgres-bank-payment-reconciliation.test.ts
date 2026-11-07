import assert from "node:assert/strict";
import test from "node:test";
import { looksLikeCardPayment, suggestStatement } from "./postgres-bank-payment-reconciliation.js";
import type { BankPaymentCandidate } from "./financial-imports.types.js";

test("a bank line looks like a card payment only when the payment word is next to the card word", () => {
  assert.equal(looksLikeCardPayment("PAGAMENTO CARTAO"), true);
  assert.equal(looksLikeCardPayment("PGTO FATURA CARTAO"), true);
  assert.equal(looksLikeCardPayment("PAGAMENTO FATURA CARTAO DE CREDITO"), true);
  assert.equal(looksLikeCardPayment("CARTAO VISA - PAGAMENTO"), true);
  // "Pagamento" alone is an ordinary expense.
  assert.equal(looksLikeCardPayment("PAGAMENTO DE BOLETO"), false);
  assert.equal(looksLikeCardPayment("COMPRA NO CARTAO"), false);
  assert.equal(looksLikeCardPayment(null), false);
  assert.equal(looksLikeCardPayment(""), false);
  // A long description may mention both words about unrelated things. The two have to be close to
  // each other, otherwise an ordinary debit would be reconciled as a card payment and would never
  // post the expense it really is.
  assert.equal(
    looksLikeCardPayment("PAGAMENTO DE BOLETO ENERGIA ELETRICA REFERENTE A OUTUBRO - SEGUNDA VIA DO CARTAO"),
    false,
  );
  assert.equal(
    looksLikeCardPayment("CARTAO BLOQUEADO POR SEGURANCA CONFORME SOLICITADO NO ATENDIMENTO - PAGAMENTO DE TARIFA"),
    false,
  );
});

test("a statement is suggested only when a single candidate matches the paid amount exactly", () => {
  const candidate = (statementId: string, outstandingAmount: string): BankPaymentCandidate => ({
    statementId,
    creditCardId: "card",
    creditCardName: "Principal",
    closingDate: "2026-10-10",
    dueDate: "2026-10-20",
    outstandingAmount,
  });

  assert.equal(suggestStatement([candidate("a", "400.00")], "-400.00"), "a");
  // Two candidates with the same outstanding amount are ambiguous, so the user chooses.
  assert.equal(suggestStatement([candidate("a", "400.00"), candidate("b", "400.00")], "-400.00"), null);
  assert.equal(suggestStatement([candidate("a", "400.00")], "-150.00"), null);
  assert.equal(suggestStatement([], "-400.00"), null);
});
