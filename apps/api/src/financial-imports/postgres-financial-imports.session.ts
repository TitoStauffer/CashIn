import type { QueryExecutor } from "../database.js";
import { calculateDueDate } from "../credit-cards/billing-cycle.js";
import { attachStatementCandidates } from "./postgres-bank-payment-reconciliation.js";
import { previewStatements } from "./postgres-card-statement-imports.js";
import { attachTransferOptions } from "./postgres-wallet-transfer-reconciliation.js";
import type {
  FinancialImportFormat,
  FinancialImportItem,
  FinancialImportItemStatus,
  FinancialImportItemType,
  FinancialImportKind,
  FinancialImportSession,
  FinancialImportStatus,
  ImportCreditCard,
} from "./financial-imports.types.js";
import { itemColumns, sessionColumns } from "./postgres-financial-imports.columns.js";
import { dateValue, timestampValue } from "./postgres-financial-imports.shared.js";

// How an import session is read and kept consistent: the raw row shapes, how a row becomes the
// session or the item the API returns, and the four operations every caller needs — read a session,
// read it with its items and the options they can be reconciled with, recount the summary, and lock
// the wallet's imports so two of them never run at once.

export interface ImportSessionRow {
  id: string;
  format: FinancialImportFormat;
  kind: FinancialImportKind;
  credit_card_id: string | null;
  credit_card_name: string | null;
  credit_card_closing_day: number | null;
  credit_card_due_day: number | null;
  original_filename: string;
  file_size_bytes: string | number;
  file_hash: string;
  created_by_user_id: string;
  created_by_email: string | null;
  status: FinancialImportStatus;
  item_count: number;
  valid_count: number;
  duplicate_count: number;
  invalid_count: number;
  uncategorized_count: number;
  imported_count: number;
  can_undo: boolean;
  undo_blocked_reason: string | null;
  failure_message: string | null;
  confirmed_at: string | Date | null;
  completed_at: string | Date | null;
  failed_at: string | Date | null;
  undone_at: string | Date | null;
  created_at: string | Date;
  updated_at: string | Date;
}

export interface ImportItemRow {
  id: string;
  sequence: number;
  transaction_date: string | Date | null;
  description: string | null;
  amount: string | null;
  type: FinancialImportItemType;
  category_id: string | null;
  subcategory_id: string | null;
  validation_status: FinancialImportItemStatus;
  error_message: string | null;
  is_repairable: boolean;
  duplicate_override_allowed: boolean;
  categorization_source: "rule" | "manual" | null;
  statement_closing_date: string | Date | null;
  credit_card_statement_id: string | null;
  transfer_counterpart_wallet_id: string | null;
  wallet_transfer_id: string | null;
  created_at: string | Date;
  updated_at: string | Date;
}

// The reader is needed to say whether the import is theirs; the e-mail was already decided in SQL,
// where the rule that governs it can be read next to the column it fills.
export function mapSession(row: ImportSessionRow, viewerUserId: string): FinancialImportSession {
  return {
    importedBy: {
      userId: row.created_by_user_id,
      email: row.created_by_email,
      isCurrentUser: row.created_by_user_id === viewerUserId,
    },
    id: row.id,
    format: row.format,
    kind: row.kind,
    creditCardId: row.credit_card_id,
    creditCardName: row.credit_card_name,
    creditCardClosingDay: row.credit_card_closing_day,
    creditCardDueDay: row.credit_card_due_day,
    fileName: row.original_filename,
    fileSize: Number(row.file_size_bytes),
    fileHash: row.file_hash,
    status: row.status,
    summary: {
      total: row.item_count,
      valid: row.valid_count,
      duplicate: row.duplicate_count,
      invalid: row.invalid_count,
      uncategorized: row.uncategorized_count,
      imported: row.imported_count,
    },
    canUndo: row.can_undo,
    undoBlockedReason: row.undo_blocked_reason,
    failureMessage: row.failure_message,
    confirmedAt: timestampValue(row.confirmed_at),
    completedAt: timestampValue(row.completed_at),
    failedAt: timestampValue(row.failed_at),
    undoneAt: timestampValue(row.undone_at),
    createdAt: timestampValue(row.created_at)!,
    updatedAt: timestampValue(row.updated_at)!,
  };
}

