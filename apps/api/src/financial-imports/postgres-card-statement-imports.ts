import type { QueryExecutor } from "../database.js";
import { calculateDueDate } from "../credit-cards/billing-cycle.js";
import { FinancialImportError } from "./financial-imports.errors.js";
import { normalizeFinancialImportDescription } from "./financial-imports.fingerprint.js";
import type {
  FinancialImportItem,
  FinancialImportItemType,
  FinancialImportStatementPreview,
  ImportCreditCard,
  ParsedFinancialImportItem,
} from "./financial-imports.types.js";

// Credit card statement imports (DEV-56): statement assignment, paid-statement guards, statement
// previews and the posting of purchases and refunds/chargebacks. Kept apart from the generic import
// repository so each module stays focused.

function dateValue(value: string | Date | null): string {
  if (value === null) return "";
  return value instanceof Date ? value.toISOString().slice(0, 10) : value.slice(0, 10);
}

// Exact decimal arithmetic for amounts with up to two decimal places.
function toCents(value: string): bigint {
  const match = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(value.trim());
  if (!match) throw new Error("Invalid money amount");
  const cents = BigInt(match[2]!) * 100n + BigInt((match[3] ?? "").padEnd(2, "0"));
  return match[1] === "-" ? -cents : cents;
}

// ISO dates (YYYY-MM-DD) sort chronologically by ordinal comparison.
function compareIsoDates(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function fromCents(value: bigint): string {
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  return `${negative ? "-" : ""}${absolute / 100n}.${(absolute % 100n).toString().padStart(2, "0")}`;
}

// Strips refund wording so a refund line can be matched with the purchase it reverses.
function normalizeRefundDescription(value: string | null): string {
  return normalizeFinancialImportDescription(value)
    .replace(/^(estorno|reembolso|cancelamento|credito|crédito|devolucao|devolução)(\s+(de|do|da))?\s+/u, "")
    .replace(/["'“”]/gu, "")
    .trim();
}

export function paidStatementMessage(closingDate: string): string {
  const [year, month, day] = closingDate.split("-");
  return `A fatura com fechamento em ${day}/${month}/${year} já foi paga. Escolha outra fatura para este item.`;
}

// Statement totals of the items that will be (or were) imported, grouped by closing date.
export async function previewStatements(
  executor: QueryExecutor,
  walletId: string,
  card: ImportCreditCard,
  items: FinancialImportItem[],
): Promise<FinancialImportStatementPreview[]> {
  const totals = new Map<string, { purchases: bigint; credits: bigint }>();
  for (const item of items) {
    if (!item.statementClosingDate || (item.type !== "expense" && item.type !== "card_credit")) continue;
    if (item.validationStatus !== "valid" && item.validationStatus !== "imported") continue;
    const current = totals.get(item.statementClosingDate) ?? { purchases: 0n, credits: 0n };
    if (item.type === "expense") current.purchases += toCents(item.amount);
    else current.credits += toCents(item.amount);
    totals.set(item.statementClosingDate, current);
  }
  const closingDates = [...totals.keys()].sort(compareIsoDates);
  if (closingDates.length === 0) return [];
  const paid = await executor.query<{ closing_date: string }>(
    `SELECT closing_date::text AS closing_date
     FROM credit_card_statements
     WHERE wallet_id = $1 AND credit_card_id = $2 AND closing_date = ANY($3::date[]) AND paid_date IS NOT NULL`,
    [walletId, card.id, closingDates],
  );
  const paidDates = new Set(paid.rows.map((row) => row.closing_date));
  return closingDates.map((closingDate) => {
    const total = totals.get(closingDate)!;
    return {
      closingDate,
      dueDate: calculateDueDate(closingDate, card.closingDay, card.dueDay),
      purchasesAmount: fromCents(total.purchases),
      creditsAmount: fromCents(total.credits),
      totalAmount: fromCents(total.purchases - total.credits),
      isPaid: paidDates.has(closingDate),
    };
  });
}

// Revalidation at confirmation: a statement may have been paid after the preview was built.
export async function markValidItemsInPaidStatements(
  executor: QueryExecutor,
  walletId: string,
  importId: string,
  card: ImportCreditCard,
): Promise<number> {
  const blocked = await executor.query<{ id: string; statement_closing_date: string }>(
    `SELECT item.id, item.statement_closing_date::text AS statement_closing_date
     FROM import_items AS item
     JOIN credit_card_statements AS statement
       ON statement.wallet_id = item.wallet_id
      AND statement.credit_card_id = $3
      AND statement.closing_date = item.statement_closing_date
     WHERE item.import_session_id = $1
       AND item.wallet_id = $2
       AND item.validation_status = 'valid'
       AND statement.paid_date IS NOT NULL`,
    [importId, walletId, card.id],
  );
  for (const row of blocked.rows) {
    await executor.query(
      `UPDATE import_items
       SET validation_status = 'invalid', error_message = $3, is_repairable = true, updated_at = now()
       WHERE id = $1 AND wallet_id = $2 AND validation_status = 'valid'`,
      [row.id, walletId, paidStatementMessage(row.statement_closing_date)],
    );
  }
  return blocked.rows.length;
}

// Resolves the credit payment method and the (locked, unpaid) statements the items are posted to.
export async function prepareCardPosting(
  executor: QueryExecutor,
  walletId: string,
  card: ImportCreditCard,
  items: Array<{ type: FinancialImportItemType; statement_closing_date: string | Date | null }>,
): Promise<{ paymentMethodId: string; statementIds: Map<string, string> }> {
  const method = await executor.query<{ id: string }>(
    `SELECT id FROM payment_methods
     WHERE wallet_id = $1 AND nature = 'credit_card' AND is_active
     ORDER BY created_at, id
     LIMIT 1`,
    [walletId],
  );
  const paymentMethodId = method.rows[0]?.id;
  if (!paymentMethodId) {
    throw new FinancialImportError("Cadastre ou ative uma forma de pagamento do tipo cartão de crédito nesta carteira.", 409);
  }
  const closingDates = [...new Set(items
    .filter((item) => item.type === "expense" || item.type === "card_credit")
    .map((item) => item.statement_closing_date === null ? "" : dateValue(item.statement_closing_date)))];
  if (closingDates.includes("")) {
    throw new FinancialImportError("Uma movimentação da fatura não possui fatura de destino.", 409);
  }
  const statementIds = new Map<string, string>();
  for (const closingDate of closingDates.sort(compareIsoDates)) {
    await executor.query(
      `INSERT INTO credit_card_statements (wallet_id, credit_card_id, closing_date, due_date)
       VALUES ($1, $2, $3::date, $4::date)
       ON CONFLICT (credit_card_id, closing_date) DO NOTHING`,
      [walletId, card.id, closingDate, calculateDueDate(closingDate, card.closingDay, card.dueDay)],
    );
    const statement = await executor.query<{ id: string; paid_date: string | Date | null }>(
      `SELECT id, paid_date FROM credit_card_statements
       WHERE wallet_id = $1 AND credit_card_id = $2 AND closing_date = $3::date
       FOR UPDATE`,
      [walletId, card.id, closingDate],
    );
    const row = statement.rows[0];
    if (!row) throw new FinancialImportError("Não foi possível preparar a fatura de destino.", 409);
    if (row.paid_date !== null) throw new FinancialImportError(paidStatementMessage(closingDate), 409);
    statementIds.set(closingDate, row.id);
  }
  return { paymentMethodId, statementIds };
}

// Locks the card purchases a refund may be linked to. Called before the statements are locked, so the
// order matches PostgresExpensesRepository (expense rows before their statement) and cannot deadlock.
export async function lockCardPurchasesForCredits(
  executor: QueryExecutor,
  walletId: string,
  card: ImportCreditCard,
  items: Array<{ type: FinancialImportItemType; transaction_date: string | Date }>,
): Promise<void> {
  const creditDates = items.filter((item) => item.type === "card_credit").map((item) => dateValue(item.transaction_date));
  if (creditDates.length === 0) return;
  await executor.query(
    `SELECT expense.id
     FROM expenses AS expense
     JOIN credit_card_statements AS statement
       ON statement.id = expense.credit_card_statement_id AND statement.wallet_id = expense.wallet_id
     WHERE expense.wallet_id = $1
       AND statement.credit_card_id = $2
       AND expense.date <= $3::date
     ORDER BY expense.id
     FOR UPDATE OF expense`,
    [walletId, card.id, creditDates.sort(compareIsoDates).at(-1)],
  );
}

// Refunds and chargebacks become statement credits. A credit is linked to the purchase it reverses
// only when exactly one purchase of the same card matches its description and still has enough
// refundable amount; otherwise it stays unlinked instead of guessing.
export async function importCardCredits(
  executor: QueryExecutor,
  userId: string,
  walletId: string,
  importId: string,
  card: ImportCreditCard,
  statementIds: Map<string, string>,
  items: Array<{ id: string; type: FinancialImportItemType; amount: string; transaction_date: string | Date; description: string | null; statement_closing_date: string | Date | null }>,
): Promise<void> {
  const credits = items.filter((item) => item.type === "card_credit");
  if (credits.length === 0) return;
  const latestCreditDate = credits.map((item) => dateValue(item.transaction_date)).sort(compareIsoDates).at(-1)!;
  const purchases = await executor.query<{ id: string; amount: string; date: string; description: string | null; credited: string }>(
    `SELECT expense.id, expense.amount::text AS amount, expense.date::text AS date, expense.description,
            COALESCE((SELECT SUM(linked.amount) FROM credit_card_statement_credits AS linked
                      WHERE linked.original_expense_id = expense.id AND linked.wallet_id = expense.wallet_id), 0.00)::text AS credited
     FROM expenses AS expense
     JOIN credit_card_statements AS statement
       ON statement.id = expense.credit_card_statement_id AND statement.wallet_id = expense.wallet_id
     WHERE expense.wallet_id = $1
       AND statement.credit_card_id = $2
       AND expense.date <= $3::date
     ORDER BY expense.id`,
    [walletId, card.id, latestCreditDate],
  );
  const refundable = new Map(purchases.rows.map((purchase) => [purchase.id, toCents(purchase.amount) - toCents(purchase.credited)]));
  for (const credit of credits) {
    const creditDate = dateValue(credit.transaction_date);
    const creditAmount = toCents(credit.amount);
    const reference = normalizeRefundDescription(credit.description);
    const matches = reference
      ? purchases.rows.filter((purchase) => (
        purchase.date <= creditDate
        && normalizeRefundDescription(purchase.description) === reference
        && (refundable.get(purchase.id) ?? 0n) >= creditAmount
      ))
      : [];
    const originalExpenseId = matches.length === 1 ? matches[0]!.id : null;
    if (originalExpenseId) refundable.set(originalExpenseId, refundable.get(originalExpenseId)! - creditAmount);
    const statementId = statementIds.get(dateValue(credit.statement_closing_date));
    if (!statementId) throw new FinancialImportError("Um estorno da fatura não possui fatura de destino válida.", 409);
    // Insert and link in one statement: updated_at must keep its microsecond precision, which a
    // round trip through a JavaScript Date would truncate and later read as "changed".
    const linked = await executor.query<{ id: string }>(
      `WITH inserted AS (
         INSERT INTO credit_card_statement_credits (
           wallet_id, user_id, credit_card_statement_id, original_expense_id, amount, date, description
         ) VALUES ($3, $4, $5, $6::uuid, $7::numeric, $8::date, $9)
         RETURNING id, updated_at
       )
       UPDATE import_items AS item
       SET validation_status = 'imported',
           resulting_card_credit_id = inserted.id,
           resulting_updated_at = inserted.updated_at,
           error_message = NULL,
           is_repairable = false,
           updated_at = now()
       FROM inserted
       WHERE item.id = $1 AND item.import_session_id = $2 AND item.wallet_id = $3 AND item.validation_status = 'valid'
       RETURNING item.id`,
      [credit.id, importId, walletId, userId, statementId, originalExpenseId, credit.amount, creditDate, credit.description],
    );
    if (linked.rows.length !== 1) throw new FinancialImportError("Um estorno da fatura foi alterado durante a confirmação.", 409);
  }
}

// Purchases and credits cannot be posted to a statement that was already paid.
export async function markItemsInPaidStatements(
  executor: QueryExecutor,
  walletId: string,
  creditCardId: string,
  items: ParsedFinancialImportItem[],
): Promise<ParsedFinancialImportItem[]> {
  const closingDates = [...new Set(items.flatMap((item) => item.statementClosingDate ? [item.statementClosingDate] : []))];
  if (closingDates.length === 0) return items;
  const paid = await executor.query<{ closing_date: string }>(
    `SELECT closing_date::text AS closing_date
     FROM credit_card_statements
     WHERE wallet_id = $1 AND credit_card_id = $2 AND closing_date = ANY($3::date[]) AND paid_date IS NOT NULL`,
    [walletId, creditCardId, closingDates],
  );
  const paidDates = new Set(paid.rows.map((row) => row.closing_date));
  return items.map((item) => {
    const closingDate = item.statementClosingDate;
    if (!closingDate || !paidDates.has(closingDate) || item.type === "transfer") return item;
    if (item.validationStatus === "invalid" || item.validationStatus === "duplicate") return item;
    return { ...item, validationStatus: "invalid", errorMessage: paidStatementMessage(closingDate), isRepairable: true };
  });
}
