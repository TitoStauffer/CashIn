import { randomUUID } from "node:crypto";
import type { Database, QueryExecutor } from "../database.js";
import { FinancialImportError } from "./financial-imports.errors.js";
import {
  createFinancialImportFingerprint,
  createLegacyFinancialImportFingerprint,
  createLegacyOfxFinancialImportFingerprint,
  normalizeSignedAmount,
} from "./financial-imports.fingerprint.js";
import type {
  CreateCsvMappingInput,
  CsvImportConfiguration,
  CsvMapping,
  CreateFinancialImportInput,
  FinancialImportFormat,
  FinancialImportItem,
  FinancialImportItemStatus,
  FinancialImportItemType,
  FinancialImportRepository,
  FinancialImportSession,
  FinancialImportStatus,
  ParsedFinancialImportItem,
  UpdateFinancialImportItemInput,
} from "./financial-imports.types.js";

interface CsvMappingRow {
  id: string;
  name: string;
  configuration: CsvImportConfiguration;
  created_at: string | Date;
  updated_at: string | Date;
}

interface ImportSessionRow {
  id: string;
  format: FinancialImportFormat;
  original_filename: string;
  file_size_bytes: string | number;
  file_hash: string;
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

interface ImportItemRow {
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
  created_at: string | Date;
  updated_at: string | Date;
}

interface CategoryReferenceRow {
  id: string;
  nature: "income" | "expense";
}

interface SubcategoryReferenceRow {
  id: string;
  category_id: string;
}

const IMPORT_BATCH_SIZE = 500;

function chunks<Item>(items: Item[], size = IMPORT_BATCH_SIZE): Item[][] {
  const result: Item[][] = [];
  for (let index = 0; index < items.length; index += size) result.push(items.slice(index, index + size));
  return result;
}

function invalidateReference(
  item: ParsedFinancialImportItem,
  message: string,
  categoryId: string | null,
): ParsedFinancialImportItem {
  const currentMessage = item.errorMessage?.trim();
  const isDuplicate = item.validationStatus === "duplicate";
  return {
    ...item,
    categoryId,
    subcategoryId: null,
    validationStatus: isDuplicate ? "duplicate" : "invalid",
    errorMessage: currentMessage ? `${currentMessage} ${message}` : message,
    isRepairable: isDuplicate ? false : item.validationStatus === "invalid" ? item.isRepairable === true : true,
  };
}

function dateValue(value: string | Date | null): string {
  if (value === null) return "";
  return value instanceof Date ? value.toISOString().slice(0, 10) : value.slice(0, 10);
}

function timestampValue(value: string | Date | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function mapCsvMapping(row: CsvMappingRow): CsvMapping {
  return {
    id: row.id,
    name: row.name,
    configuration: row.configuration,
    createdAt: timestampValue(row.created_at)!,
    updatedAt: timestampValue(row.updated_at)!,
  };
}

function mapSession(row: ImportSessionRow): FinancialImportSession {
  return {
    id: row.id,
    format: row.format,
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

function mapItem(row: ImportItemRow): FinancialImportItem {
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
    createdAt: timestampValue(row.created_at)!,
    updatedAt: timestampValue(row.updated_at)!,
  };
}

const sessionColumns = `
  session.id,
  session.format,
  session.original_filename,
  session.file_size_bytes,
  session.file_hash,
  session.status,
  session.item_count,
  session.valid_count,
  session.duplicate_count,
  session.invalid_count,
  session.uncategorized_count,
  session.imported_count,
  session.failure_message,
  session.confirmed_at,
  session.completed_at,
  session.failed_at,
  session.undone_at,
  session.created_at,
  session.updated_at,
  (
    session.status = 'completed'
    AND session.imported_count > 0
    AND NOT EXISTS (
      SELECT 1
      FROM import_items AS checked_item
      LEFT JOIN incomes AS checked_income
        ON checked_income.id = checked_item.resulting_income_id
       AND checked_income.wallet_id = checked_item.wallet_id
      LEFT JOIN expenses AS checked_expense
        ON checked_expense.id = checked_item.resulting_expense_id
       AND checked_expense.wallet_id = checked_item.wallet_id
      WHERE checked_item.import_session_id = session.id
        AND checked_item.validation_status = 'imported'
        AND (
          (checked_item.type = 'income' AND (
            checked_income.id IS NULL OR checked_income.updated_at IS DISTINCT FROM checked_item.resulting_updated_at
          ))
          OR
          (checked_item.type = 'expense' AND (
            checked_expense.id IS NULL OR checked_expense.updated_at IS DISTINCT FROM checked_item.resulting_updated_at
          ))
        )
    )
  ) AS can_undo,
  CASE
    WHEN session.status <> 'completed' THEN 'Somente importações concluídas podem ser desfeitas.'
    WHEN session.imported_count = 0 THEN 'A importação não possui lançamentos para desfazer.'
    WHEN EXISTS (
      SELECT 1
      FROM import_items AS blocked_item
      LEFT JOIN incomes AS blocked_income
        ON blocked_income.id = blocked_item.resulting_income_id
       AND blocked_income.wallet_id = blocked_item.wallet_id
      LEFT JOIN expenses AS blocked_expense
        ON blocked_expense.id = blocked_item.resulting_expense_id
       AND blocked_expense.wallet_id = blocked_item.wallet_id
      WHERE blocked_item.import_session_id = session.id
        AND blocked_item.validation_status = 'imported'
        AND (
          (blocked_item.type = 'income' AND (
            blocked_income.id IS NULL OR blocked_income.updated_at IS DISTINCT FROM blocked_item.resulting_updated_at
          ))
          OR
          (blocked_item.type = 'expense' AND (
            blocked_expense.id IS NULL OR blocked_expense.updated_at IS DISTINCT FROM blocked_item.resulting_updated_at
          ))
        )
    ) THEN 'Um ou mais lançamentos importados foram alterados ou removidos.'
    ELSE NULL
  END AS undo_blocked_reason`;

const itemColumns = `
  item.id,
  item.sequence,
  item.transaction_date,
  item.description,
  abs(item.signed_amount)::text AS amount,
  item.type,
  item.category_id,
  item.subcategory_id,
  item.validation_status,
  item.error_message,
  item.is_repairable,
  item.duplicate_override_allowed,
  item.created_at,
  item.updated_at`;

export class PostgresFinancialImportsRepository implements FinancialImportRepository {
  constructor(private readonly database: Database) {}

  async createImport(
    userId: string,
    walletId: string,
    input: CreateFinancialImportInput,
  ): Promise<FinancialImportSession> {
    const result = await this.database.query<ImportSessionRow>(
      `INSERT INTO import_sessions (
         wallet_id, created_by_user_id, format, original_filename, file_size_bytes, file_hash
       ) VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING ${sessionColumns.replaceAll("session.", "import_sessions.")}`,
      [walletId, userId, input.format, input.fileName, input.fileSize, input.fileHash],
    );
    return mapSession(result.rows[0]!);
  }

  async savePreview(
    _userId: string,
    walletId: string,
    importId: string,
    items: ParsedFinancialImportItem[],
    sourceMetadata: Record<string, string> = {},
  ): Promise<FinancialImportSession | null> {
    return this.database.transaction(async (transaction) => {
      const locked = await transaction.query<{ id: string }>(
        `SELECT id FROM import_sessions
         WHERE id = $1 AND wallet_id = $2 AND status = 'processing'
         FOR UPDATE`,
        [importId, walletId],
      );
      if (!locked.rows[0]) return null;
      await this.lockWalletImports(transaction, walletId);

      const categoryIds = [...new Set(items.flatMap((item) => item.categoryId ? [item.categoryId] : []))];
      const subcategoryIds = [...new Set(items.flatMap((item) => item.subcategoryId ? [item.subcategoryId] : []))];
      const categories = categoryIds.length === 0
        ? { rows: [] as CategoryReferenceRow[] }
        : await transaction.query<CategoryReferenceRow>(
          `SELECT id, nature FROM categories
           WHERE wallet_id = $1 AND id = ANY($2::uuid[])
           FOR KEY SHARE`,
          [walletId, categoryIds],
        );
      const subcategories = subcategoryIds.length === 0
        ? { rows: [] as SubcategoryReferenceRow[] }
        : await transaction.query<SubcategoryReferenceRow>(
          `SELECT id, category_id FROM subcategories
           WHERE wallet_id = $1 AND id = ANY($2::uuid[])
           FOR KEY SHARE`,
          [walletId, subcategoryIds],
        );
      const categoriesById = new Map(categories.rows.map((category) => [category.id, category]));
      const subcategoriesById = new Map(subcategories.rows.map((subcategory) => [subcategory.id, subcategory]));
      const validatedItems = items.map((item) => {
        if (item.type === "transfer") return { ...item, categoryId: null, subcategoryId: null };
        if (!item.categoryId) {
          return item.subcategoryId
            ? invalidateReference(item, "A subcategoria informada não pertence a uma categoria válida desta carteira.", null)
            : item;
        }
        const category = categoriesById.get(item.categoryId);
        if (!category || category.nature !== item.type) {
          return invalidateReference(
            item,
            "A categoria informada não existe nesta carteira ou não corresponde ao tipo da movimentação.",
            null,
          );
        }
        if (!item.subcategoryId) return item;
        const subcategory = subcategoriesById.get(item.subcategoryId);
        if (!subcategory || subcategory.category_id !== category.id) {
          return invalidateReference(
            item,
            "A subcategoria informada não pertence à categoria selecionada nesta carteira.",
            category.id,
          );
        }
        return item;
      });

      const itemsWithFileDuplicates = this.markInFileDuplicates(validatedItems);
      const itemsWithHistoryDuplicates = await this.markPreviouslyImportedDuplicates(
        transaction,
        walletId,
        itemsWithFileDuplicates,
        sourceMetadata,
      );
      for (const batch of chunks(itemsWithHistoryDuplicates)) {
        const payload = batch.map((item) => ({
          sequence: item.sequence,
          transaction_date: item.date,
          description: item.description ?? null,
          signed_amount: item.signedAmount,
          type: item.type,
          category_id: item.categoryId ?? null,
          subcategory_id: item.subcategoryId ?? null,
          category_nature: item.type === "transfer" ? null : item.type,
          validation_status: item.validationStatus ?? "valid",
          error_message: item.errorMessage ?? null,
          is_repairable: item.isRepairable ?? false,
          external_id: item.externalId ?? null,
          record_hash: item.recordHash ?? null,
          duplicate_override_allowed: item.duplicateOverrideAllowed === true,
        }));
        await transaction.query(
          `INSERT INTO import_items (
             import_session_id, wallet_id, sequence, transaction_date, description,
             signed_amount, type, category_id, subcategory_id, category_nature,
             validation_status, error_message, is_repairable, external_id, record_hash,
             duplicate_override_allowed
           )
           SELECT $1, $2, item.sequence, item.transaction_date::date, item.description,
                  item.signed_amount::numeric, item.type, item.category_id::uuid,
                  item.subcategory_id::uuid, item.category_nature,
                  item.validation_status, item.error_message, item.is_repairable,
                  item.external_id, item.record_hash, item.duplicate_override_allowed
           FROM jsonb_to_recordset($3::jsonb) AS item(
             sequence integer,
             transaction_date text,
             description text,
             signed_amount text,
             type text,
             category_id text,
             subcategory_id text,
             category_nature text,
             validation_status text,
             error_message text,
             is_repairable boolean,
             external_id text,
             record_hash text,
             duplicate_override_allowed boolean
           )`,
          [importId, walletId, JSON.stringify(payload)],
        );
      }
      await transaction.query(
        `UPDATE import_sessions
         SET source_metadata = $3::jsonb, updated_at = now()
         WHERE id = $1 AND wallet_id = $2 AND status = 'processing'`,
        [importId, walletId, JSON.stringify(sourceMetadata)],
      );
      await this.refreshCounters(transaction, walletId, importId, "preview");
      return this.getSessionWithItems(transaction, walletId, importId);
    });
  }

  async listImports(_userId: string, walletId: string): Promise<FinancialImportSession[]> {
    const result = await this.database.query<ImportSessionRow>(
      `SELECT ${sessionColumns}
       FROM import_sessions AS session
       WHERE session.wallet_id = $1
       ORDER BY session.created_at DESC, session.id DESC`,
      [walletId],
    );
    return result.rows.map(mapSession);
  }

  async getImport(_userId: string, walletId: string, importId: string): Promise<FinancialImportSession | null> {
    return this.getSessionWithItems(this.database, walletId, importId);
  }

  async markFailed(
    _userId: string,
    walletId: string,
    importId: string,
    failureMessage: string,
  ): Promise<void> {
    await this.database.query(
      `UPDATE import_sessions
       SET status = 'failed', failure_message = $3, failed_at = now(), updated_at = now()
       WHERE id = $1 AND wallet_id = $2 AND status = 'processing'`,
      [importId, walletId, failureMessage],
    );
  }

  async updateItem(
    _userId: string,
    walletId: string,
    importId: string,
    itemId: string,
    input: Required<UpdateFinancialImportItemInput>,
  ): Promise<FinancialImportItem | null> {
    return this.database.transaction(async (transaction) => {
      const session = await transaction.query<{ id: string }>(
        `SELECT id FROM import_sessions
         WHERE id = $1 AND wallet_id = $2 AND status = 'preview'
         FOR UPDATE`,
        [importId, walletId],
      );
      if (!session.rows[0]) return null;

      const currentItem = await transaction.query<{
        signed_amount: string | null;
        validation_status: FinancialImportItemStatus;
        duplicate_override_allowed: boolean;
        is_repairable: boolean;
        accepted_duplicate_fingerprint: string | null;
      }>(
        `SELECT signed_amount::text, validation_status, duplicate_override_allowed, is_repairable,
                accepted_duplicate_fingerprint
         FROM import_items
         WHERE id = $1 AND import_session_id = $2 AND wallet_id = $3
         FOR UPDATE`,
        [itemId, importId, walletId],
      );
      if (!currentItem.rows[0]) return null;
      const canEditItem = currentItem.rows[0].validation_status === "valid"
        || currentItem.rows[0].validation_status === "uncategorized"
        || (currentItem.rows[0].validation_status === "invalid" && currentItem.rows[0].is_repairable)
        || (currentItem.rows[0].validation_status === "duplicate"
          && currentItem.rows[0].duplicate_override_allowed
          && input.includeDuplicate);
      if (!canEditItem || currentItem.rows[0].signed_amount === null) return null;

      const categoryId = input.type === "transfer" ? null : input.categoryId;
      const subcategoryId = input.type === "transfer" ? null : input.subcategoryId;
      const nextFingerprint = createFinancialImportFingerprint({
        date: input.date,
        signedAmount: normalizeSignedAmount(currentItem.rows[0].signed_amount),
        type: input.type,
        description: input.description,
      });
      if (!nextFingerprint) throw new FinancialImportError("Não foi possível validar a identidade da movimentação.", 409);
      const acceptedDuplicateFingerprint = input.includeDuplicate
        && currentItem.rows[0].validation_status === "duplicate"
        && currentItem.rows[0].duplicate_override_allowed
        ? nextFingerprint
        : currentItem.rows[0].accepted_duplicate_fingerprint === nextFingerprint
          ? nextFingerprint
          : null;
      const validationStatus = input.type === "transfer" || categoryId === null ? "uncategorized" : "valid";
      const errorMessage = input.type === "transfer"
        ? "A transferência precisa ser conciliada antes da importação."
        : categoryId === null
          ? "Selecione uma categoria para importar a movimentação."
          : null;
      const result = await transaction.query<ImportItemRow>(
        `UPDATE import_items AS item
         SET transaction_date = $4::date,
             description = $5,
             type = $6,
             category_id = $7::uuid,
             subcategory_id = $8::uuid,
             category_nature = CASE WHEN $6 = 'transfer' THEN NULL ELSE $6 END,
             validation_status = $9,
             error_message = $10,
             is_repairable = false,
             duplicate_override_allowed = false,
             record_hash = $12,
             accepted_duplicate_fingerprint = $13,
             updated_at = now()
         WHERE item.id = $1
           AND item.import_session_id = $2
           AND item.wallet_id = $3
           AND (
             item.validation_status IN ('valid', 'uncategorized')
             OR (item.validation_status = 'invalid' AND item.is_repairable)
             OR (item.validation_status = 'duplicate' AND item.duplicate_override_allowed AND $11::boolean)
           )
           AND ($7::uuid IS NULL OR EXISTS (
             SELECT 1 FROM categories AS category
             WHERE category.id = $7::uuid AND category.wallet_id = $3 AND category.nature = $6
           ))
           AND ($8::uuid IS NULL OR EXISTS (
             SELECT 1 FROM subcategories AS subcategory
             WHERE subcategory.id = $8::uuid AND subcategory.wallet_id = $3 AND subcategory.category_id = $7::uuid
           ))
         RETURNING ${itemColumns.replaceAll("item.", "item.")}`,
        [
          itemId,
          importId,
          walletId,
          input.date,
          input.description,
          input.type,
          categoryId,
          subcategoryId,
          validationStatus,
          errorMessage,
          input.includeDuplicate,
          nextFingerprint,
          acceptedDuplicateFingerprint,
        ],
      );
      const row = result.rows[0];
      if (!row) return null;
      await this.refreshCounters(transaction, walletId, importId);
      return mapItem(row);
    });
  }

  async confirmImport(
    userId: string,
    walletId: string,
    importId: string,
  ): Promise<FinancialImportSession | null> {
    return this.database.transaction(async (transaction) => {
      await this.lockWalletImports(transaction, walletId);
      const session = await transaction.query<{ id: string }>(
        `UPDATE import_sessions
         SET status = 'confirming', confirmed_at = now(), failure_message = NULL, updated_at = now()
         WHERE id = $1 AND wallet_id = $2 AND status = 'preview'
         RETURNING id`,
        [importId, walletId],
      );
      if (!session.rows[0]) return null;
      const pendingItems = await transaction.query<{ id: string }>(
        `SELECT id FROM import_items
         WHERE import_session_id = $1 AND wallet_id = $2 AND validation_status = 'valid'`,
        [importId, walletId],
      );
      if (pendingItems.rows.length === 0) {
        throw new FinancialImportError("A importação não possui movimentações válidas para confirmar.", 409);
      }
      const newlyDetectedDuplicates = await this.markCurrentSessionDuplicates(transaction, walletId, importId);
      if (newlyDetectedDuplicates > 0) {
        await this.refreshCounters(transaction, walletId, importId);
        await transaction.query(
          `UPDATE import_sessions
           SET status = 'preview', confirmed_at = NULL, updated_at = now()
           WHERE id = $1 AND wallet_id = $2`,
          [importId, walletId],
        );
        return this.getSessionWithItems(transaction, walletId, importId);
      }
      const items = await transaction.query<{
        id: string;
        type: FinancialImportItemType;
        category_id: string | null;
        subcategory_id: string | null;
        amount: string;
        transaction_date: string | Date;
        description: string | null;
      }>(
        `SELECT id, type, category_id, subcategory_id, abs(signed_amount)::text AS amount,
                transaction_date, description
         FROM import_items
         WHERE import_session_id = $1 AND wallet_id = $2 AND validation_status = 'valid'
         ORDER BY sequence
         FOR UPDATE`,
        [importId, walletId],
      );
      if (items.rows.length === 0) {
        await this.refreshCounters(transaction, walletId, importId);
        await transaction.query(
          `UPDATE import_sessions
           SET status = 'preview', confirmed_at = NULL, updated_at = now()
           WHERE id = $1 AND wallet_id = $2`,
          [importId, walletId],
        );
        return this.getSessionWithItems(transaction, walletId, importId);
      }

      if (items.rows.some((item) => item.type === "transfer")) {
        throw new FinancialImportError("Concilie as transferências antes de confirmar a importação.", 409);
      }

      for (const type of ["income", "expense"] as const) {
        const target = type === "income" ? "incomes" : "expenses";
        const resultColumn = type === "income" ? "resulting_income_id" : "resulting_expense_id";
        for (const batch of chunks(items.rows.filter((item) => item.type === type))) {
          if (batch.length === 0) continue;
          const payload = batch.map((item) => ({
            import_item_id: item.id,
            movement_id: randomUUID(),
            category_id: item.category_id,
            subcategory_id: item.subcategory_id,
            amount: item.amount,
            transaction_date: dateValue(item.transaction_date),
            description: item.description,
          }));
          const imported = await transaction.query<{ id: string }>(
            `WITH input AS (
               SELECT * FROM jsonb_to_recordset($3::jsonb) AS data(
                 import_item_id uuid,
                 movement_id uuid,
                 category_id uuid,
                 subcategory_id uuid,
                 amount numeric,
                 transaction_date date,
                 description text
               )
             ), inserted AS (
               INSERT INTO ${target} (
                 id, user_id, wallet_id, category_id, subcategory_id, amount, date, description
               )
               SELECT input.movement_id, $1, $2, category.id, input.subcategory_id,
                      input.amount, input.transaction_date, input.description
               FROM input
               JOIN categories AS category
                 ON category.id = input.category_id
                AND category.wallet_id = $2
                AND category.nature = '${type}'
               LEFT JOIN subcategories AS subcategory
                 ON subcategory.id = input.subcategory_id
                AND subcategory.wallet_id = $2
                AND subcategory.category_id = category.id
               WHERE input.subcategory_id IS NULL OR subcategory.id IS NOT NULL
               RETURNING id, updated_at
             )
             UPDATE import_items AS item
             SET validation_status = 'imported',
                 ${resultColumn} = inserted.id,
                 resulting_updated_at = inserted.updated_at,
                 error_message = NULL,
                 is_repairable = false,
                 updated_at = now()
             FROM input
             JOIN inserted ON inserted.id = input.movement_id
             WHERE item.id = input.import_item_id
               AND item.import_session_id = $4
               AND item.wallet_id = $2
               AND item.validation_status = 'valid'
             RETURNING item.id`,
            [userId, walletId, JSON.stringify(payload), importId],
          );
          if (imported.rows.length !== batch.length) {
            throw new FinancialImportError("Uma categoria ou subcategoria da importação não está mais disponível.", 409);
          }
        }
      }

      await this.refreshCounters(transaction, walletId, importId);
      await transaction.query(
        `UPDATE import_sessions
         SET status = 'completed',
             completed_at = now(),
             updated_at = now()
         WHERE id = $1 AND wallet_id = $2`,
        [importId, walletId],
      );
      return this.getSessionWithItems(transaction, walletId, importId);
    });
  }

  async undoImport(
    _userId: string,
    walletId: string,
    importId: string,
  ): Promise<FinancialImportSession | null> {
    return this.database.transaction(async (transaction) => {
      const session = await transaction.query<{ id: string }>(
        `SELECT id FROM import_sessions
         WHERE id = $1 AND wallet_id = $2 AND status = 'completed'
         FOR UPDATE`,
        [importId, walletId],
      );
      if (!session.rows[0]) return null;
      const targets = await transaction.query<{
        id: string;
        type: "income" | "expense";
        resulting_income_id: string | null;
        resulting_expense_id: string | null;
        resulting_updated_at: string | Date | null;
      }>(
        `SELECT item.id, item.type, item.resulting_income_id, item.resulting_expense_id,
                item.resulting_updated_at
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
             resulting_income_id = NULL,
             resulting_expense_id = NULL,
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
             updated_at = now()
         WHERE import_session_id = $1
           AND wallet_id = $2
           AND (category_id IS NOT NULL OR subcategory_id IS NOT NULL)`,
        [importId, walletId],
      );
      if (incomeIds.length > 0) {
        await transaction.query("DELETE FROM incomes WHERE wallet_id = $1 AND id = ANY($2::uuid[])", [walletId, incomeIds]);
      }
      if (expenseIds.length > 0) {
        await transaction.query("DELETE FROM expenses WHERE wallet_id = $1 AND id = ANY($2::uuid[])", [walletId, expenseIds]);
      }
      await transaction.query(
        `UPDATE import_sessions
         SET status = 'undone',
             undone_at = now(),
             updated_at = now()
         WHERE id = $1 AND wallet_id = $2`,
        [importId, walletId],
      );
      await this.refreshCounters(transaction, walletId, importId);
      return this.getSessionWithItems(transaction, walletId, importId);
    });
  }

  async discardImport(
    _userId: string,
    walletId: string,
    importId: string,
  ): Promise<FinancialImportSession | null> {
    return this.database.transaction(async (transaction) => {
      const session = await transaction.query<{ id: string }>(
        `SELECT id FROM import_sessions
         WHERE id = $1 AND wallet_id = $2 AND status = 'preview'
         FOR UPDATE`,
        [importId, walletId],
      );
      if (!session.rows[0]) return null;
      await transaction.query(
        `UPDATE import_items
         SET category_id = NULL,
             subcategory_id = NULL,
             validation_status = CASE
               WHEN validation_status = 'valid' THEN 'uncategorized'
               ELSE validation_status
             END,
             error_message = CASE
               WHEN validation_status = 'valid' THEN 'A prévia foi descartada antes da confirmação.'
               ELSE error_message
             END,
             updated_at = now()
         WHERE import_session_id = $1 AND wallet_id = $2`,
        [importId, walletId],
      );
      await this.refreshCounters(transaction, walletId, importId);
      await transaction.query(
        `UPDATE import_sessions
         SET status = 'failed',
             failure_message = 'Importação descartada pelo usuário.',
             failed_at = now(),
             updated_at = now()
         WHERE id = $1 AND wallet_id = $2`,
        [importId, walletId],
      );
      return this.getSessionWithItems(transaction, walletId, importId);
    });
  }

  async listCsvMappings(userId: string, walletId: string): Promise<CsvMapping[]> {
    const result = await this.database.query<CsvMappingRow>(
      `SELECT mapping.id, mapping.name, mapping.configuration, mapping.created_at, mapping.updated_at
       FROM financial_import_csv_mappings AS mapping
       JOIN wallet_members AS member ON member.wallet_id = mapping.wallet_id
       WHERE mapping.wallet_id = $1 AND member.user_id = $2
       ORDER BY lower(mapping.name), mapping.id`,
      [walletId, userId],
    );
    return result.rows.map(mapCsvMapping);
  }

  async getCsvMapping(userId: string, walletId: string, mappingId: string): Promise<CsvMapping | null> {
    const result = await this.database.query<CsvMappingRow>(
      `SELECT mapping.id, mapping.name, mapping.configuration, mapping.created_at, mapping.updated_at
       FROM financial_import_csv_mappings AS mapping
       JOIN wallet_members AS member ON member.wallet_id = mapping.wallet_id
       WHERE mapping.id = $1 AND mapping.wallet_id = $2 AND member.user_id = $3`,
      [mappingId, walletId, userId],
    );
    return result.rows[0] ? mapCsvMapping(result.rows[0]) : null;
  }

  async createCsvMapping(userId: string, walletId: string, input: CreateCsvMappingInput): Promise<CsvMapping> {
    try {
      const result = await this.database.query<CsvMappingRow>(
        `INSERT INTO financial_import_csv_mappings (id, wallet_id, created_by_user_id, name, configuration)
         SELECT $1, wallet.id, $2, $3, $4::jsonb
         FROM wallets AS wallet
         JOIN wallet_members AS member ON member.wallet_id = wallet.id
         WHERE wallet.id = $5 AND member.user_id = $2
         RETURNING id, name, configuration, created_at, updated_at`,
        [randomUUID(), userId, input.name, JSON.stringify(input.configuration), walletId],
      );
      if (!result.rows[0]) throw new FinancialImportError("A carteira selecionada não foi encontrada.", 404);
      return mapCsvMapping(result.rows[0]);
    } catch (error) {
      if (isUniqueViolation(error)) throw new FinancialImportError("Já existe um modelo CSV com esse nome nesta carteira.", 409);
      throw error;
    }
  }

  async updateCsvMapping(userId: string, walletId: string, mappingId: string, input: CreateCsvMappingInput): Promise<CsvMapping | null> {
    try {
      const result = await this.database.query<CsvMappingRow>(
        `UPDATE financial_import_csv_mappings AS mapping
         SET name = $1, configuration = $2::jsonb, updated_at = now()
         WHERE mapping.id = $3 AND mapping.wallet_id = $4
           AND EXISTS (SELECT 1 FROM wallet_members AS member WHERE member.wallet_id = mapping.wallet_id AND member.user_id = $5)
         RETURNING id, name, configuration, created_at, updated_at`,
        [input.name, JSON.stringify(input.configuration), mappingId, walletId, userId],
      );
      return result.rows[0] ? mapCsvMapping(result.rows[0]) : null;
    } catch (error) {
      if (isUniqueViolation(error)) throw new FinancialImportError("Já existe um modelo CSV com esse nome nesta carteira.", 409);
      throw error;
    }
  }

  private async getSession(
    executor: QueryExecutor,
    walletId: string,
    importId: string,
  ): Promise<FinancialImportSession | null> {
    const result = await executor.query<ImportSessionRow>(
      `SELECT ${sessionColumns}
       FROM import_sessions AS session
       WHERE session.id = $1 AND session.wallet_id = $2`,
      [importId, walletId],
    );
    const row = result.rows[0];
    return row ? mapSession(row) : null;
  }

  private async getSessionWithItems(
    executor: QueryExecutor,
    walletId: string,
    importId: string,
  ): Promise<FinancialImportSession | null> {
    const session = await this.getSession(executor, walletId, importId);
    if (!session) return null;
    const items = await executor.query<ImportItemRow>(
      `SELECT ${itemColumns}
       FROM import_items AS item
       WHERE item.import_session_id = $1 AND item.wallet_id = $2
       ORDER BY item.sequence, item.id`,
      [importId, walletId],
    );
    return {
      ...session,
      items: items.rows.map((row) => {
        const item = mapItem(row);
        return session.status === "preview" ? item : { ...item, canEdit: false };
      }),
    };
  }

  private async refreshCounters(
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

  private async lockWalletImports(executor: QueryExecutor, walletId: string): Promise<void> {
    await executor.query("SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))", [walletId]);
  }

  private markInFileDuplicates(items: ParsedFinancialImportItem[]): ParsedFinancialImportItem[] {
    const seen = new Set<string>();
    return items.map((item) => {
      if (!item.recordHash || item.validationStatus === "duplicate" || item.validationStatus === "invalid") return item;
      if (item.acceptedDuplicateFingerprint === item.recordHash) {
        seen.add(item.recordHash);
        return item;
      }
      if (!seen.has(item.recordHash)) {
        seen.add(item.recordHash);
        return item;
      }
      return {
        ...item,
        validationStatus: "duplicate",
        errorMessage: "Possível duplicidade no mesmo arquivo (data, valor, tipo e descrição coincidem). Revise antes de importar.",
        duplicateOverrideAllowed: true,
      };
    });
  }

  private async markPreviouslyImportedDuplicates(
    executor: QueryExecutor,
    walletId: string,
    items: ParsedFinancialImportItem[],
    sourceMetadata: Record<string, string>,
  ): Promise<ParsedFinancialImportItem[]> {
    const candidates = items.filter((item) => (
      item.recordHash && item.date && item.signedAmount
      && item.validationStatus !== "invalid" && item.validationStatus !== "duplicate"
    ));
    if (candidates.length === 0) return items;

    const accountReferenceHash = sourceMetadata.accountReferenceHash ?? null;
    const existingFingerprints = new Set<string>();
    const externalIds = new Set<string>();
    for (const batch of chunks(candidates)) {
      const hashes = new Set<string>();
      const candidatesPayload = batch.map((item) => {
        const date = item.date!;
        const signedAmount = item.signedAmount!;
        const description = item.description ?? null;
        const hash = createFinancialImportFingerprint({ date, signedAmount, type: item.type, description });
        if (hash) hashes.add(hash);
        hashes.add(createLegacyFinancialImportFingerprint({ date, signedAmount, description }));
        if (accountReferenceHash) {
          hashes.add(createLegacyOfxFinancialImportFingerprint({ accountReferenceHash, date, signedAmount, description }));
        }
        return { transaction_date: date, signed_amount: signedAmount, type: item.type };
      });
      const externalIdBatch = [...new Set(batch.flatMap((item) => item.externalId ? [item.externalId] : []))];
      const existing = await executor.query<{
        external_id: string | null;
        record_hash: string | null;
        transaction_date: string | Date;
        signed_amount: string;
        type: FinancialImportItemType;
        description: string | null;
        account_reference_hash: string | null;
      }>(
        `WITH candidates AS (
           SELECT * FROM jsonb_to_recordset($2::jsonb) AS candidate(
             transaction_date date, signed_amount numeric, type text
           )
         )
         SELECT DISTINCT item.external_id, item.record_hash,
                item.transaction_date, item.signed_amount::text, item.type, item.description,
                session.source_metadata->>'accountReferenceHash' AS account_reference_hash
         FROM import_items AS item
         JOIN import_sessions AS session ON session.id = item.import_session_id AND session.wallet_id = item.wallet_id
         WHERE item.wallet_id = $1
           AND item.validation_status = 'imported'
           AND (
             item.record_hash = ANY($3::text[])
             OR EXISTS (
               SELECT 1 FROM candidates
               WHERE candidates.transaction_date = item.transaction_date
                 AND candidates.signed_amount = item.signed_amount
                 AND candidates.type = item.type
             )
             OR ($4::text IS NOT NULL AND session.format = 'ofx'
                 AND session.source_metadata->>'accountReferenceHash' = $4
                 AND item.external_id = ANY($5::text[]))
           )`,
        [walletId, JSON.stringify(candidatesPayload), [...hashes], accountReferenceHash, externalIdBatch],
      );
      for (const row of existing.rows) {
        const fingerprint = createFinancialImportFingerprint({
          date: dateValue(row.transaction_date),
          signedAmount: normalizeSignedAmount(row.signed_amount),
          type: row.type,
          description: row.description,
        });
        if (fingerprint) existingFingerprints.add(fingerprint);
        if (accountReferenceHash && row.account_reference_hash === accountReferenceHash && row.external_id) {
          externalIds.add(row.external_id);
        }
      }
    }

    return items.map((item) => {
      if (item.validationStatus === "invalid" || item.validationStatus === "duplicate") return item;
      const matchesExternalId = Boolean(item.externalId && externalIds.has(item.externalId));
      const matchesFingerprint = Boolean(item.recordHash && existingFingerprints.has(item.recordHash));
      const fingerprintWasReviewed = item.acceptedDuplicateFingerprint === item.recordHash;
      if (!matchesExternalId && (!matchesFingerprint || fingerprintWasReviewed)) return item;
      return {
        ...item,
        validationStatus: "duplicate",
        duplicateOverrideAllowed: !matchesExternalId,
        errorMessage: matchesExternalId
          ? "Esta movimentação já foi importada: o FITID coincide na mesma conta bancária."
          : "Possível duplicidade: já existe uma importação nesta carteira com mesma data, valor, tipo e descrição. Revise antes de importar.",
      };
    });
  }

  private async markCurrentSessionDuplicates(
    executor: QueryExecutor,
    walletId: string,
    importId: string,
  ): Promise<number> {
    const session = await executor.query<{ source_metadata: Record<string, string> }>(
      "SELECT source_metadata FROM import_sessions WHERE id = $1 AND wallet_id = $2",
      [importId, walletId],
    );
    const pending = await executor.query<{
      id: string;
      type: FinancialImportItemType;
      transaction_date: string | Date;
      signed_amount: string;
      description: string | null;
      external_id: string | null;
      record_hash: string | null;
      accepted_duplicate_fingerprint: string | null;
      sequence: number;
    }>(
      `SELECT id, sequence, type, transaction_date, signed_amount::text, description, external_id,
              record_hash, accepted_duplicate_fingerprint
       FROM import_items
       WHERE import_session_id = $1 AND wallet_id = $2 AND validation_status = 'valid'
       ORDER BY sequence`,
      [importId, walletId],
    );
    const candidates: ParsedFinancialImportItem[] = pending.rows.map((item) => {
      const fingerprint = createFinancialImportFingerprint({
        date: dateValue(item.transaction_date),
        signedAmount: normalizeSignedAmount(item.signed_amount),
        type: item.type,
        description: item.description,
      });
      return {
        sequence: item.sequence,
        date: dateValue(item.transaction_date),
        description: item.description,
        signedAmount: normalizeSignedAmount(item.signed_amount),
        type: item.type,
        externalId: item.external_id,
        recordHash: fingerprint,
        acceptedDuplicateFingerprint: item.accepted_duplicate_fingerprint,
      };
    });
    const inFileChecked = this.markInFileDuplicates(candidates);
    const marked = await this.markPreviouslyImportedDuplicates(
      executor,
      walletId,
      inFileChecked,
      session.rows[0]?.source_metadata ?? {},
    );
    let duplicateCount = 0;
    for (let index = 0; index < marked.length; index += 1) {
      const item = marked[index]!;
      if (item.validationStatus !== "duplicate") continue;
      duplicateCount += 1;
      await executor.query(
        `UPDATE import_items SET validation_status = 'duplicate', error_message = $3,
             duplicate_override_allowed = $4, accepted_duplicate_fingerprint = NULL, updated_at = now()
         WHERE id = $1 AND import_session_id = $2 AND wallet_id = $5 AND validation_status = 'valid'`,
        [pending.rows[index]!.id, importId, item.errorMessage, item.duplicateOverrideAllowed === true, walletId],
      );
    }
    return duplicateCount;
  }
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "23505";
}
