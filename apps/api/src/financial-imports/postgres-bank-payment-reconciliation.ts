import type { QueryExecutor } from "../database.js";
import { registerStatementPayment, walletOwnerUserId } from "../credit-cards/postgres-credit-cards.repository.js";
import { CreditCardError } from "../credit-cards/credit-cards.errors.js";
import { FinancialImportError } from "./financial-imports.errors.js";
import type { BankPaymentCandidate, FinancialImportItem, ParsedFinancialImportItem } from "./financial-imports.types.js";

// Reconciling a card payment found in a bank statement (DEV-57): the outgoing line is matched with
// an open statement and, once confirmed, becomes a statement payment. It never creates an expense,
// because the purchases of that statement are already the expenses.

// How far from the due date a payment may still belong to a statement.
const DUE_DATE_WINDOW_DAYS = 15;
const MAX_CANDIDATES = 5;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function dateValue(value: string | Date | null): string {
  if (value === null) return "";
  return value instanceof Date ? value.toISOString().slice(0, 10) : value.slice(0, 10);
}

function toCents(value: string): bigint {
  const match = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(value.trim());
  if (!match) throw new FinancialImportError("O valor da movimentação é inválido.", 422);
  const cents = BigInt(match[2]!) * 100n + BigInt((match[3] ?? "").padEnd(2, "0"));
  return match[1] === "-" ? -cents : cents;
}

// In a bank statement a card payment is an ordinary debit, so the suggestion also looks at the
// description. "Pagamento" alone is not enough: it must point at a card or a statement, otherwise an
// ordinary expense ("pagamento de boleto") would be taken for a card payment.
const CARD_PAYMENT_DESCRIPTION = /\b(pag(?:amento|to)?|pgto)\b[^]*\b(cart[aã]o|fatura|credito|cr[eé]dito)\b|\b(cart[aã]o|fatura)\b[^]*\b(pag(?:amento|to)?|pgto)\b/i;

export function looksLikeCardPayment(description: string | null | undefined): boolean {
  return CARD_PAYMENT_DESCRIPTION.test(description ?? "");
}

// Only an outgoing line can pay a statement: an already reconciled transfer, or a debit whose
// description points at a card payment.
export function isBankPaymentCandidateItem(item: { type: string; signedAmount: string | null; description?: string | null }): boolean {
  if (item.signedAmount === null || !item.signedAmount.startsWith("-")) return false;
  return item.type === "transfer" || (item.type === "expense" && looksLikeCardPayment(item.description));
}

interface CandidateRow {
  statement_id: string;
  credit_card_id: string;
  credit_card_name: string;
  closing_date: string | Date;
  due_date: string | Date;
  outstanding_amount: string;
}

// Open statements of the wallet whose due date is near the payment date, closest first.
export async function findStatementCandidates(
  executor: QueryExecutor,
  walletId: string,
  paymentDate: string,
): Promise<BankPaymentCandidate[]> {
  const result = await executor.query<CandidateRow>(
    `SELECT statement.id AS statement_id,
            statement.credit_card_id,
            card.alias AS credit_card_name,
            statement.closing_date,
            statement.due_date,
            balance.outstanding::text AS outstanding_amount
     FROM credit_card_statements AS statement
     JOIN credit_cards AS card
       ON card.id = statement.credit_card_id AND card.wallet_id = statement.wallet_id
     CROSS JOIN LATERAL (
       SELECT ((SELECT COALESCE(SUM(amount), 0.00) FROM expenses
                WHERE credit_card_statement_id = statement.id AND wallet_id = statement.wallet_id)
             - (SELECT COALESCE(SUM(amount), 0.00) FROM credit_card_statement_credits
                WHERE credit_card_statement_id = statement.id AND wallet_id = statement.wallet_id)
             - (SELECT COALESCE(SUM(amount), 0.00) FROM credit_card_statement_payments
                WHERE credit_card_statement_id = statement.id AND wallet_id = statement.wallet_id))::numeric(14, 2) AS outstanding
     ) AS balance
     WHERE statement.wallet_id = $1
       AND statement.paid_date IS NULL
       AND balance.outstanding > 0
       AND statement.due_date BETWEEN $2::date - $3::integer AND $2::date + $3::integer
     ORDER BY abs(statement.due_date - $2::date), statement.due_date, statement.id
     LIMIT $4`,
    [walletId, paymentDate, DUE_DATE_WINDOW_DAYS, MAX_CANDIDATES],
  );
  return result.rows.map((row) => ({
    statementId: row.statement_id,
    creditCardId: row.credit_card_id,
    creditCardName: row.credit_card_name,
    closingDate: dateValue(row.closing_date),
    dueDate: dateValue(row.due_date),
    outstandingAmount: row.outstanding_amount,
  }));
}