export function mapItem(row: ImportItemRow, card: ImportCreditCard | null = null): FinancialImportItem {
  const statementClosingDate = row.statement_closing_date === null ? null : dateValue(row.statement_closing_date);
  return {
    id: row.id,
    sequence: row.sequence,
    date: dateValue(row.transaction_date),
    description: row.description,
    amount: row.amount ?? "0.00",
    type: row.type,
    categoryId: row.category_id,
    subcategoryId: row.subcategory_id,
    validationStatus: row.validation_status,
    errorMessage: row.error_message,
    canEdit: row.validation_status === "valid"
      || row.validation_status === "uncategorized"
      || (row.validation_status === "invalid" && row.is_repairable),
    canIncludeDuplicate: row.validation_status === "duplicate" && row.duplicate_override_allowed,
    categorizationSource: row.categorization_source,
    ...(row.type === "transfer" ? {
      creditCardStatementId: row.credit_card_statement_id,
      transferCounterpartWalletId: row.transfer_counterpart_wallet_id,
      walletTransferId: row.wallet_transfer_id,
    } : {}),
    ...(card ? {
      statementClosingDate,
      statementDueDate: statementClosingDate ? calculateDueDate(statementClosingDate, card.closingDay, card.dueDay) : null,
    } : {}),
    createdAt: timestampValue(row.created_at)!,
    updatedAt: timestampValue(row.updated_at)!,
  };
}

export function sessionCard(row: ImportSessionRow): ImportCreditCard | null {
  return row.credit_card_id && row.credit_card_closing_day !== null && row.credit_card_due_day !== null
    ? { id: row.credit_card_id, closingDay: row.credit_card_closing_day, dueDay: row.credit_card_due_day }
    : null;
}

export async function getSessionRow(
  executor: QueryExecutor,
  walletId: string,
  userId: string,
  importId: string,
): Promise<ImportSessionRow | null> {
  const result = await executor.query<ImportSessionRow>(
    `SELECT ${sessionColumns("$3")}
     FROM import_sessions AS session
     WHERE session.id = $1 AND session.wallet_id = $2`,
    [importId, walletId, userId],
  );
  return result.rows[0] ?? null;
}

export async function getSessionWithItems(
  executor: QueryExecutor,
  walletId: string,
  userId: string,
  importId: string,
): Promise<FinancialImportSession | null> {
  const row = await getSessionRow(executor, walletId, userId, importId);
  if (!row) return null;
  const session = mapSession(row, userId);
  const card = sessionCard(row);
  const items = await executor.query<ImportItemRow>(
    `SELECT ${itemColumns}
     FROM import_items AS item
     WHERE item.import_session_id = $1 AND item.wallet_id = $2
     ORDER BY item.sequence, item.id`,
    [importId, walletId],
  );
  const mappedItems = items.rows.map((itemRow) => {
    const item = mapItem(itemRow, card);
    return session.status === "preview" ? item : { ...item, canEdit: false };
  });
  return {
    ...session,
    ...(card ? { statements: await previewStatements(executor, walletId, card, mappedItems) } : {}),
    items: card
      ? mappedItems
      : await attachTransferOptions(
        executor,
        walletId,
        userId,
        importId,
        await attachStatementCandidates(executor, walletId, mappedItems, session.status),
        session.status,
      ),
  };
}

export async function refreshCounters(
  executor: QueryExecutor,
  walletId: string,
  importId: string,
  status?: "preview",
): Promise<void> {
  await executor.query(
    `UPDATE import_sessions AS session
     SET item_count = counters.item_count,
         valid_count = counters.valid_count,
         duplicate_count = counters.duplicate_count,
         invalid_count = counters.invalid_count,
         uncategorized_count = counters.uncategorized_count,
         imported_count = counters.imported_count,
         status = COALESCE($3, session.status),
         updated_at = now()
     FROM (
       SELECT count(*)::integer AS item_count,
              count(*) FILTER (WHERE validation_status = 'valid')::integer AS valid_count,
              count(*) FILTER (WHERE validation_status = 'duplicate')::integer AS duplicate_count,
              count(*) FILTER (WHERE validation_status = 'invalid')::integer AS invalid_count,
              count(*) FILTER (WHERE validation_status = 'uncategorized')::integer AS uncategorized_count,
              count(*) FILTER (WHERE validation_status = 'imported')::integer AS imported_count
       FROM import_items
       WHERE import_session_id = $1 AND wallet_id = $2
     ) AS counters
     WHERE session.id = $1 AND session.wallet_id = $2`,
    [importId, walletId, status ?? null],
  );
}

export async function lockWalletImports(executor: QueryExecutor, walletId: string): Promise<void> {
  await executor.query("SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))", [walletId]);
}
