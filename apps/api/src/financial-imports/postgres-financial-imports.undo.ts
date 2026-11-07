import type { QueryExecutor } from "../database.js";
import { FinancialImportError } from "./financial-imports.errors.js";
import { undoBankPayments } from "./postgres-bank-payment-reconciliation.js";
import { undoWalletTransfers } from "./postgres-wallet-transfer-reconciliation.js";
import type { FinancialImportSession } from "./financial-imports.types.js";
import { getSessionWithItems, refreshCounters } from "./postgres-financial-imports.session.js";

// Undoing a completed import: every movement it created is released, and the import is only undone
// when nothing it produced has changed since. The locks are taken in the same order as everywhere
// else — movements first, then the statements they belong to — so a concurrent change waits instead
// of deadlocking, and a movement edited meanwhile blocks the undo instead of being overwritten.
export async function undoImportInTransaction(
  transaction: QueryExecutor,
  userId: string,
  walletId: string,
  importId: string,
): Promise<FinancialImportSession | null> {
  const session = await transaction.query<{ id: string }>(
    `SELECT id FROM import_sessions
     WHERE id = $1 AND wallet_id = $2 AND status = 'completed'
     FOR UPDATE`,
    [importId, walletId],
  );
  if (!session.rows[0]) return null;
  const targets = await transaction.query<{
    id: string;
    type: "income" | "expense" | "card_credit" | "transfer";
    resulting_income_id: string | null;
    resulting_expense_id: string | null;
    resulting_card_credit_id: string | null;
    resulting_statement_payment_id: string | null;
    resulting_wallet_transfer_id: string | null;
    resulting_updated_at: string | Date | null;
  }>(
    `SELECT item.id, item.type, item.resulting_income_id, item.resulting_expense_id,
            item.resulting_card_credit_id, item.resulting_statement_payment_id,
            item.resulting_wallet_transfer_id, item.resulting_updated_at
     FROM import_items AS item
     WHERE item.import_session_id = $1
       AND item.wallet_id = $2
       AND item.validation_status = 'imported'
     ORDER BY item.sequence
     FOR UPDATE OF item`,
    [importId, walletId],
  );
  if (targets.rows.length === 0) return null;

  const incomeIds = targets.rows.flatMap((target) => target.resulting_income_id ? [target.resulting_income_id] : []);
  const expenseIds = targets.rows.flatMap((target) => target.resulting_expense_id ? [target.resulting_expense_id] : []);
  const creditIds = targets.rows.flatMap((target) => target.resulting_card_credit_id ? [target.resulting_card_credit_id] : []);
  const paymentIds = targets.rows.flatMap((target) => target.resulting_statement_payment_id ? [target.resulting_statement_payment_id] : []);
  const transferIds = targets.rows.flatMap((target) => target.resulting_wallet_transfer_id ? [target.resulting_wallet_transfer_id] : []);
  if (paymentIds.length > 0) {
    await transaction.query(
      `SELECT id FROM credit_card_statement_payments
       WHERE wallet_id = $1 AND id = ANY($2::uuid[])
       ORDER BY id
       FOR UPDATE`,
      [walletId, paymentIds],
    );
  }
  if (incomeIds.length > 0) {
    await transaction.query(
      `SELECT id FROM incomes
       WHERE wallet_id = $1 AND id = ANY($2::uuid[])
       ORDER BY id
       FOR UPDATE`,
      [walletId, incomeIds],
    );
  }
  if (expenseIds.length > 0) {
    await transaction.query(
      `SELECT id FROM expenses
       WHERE wallet_id = $1 AND id = ANY($2::uuid[])
       ORDER BY id
       FOR UPDATE`,
      [walletId, expenseIds],
    );
  }
  // Same lock order as the expenses repository (movement rows before their statement) to avoid deadlocks.
  if (creditIds.length > 0) {
    await transaction.query(
      `SELECT id FROM credit_card_statement_credits
       WHERE wallet_id = $1 AND id = ANY($2::uuid[])
       ORDER BY id
       FOR UPDATE`,
      [walletId, creditIds],
    );
  }
  // Statements touched by this import, locked so a concurrent payment cannot slip in.
  const affectedStatements = await transaction.query<{ id: string; paid_date: string | Date | null }>(
    `SELECT statement.id, statement.paid_date
     FROM credit_card_statements AS statement
     WHERE statement.wallet_id = $1
       AND (
         statement.id IN (SELECT credit_card_statement_id FROM expenses WHERE wallet_id = $1 AND id = ANY($2::uuid[]) AND credit_card_statement_id IS NOT NULL)
         OR statement.id IN (SELECT credit_card_statement_id FROM credit_card_statement_credits WHERE wallet_id = $1 AND id = ANY($3::uuid[]))
       )
     ORDER BY statement.id
     FOR UPDATE`,
    [walletId, expenseIds, creditIds],
  );
  if (affectedStatements.rows.some((statement) => statement.paid_date !== null)) return null;

  const validation = await transaction.query<{ blocked: boolean }>(
    `SELECT EXISTS (
       SELECT 1
       FROM import_items AS item
       WHERE item.import_session_id = $1
         AND item.wallet_id = $2
         AND item.validation_status = 'imported'
         AND (
           (item.type = 'income' AND (
             item.resulting_income_id IS NULL
             OR NOT EXISTS (
               SELECT 1 FROM incomes AS income
               WHERE income.id = item.resulting_income_id
                 AND income.wallet_id = item.wallet_id
                 AND income.updated_at = item.resulting_updated_at
             )
           ))
           OR
           (item.type = 'expense' AND (
             item.resulting_expense_id IS NULL
             OR NOT EXISTS (
               SELECT 1 FROM expenses AS expense
               WHERE expense.id = item.resulting_expense_id
                 AND expense.wallet_id = item.wallet_id
                 AND expense.updated_at = item.resulting_updated_at
             )
           ))
           OR
           (item.type = 'card_credit' AND (
             item.resulting_card_credit_id IS NULL
             OR NOT EXISTS (
               SELECT 1 FROM credit_card_statement_credits AS credit
               WHERE credit.id = item.resulting_card_credit_id
                 AND credit.wallet_id = item.wallet_id
                 AND credit.updated_at = item.resulting_updated_at
             )
           ))
           OR
           (item.type = 'transfer' AND item.resulting_wallet_transfer_id IS NULL AND (
             item.resulting_statement_payment_id IS NULL
             OR NOT EXISTS (
               SELECT 1 FROM credit_card_statement_payments AS payment
               WHERE payment.id = item.resulting_statement_payment_id
                 AND payment.wallet_id = item.wallet_id
                 AND payment.updated_at = item.resulting_updated_at
             )
           ))
           OR
           (item.type = 'transfer' AND item.resulting_wallet_transfer_id IS NOT NULL AND NOT EXISTS (
             SELECT 1 FROM wallet_transfers AS transfer
             WHERE transfer.id = item.resulting_wallet_transfer_id
               AND (transfer.from_wallet_id = item.wallet_id OR transfer.to_wallet_id = item.wallet_id)
               AND transfer.updated_at = item.resulting_updated_at
           ))
         )
     ) AS blocked`,
    [importId, walletId],
  );
  if (validation.rows[0]?.blocked !== false) return null;

  await transaction.query(
    `UPDATE import_items
     SET validation_status = 'uncategorized',
         category_id = NULL,
         subcategory_id = NULL,
         categorization_source = NULL,
         resulting_income_id = NULL,
         resulting_expense_id = NULL,
         resulting_card_credit_id = NULL,
         resulting_statement_payment_id = NULL,
         resulting_wallet_transfer_id = NULL,
         transfer_counterpart_wallet_id = NULL,
         wallet_transfer_id = NULL,
         resulting_updated_at = NULL,
         error_message = 'Selecione uma categoria para importar a movimentação.',
         is_repairable = false,
         updated_at = now()
     WHERE import_session_id = $1 AND wallet_id = $2 AND validation_status = 'imported'`,
    [importId, walletId],
  );
  await transaction.query(
    `UPDATE import_items
     SET category_id = NULL,
         subcategory_id = NULL,
         categorization_source = NULL,
         updated_at = now()
     WHERE import_session_id = $1
       AND wallet_id = $2
       AND (category_id IS NOT NULL OR subcategory_id IS NOT NULL)`,
    [importId, walletId],
  );
  if (incomeIds.length > 0) {
    await transaction.query("DELETE FROM incomes WHERE wallet_id = $1 AND id = ANY($2::uuid[])", [walletId, incomeIds]);
  }
  await undoBankPayments(transaction, walletId, paymentIds);
  await undoWalletTransfers(transaction, walletId, transferIds);
  if (creditIds.length > 0) {
    await transaction.query("DELETE FROM credit_card_statement_credits WHERE wallet_id = $1 AND id = ANY($2::uuid[])", [walletId, creditIds]);
  }
  if (expenseIds.length > 0) {
    await transaction.query("DELETE FROM expenses WHERE wallet_id = $1 AND id = ANY($2::uuid[])", [walletId, expenseIds]);
  }
  // A statement paid by another source keeps its payment, so it survives this undo without its
  // purchases instead of being removed with the payment cascading away.
  const affectedStatementIds = affectedStatements.rows.map((statement) => statement.id);
  if (affectedStatementIds.length > 0) {
    await transaction.query(
      `DELETE FROM credit_card_statements AS statement
       WHERE statement.wallet_id = $1
         AND statement.id = ANY($2::uuid[])
         AND statement.paid_date IS NULL
         AND NOT EXISTS (SELECT 1 FROM expenses WHERE credit_card_statement_id = statement.id AND wallet_id = statement.wallet_id)
         AND NOT EXISTS (SELECT 1 FROM credit_card_statement_credits WHERE credit_card_statement_id = statement.id AND wallet_id = statement.wallet_id)
         AND NOT EXISTS (SELECT 1 FROM credit_card_statement_payments WHERE credit_card_statement_id = statement.id AND wallet_id = statement.wallet_id)`,
      [walletId, affectedStatementIds],
    );
  }
  await transaction.query(
    `UPDATE import_sessions
     SET status = 'undone',
         undone_at = now(),
         updated_at = now()
     WHERE id = $1 AND wallet_id = $2`,
    [importId, walletId],
  );
  await refreshCounters(transaction, walletId, importId);
  return getSessionWithItems(transaction, walletId, userId, importId);
}