// Suggests a statement only when a single candidate matches the paid amount exactly. Anything
// ambiguous is left for the user, who sees every candidate.
export function suggestStatement(candidates: BankPaymentCandidate[], signedAmount: string): string | null {
  const paid = -toCents(signedAmount);
  const exact = candidates.filter((candidate) => toCents(candidate.outstandingAmount) === paid);
  return exact.length === 1 ? exact[0]!.statementId : null;
}

export function reconciliationMessage(candidateCount: number): string {
  if (candidateCount === 0) {
    return "Nenhuma fatura em aberto corresponde a este pagamento. Escolha outro tipo ou deixe-o fora da importação.";
  }
  return "Selecione a fatura que este pagamento liquida para incluí-lo na importação.";
}

// Attaches candidates and a suggestion to every outgoing transfer of a bank statement preview.
export async function reconcileBankPayments(
  executor: QueryExecutor,
  walletId: string,
  items: ParsedFinancialImportItem[],
): Promise<ParsedFinancialImportItem[]> {
  const reconciled: ParsedFinancialImportItem[] = [];
  const candidatesByDate = new Map<string, BankPaymentCandidate[]>();
  for (const item of items) {
    if (!isBankPaymentCandidateItem(item) || !item.date
      || item.validationStatus === "invalid" || item.validationStatus === "duplicate") {
      reconciled.push(item);
      continue;
    }
    let candidates = candidatesByDate.get(item.date);
    if (!candidates) {
      candidates = await findStatementCandidates(executor, walletId, item.date);
      candidatesByDate.set(item.date, candidates);
    }
    const suggestion = suggestStatement(candidates, item.signedAmount!);
    if (suggestion) {
      // A single candidate matching the amount exactly: suggested as a statement payment, which the
      // user still has to keep or change in the preview.
      reconciled.push({ ...item, type: "transfer", categoryId: null, subcategoryId: null, creditCardStatementId: suggestion, validationStatus: "valid", errorMessage: null });
    } else if (item.type === "transfer" || candidates.length > 0) {
      // Ambiguous, so nothing is confirmed: the item is presented as a statement payment waiting for
      // the user to pick the statement, and the type can still be changed back to an expense.
      reconciled.push({
        ...item,
        type: "transfer",
        categoryId: null,
        subcategoryId: null,
        creditCardStatementId: null,
        validationStatus: "uncategorized",
        errorMessage: reconciliationMessage(candidates.length),
      });
    } else {
      // No open statement matches, so the debit stays the expense the parser suggested.
      reconciled.push(item);
    }
  }
  return reconciled;
}

// Loads the candidates again when a preview is read, so the list reflects statements paid meanwhile.
export async function attachStatementCandidates(
  executor: QueryExecutor,
  walletId: string,
  items: FinancialImportItem[],
  status: string,
): Promise<FinancialImportItem[]> {
  if (status !== "preview") return items;
  const pending = items.filter((item) => item.validationStatus !== "imported"
    && (item.type === "transfer" || (item.type === "expense" && looksLikeCardPayment(item.description))));
  if (pending.length === 0) return items;
  const candidatesByDate = new Map<string, BankPaymentCandidate[]>();
  for (const date of new Set(pending.map((item) => item.date))) {
    if (date) candidatesByDate.set(date, await findStatementCandidates(executor, walletId, date));
  }
  const pendingIds = new Set(pending.map((item) => item.id));
  return items.map((item) => pendingIds.has(item.id)
    ? { ...item, statementCandidates: candidatesByDate.get(item.date) ?? [] }
    : item);
}

// Validates a statement the user chose for a payment: it must be an open statement of the wallet
// with an outstanding balance.
export async function assertReconcilableStatement(
  executor: QueryExecutor,
  walletId: string,
  statementId: string,
): Promise<void> {
  if (!UUID_PATTERN.test(statementId)) {
    throw new FinancialImportError("A fatura escolhida não foi encontrada nesta carteira.", 404);
  }
  const candidates = await executor.query<{ outstanding: string; paid_date: string | Date | null }>(
    `SELECT statement.paid_date,
            ((SELECT COALESCE(SUM(amount), 0.00) FROM expenses
              WHERE credit_card_statement_id = statement.id AND wallet_id = statement.wallet_id)
           - (SELECT COALESCE(SUM(amount), 0.00) FROM credit_card_statement_credits
              WHERE credit_card_statement_id = statement.id AND wallet_id = statement.wallet_id)
           - (SELECT COALESCE(SUM(amount), 0.00) FROM credit_card_statement_payments
              WHERE credit_card_statement_id = statement.id AND wallet_id = statement.wallet_id))::numeric(14, 2)::text AS outstanding
     FROM credit_card_statements AS statement
     WHERE statement.id = $1 AND statement.wallet_id = $2`,
    [statementId, walletId],
  );
  const statement = candidates.rows[0];
  if (!statement) throw new FinancialImportError("A fatura escolhida não foi encontrada nesta carteira.", 404);
  if (statement.paid_date !== null) throw new FinancialImportError("A fatura escolhida já foi paga.", 409);
  if (toCents(statement.outstanding) <= 0n) {
    throw new FinancialImportError("A fatura escolhida não possui saldo devedor.", 409);
  }
}

