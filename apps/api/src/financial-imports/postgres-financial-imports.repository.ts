import { randomUUID } from "node:crypto";
import type { Database, QueryExecutor } from "../database.js";
import { FinancialImportError } from "./financial-imports.errors.js";
import type {
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

      for (const batch of chunks(validatedItems)) {
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
        }));
        await transaction.query(
          `INSERT INTO import_items (
             import_session_id, wallet_id, sequence, transaction_date, description,
             signed_amount, type, category_id, subcategory_id, category_nature,
             validation_status, error_message, is_repairable, external_id, record_hash
           )
           SELECT $1, $2, item.sequence, item.transaction_date::date, item.description,
                  item.signed_amount::numeric, item.type, item.category_id::uuid,
                  item.subcategory_id::uuid, item.category_nature,
                  item.validation_status, item.error_message, item.is_repairable,
                  item.external_id, item.record_hash
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
             record_hash text
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

      const categoryId = input.type === "transfer" ? null : input.categoryId;
      const subcategoryId = input.type === "transfer" ? null : input.subcategoryId;
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
             updated_at = now()
         WHERE item.id = $1
           AND item.import_session_id = $2
           AND item.wallet_id = $3
           AND (
             item.validation_status IN ('valid', 'uncategorized')
             OR (item.validation_status = 'invalid' AND item.is_repairable)
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
      const session = await transaction.query<{ id: string }>(
        `UPDATE import_sessions
         SET status = 'confirming', confirmed_at = now(), failure_message = NULL, updated_at = now()
         WHERE id = $1 AND wallet_id = $2 AND status = 'preview'
         RETURNING id`,
        [importId, walletId],
      );
      if (!session.rows[0]) return null;
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
        throw new FinancialImportError("A importação não possui movimentações válidas para confirmar.", 409);
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
}