// Turns each reconciled payment into a statement payment. Purchases are untouched, so the expense
// totals never count the statement twice.
export async function importBankPayments(
  executor: QueryExecutor,
  walletId: string,
  importId: string,
  items: Array<{
    id: string;
    type: string;
    amount: string;
    transaction_date: string | Date;
    credit_card_statement_id: string | null;
  }>,
): Promise<void> {
  const payments = items.filter((item) => item.type === "transfer");
  if (payments.length === 0) return;
  const userId = await walletOwnerUserId(executor, walletId);
  for (const payment of payments) {
    if (!payment.credit_card_statement_id) {
      throw new FinancialImportError("Concilie as transferências antes de confirmar a importação.", 409);
    }
    let registered: { paymentId: string };
    try {
      registered = await registerStatementPayment(executor, {
        walletId,
        userId,
        statementId: payment.credit_card_statement_id,
        date: dateValue(payment.transaction_date),
        amount: payment.amount,
        source: "bank_statement",
      });
    } catch (error) {
      // The statement may have been settled between the preview and the confirmation.
      if (error instanceof CreditCardError) throw new FinancialImportError(error.message, error.statusCode);
      throw error;
    }
    const linked = await executor.query(
      `UPDATE import_items AS item
       SET validation_status = 'imported',
           resulting_statement_payment_id = $4,
           resulting_updated_at = (SELECT updated_at FROM credit_card_statement_payments
                                   WHERE id = $4 AND wallet_id = $3),
           error_message = NULL,
           is_repairable = false,
           updated_at = now()
       WHERE item.id = $1 AND item.import_session_id = $2 AND item.wallet_id = $3 AND item.validation_status = 'valid'`,
      [payment.id, importId, walletId, registered.paymentId],
    );
    if (linked.rowCount !== 1) {
      throw new FinancialImportError("Um pagamento de fatura foi alterado durante a confirmação.", 409);
    }
  }
}

// Undoing an import removes its payments and reopens any statement they had settled.
export async function undoBankPayments(
  executor: QueryExecutor,
  walletId: string,
  paymentIds: string[],
): Promise<void> {
  if (paymentIds.length === 0) return;
  const statements = await executor.query<{ id: string }>(
    `SELECT DISTINCT credit_card_statement_id AS id
     FROM credit_card_statement_payments
     WHERE wallet_id = $1 AND id = ANY($2::uuid[])`,
    [walletId, paymentIds],
  );
  await executor.query(
    "DELETE FROM credit_card_statement_payments WHERE wallet_id = $1 AND id = ANY($2::uuid[])",
    [walletId, paymentIds],
  );
  const statementIds = statements.rows.map((row) => row.id);
  if (statementIds.length === 0) return;
  // A statement stays settled only while its remaining payments still cover the total.
  await executor.query(
    `UPDATE credit_card_statements AS statement
     SET paid_date = NULL, updated_at = now()
     FROM (
       SELECT candidate.id,
              ((SELECT COALESCE(SUM(amount), 0.00) FROM expenses
                WHERE credit_card_statement_id = candidate.id AND wallet_id = candidate.wallet_id)
             - (SELECT COALESCE(SUM(amount), 0.00) FROM credit_card_statement_credits
                WHERE credit_card_statement_id = candidate.id AND wallet_id = candidate.wallet_id)
             - (SELECT COALESCE(SUM(amount), 0.00) FROM credit_card_statement_payments
                WHERE credit_card_statement_id = candidate.id AND wallet_id = candidate.wallet_id))::numeric(14, 2) AS outstanding
       FROM credit_card_statements AS candidate
       WHERE candidate.wallet_id = $1 AND candidate.id = ANY($2::uuid[])
     ) AS balance
     WHERE statement.id = balance.id
       AND statement.wallet_id = $1
       AND statement.paid_date IS NOT NULL
       AND balance.outstanding > 0`,
    [walletId, statementIds],
  );
}
