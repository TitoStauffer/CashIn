import { randomUUID } from "node:crypto";
import type { Database, QueryExecutor } from "../database.js";
import { adjacentClosingDates, calculateBillingCycle, calculateDueDate } from "../credit-cards/billing-cycle.js";
import {
  assertCounterpartWallet,
  assertPendingTransfer,
  attachTransferOptions,
  importWalletTransfers,
  RECONCILE_TRANSFER_MESSAGE,
  reconcileWalletTransfers,
  undoWalletTransfers,
} from "./postgres-wallet-transfer-reconciliation.js";
import {
  assertOutgoingPayment,
  assertReconcilableStatement,
  attachStatementCandidates,
  importBankPayments,
  reconcileBankPayments,
  SELECT_STATEMENT_MESSAGE,
  undoBankPayments,
} from "./postgres-bank-payment-reconciliation.js";
import {
  importCardCredits,
  lockCardPurchasesForCredits,
  markItemsInPaidStatements,
  markValidItemsInPaidStatements,
  paidStatementMessage,
  prepareCardPosting,
  previewStatements,
} from "./postgres-card-statement-imports.js";
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
  FinancialImportKind,
  FinancialImportRepository,
  FinancialImportSession,
  FinancialImportStatus,
  ImportCreditCard,
  ParsedFinancialImportItem,
  UpdateFinancialImportItemInput,
} from "./financial-imports.types.js";
import { itemColumns, sessionColumns } from "./postgres-financial-imports.columns.js";
import {
  chunks,
  dateValue,
  invalidateReference,
  timestampValue,
} from "./postgres-financial-imports.shared.js";
import { undoImportInTransaction } from "./postgres-financial-imports.undo.js";
import {
  getSessionRow,
  getSessionWithItems,
  lockWalletImports,
  mapItem,
  mapSession,
  refreshCounters,
  sessionCard,
} from "./postgres-financial-imports.session.js";
import type { ImportItemRow, ImportSessionRow } from "./postgres-financial-imports.session.js";
import {
  markCurrentSessionDuplicates,
  markInFileDuplicates,
  markPreviouslyImportedDuplicates,
} from "./postgres-financial-imports.duplicates.js";

interface CsvMappingRow {
  id: string;
  name: string;
  configuration: CsvImportConfiguration;
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

function mapCsvMapping(row: CsvMappingRow): CsvMapping {
  return {
    id: row.id,
    name: row.name,
    configuration: row.configuration,
    createdAt: timestampValue(row.created_at)!,
    updatedAt: timestampValue(row.updated_at)!,
  };
}

export class PostgresFinancialImportsRepository implements FinancialImportRepository {
  constructor(private readonly database: Database) {}

  async createImport(
    userId: string,
    walletId: string,
    input: CreateFinancialImportInput,
  ): Promise<FinancialImportSession> {
    const result = await this.database.query<ImportSessionRow>(
      `INSERT INTO import_sessions (
         wallet_id, created_by_user_id, format, original_filename, file_size_bytes, file_hash, kind, credit_card_id
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::uuid)
       RETURNING ${sessionColumns("$2").replaceAll("session.", "import_sessions.")}`,
      [
        walletId,
        userId,
        input.format,
        input.fileName,
        input.fileSize,
        input.fileHash,
        input.creditCardId ? "credit_card_statement" : "bank_statement",
        input.creditCardId ?? null,
      ],
    );
    return mapSession(result.rows[0]!, userId);
  }

  async findImportCreditCard(walletId: string, creditCardId: string): Promise<ImportCreditCard | null> {
    const result = await this.database.query<{ id: string; closing_day: number; due_day: number }>(
      `SELECT id, closing_day, due_day
       FROM credit_cards
       WHERE id = $1 AND wallet_id = $2 AND is_active`,
      [creditCardId, walletId],
    );
    const row = result.rows[0];
    return row ? { id: row.id, closingDay: row.closing_day, dueDay: row.due_day } : null;
  }

  async savePreview(
    userId: string,
    walletId: string,
    importId: string,
    items: ParsedFinancialImportItem[],
    sourceMetadata: Record<string, string> = {},
  ): Promise<FinancialImportSession | null> {
    return this.database.transaction(async (transaction) => {
      const locked = await transaction.query<{ id: string; credit_card_id: string | null }>(
        `SELECT id, credit_card_id FROM import_sessions
         WHERE id = $1 AND wallet_id = $2 AND status = 'processing'
         FOR UPDATE`,
        [importId, walletId],
      );
      if (!locked.rows[0]) return null;
      const creditCardId = locked.rows[0].credit_card_id;
      await lockWalletImports(transaction, walletId);

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
        if (item.type === "transfer" || item.type === "card_credit") return { ...item, categoryId: null, subcategoryId: null };
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

      // The type is part of an item's identity, so an outgoing line becomes a statement payment
      // before the duplicate check runs. Checking first would compare a reimported payment as the
      // expense the parser suggested, miss the payment already imported and reduce the cash twice.
      const reconciledItems = creditCardId
        ? validatedItems
        : await reconcileWalletTransfers(
          transaction,
          walletId,
          await reconcileBankPayments(transaction, walletId, validatedItems),
        );
      const itemsWithFileDuplicates = markInFileDuplicates(reconciledItems);
      const itemsWithHistoryDuplicates = await markPreviouslyImportedDuplicates(
        transaction,
        walletId,
        itemsWithFileDuplicates,
        sourceMetadata,
        creditCardId,
      );
      const itemsReadyForPreview = creditCardId
        ? await markItemsInPaidStatements(transaction, walletId, creditCardId, itemsWithHistoryDuplicates)
        : itemsWithHistoryDuplicates;
      for (const batch of chunks(itemsReadyForPreview)) {
        const payload = batch.map((item) => ({
          sequence: item.sequence,
          transaction_date: item.date,
          description: item.description ?? null,
          signed_amount: item.signedAmount,
          type: item.type,
          category_id: item.categoryId ?? null,
          subcategory_id: item.subcategoryId ?? null,
          category_nature: item.type === "income" || item.type === "expense" ? item.type : null,
          statement_closing_date: creditCardId ? item.statementClosingDate ?? null : null,
          credit_card_statement_id: creditCardId ? null : item.creditCardStatementId ?? null,
          transfer_counterpart_wallet_id: creditCardId ? null : item.transferCounterpartWalletId ?? null,
          wallet_transfer_id: creditCardId ? null : item.walletTransferId ?? null,
          validation_status: item.validationStatus ?? "valid",
          error_message: item.errorMessage ?? null,
          is_repairable: item.isRepairable ?? false,
          external_id: item.externalId ?? null,
          record_hash: item.recordHash ?? null,
          duplicate_override_allowed: item.duplicateOverrideAllowed === true,
          categorization_source: item.categorizationSource ?? null,
        }));
        await transaction.query(
          `INSERT INTO import_items (
             import_session_id, wallet_id, sequence, transaction_date, description,
             signed_amount, type, category_id, subcategory_id, category_nature,
             validation_status, error_message, is_repairable, external_id, record_hash,
             duplicate_override_allowed, categorization_source, statement_closing_date,
             credit_card_statement_id, transfer_counterpart_wallet_id, wallet_transfer_id
           )
           SELECT $1, $2, item.sequence, item.transaction_date::date, item.description,
                  item.signed_amount::numeric, item.type, item.category_id::uuid,
                  item.subcategory_id::uuid, item.category_nature,
                  item.validation_status, item.error_message, item.is_repairable,
                  item.external_id, item.record_hash, item.duplicate_override_allowed, item.categorization_source,
                  item.statement_closing_date::date, item.credit_card_statement_id::uuid,
                  item.transfer_counterpart_wallet_id::uuid, item.wallet_transfer_id::uuid
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
             duplicate_override_allowed boolean,
             categorization_source text,
             statement_closing_date text,
             credit_card_statement_id text,
             transfer_counterpart_wallet_id text,
             wallet_transfer_id text
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
      await refreshCounters(transaction, walletId, importId, "preview");
      return getSessionWithItems(transaction, walletId, userId, importId);
    });
  }

  async listImports(userId: string, walletId: string): Promise<FinancialImportSession[]> {
    const result = await this.database.query<ImportSessionRow>(
      `SELECT ${sessionColumns("$2")}
       FROM import_sessions AS session
       WHERE session.wallet_id = $1
       ORDER BY session.created_at DESC, session.id DESC`,
      [walletId, userId],
    );
    return result.rows.map((row) => mapSession(row, userId));
  }

  async getImport(userId: string, walletId: string, importId: string): Promise<FinancialImportSession | null> {
    return getSessionWithItems(this.database, walletId, userId, importId);
  }

  async markFailed(
    userId: string,
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

  async expireStaleImports(walletId: string, olderThanMinutes: number, failureMessage: string): Promise<number> {
    if (!Number.isSafeInteger(olderThanMinutes) || olderThanMinutes <= 0) return 0;
    const result = await this.database.query(
      `UPDATE import_sessions
       SET status = 'failed', failure_message = $3, failed_at = now(), updated_at = now()
       WHERE wallet_id = $1
         AND status = 'processing'
         AND created_at < now() - ($2::integer * interval '1 minute')`,
      [walletId, olderThanMinutes, failureMessage],
    );
    return result.rowCount ?? 0;
  }

  async updateItem(
    userId: string,
    walletId: string,
    importId: string,
    itemId: string,
    input: Required<UpdateFinancialImportItemInput>,
  ): Promise<FinancialImportItem | null> {
    return this.database.transaction(async (transaction) => {
      const session = await transaction.query<{
        id: string;
        credit_card_id: string | null;
        closing_day: number | null;
        due_day: number | null;
      }>(
        `SELECT session.id, session.credit_card_id, card.closing_day, card.due_day
         FROM import_sessions AS session
         LEFT JOIN credit_cards AS card
           ON card.id = session.credit_card_id AND card.wallet_id = session.wallet_id
         WHERE session.id = $1 AND session.wallet_id = $2 AND session.status = 'preview'
         FOR UPDATE OF session`,
        [importId, walletId],
      );
      if (!session.rows[0]) return null;
      const sessionRow = session.rows[0];
      const card: ImportCreditCard | null = sessionRow.credit_card_id && sessionRow.closing_day !== null && sessionRow.due_day !== null
        ? { id: sessionRow.credit_card_id, closingDay: sessionRow.closing_day, dueDay: sessionRow.due_day }
        : null;
      if (card ? input.type === "income" : input.type === "card_credit") {
        throw new FinancialImportError(
          card
            ? "Em uma fatura de cartão, escolha compra, estorno/crédito na fatura ou pagamento da fatura."
            : "Estornos e créditos na fatura só existem em importações de fatura de cartão.",
          400,
        );
      }
      if (!card && input.statementClosingDate !== null) {
        throw new FinancialImportError("A fatura só pode ser escolhida em importações de fatura de cartão.", 400);
      }
      const reconciledStatementId = card ? null : input.creditCardStatementId ?? null;
      if (card && input.creditCardStatementId) {
        throw new FinancialImportError("A conciliação de pagamento só existe em importações de extrato bancário.", 400);
      }
      if (reconciledStatementId !== null) {
        if (input.type !== "transfer") {
          throw new FinancialImportError("Somente um pagamento de fatura pode ser conciliado com uma fatura.", 400);
        }
        await assertReconcilableStatement(transaction, walletId, reconciledStatementId);
      }
      const chosenTransferId = card ? null : input.walletTransferId ?? null;
      const chosenCounterpartWalletId = card ? null : input.transferCounterpartWalletId ?? null;
      if (card && (input.walletTransferId || input.transferCounterpartWalletId)) {
        throw new FinancialImportError("A conciliação entre carteiras só existe em importações de extrato bancário.", 400);
      }
      if ((chosenTransferId !== null || chosenCounterpartWalletId !== null) && input.type !== "transfer") {
        throw new FinancialImportError("Somente uma transferência pode ser conciliada com outra carteira.", 400);
      }
      let statementClosingDate: string | null = null;
      let isInPaidStatement = false;
      if (card) {
        const allowedClosingDates = adjacentClosingDates(input.date, card.closingDay, card.dueDay);
        statementClosingDate = input.statementClosingDate
          ?? calculateBillingCycle(input.date, card.closingDay, card.dueDay).closingDate;
        if (!allowedClosingDates.includes(statementClosingDate)) {
          throw new FinancialImportError("Escolha a fatura calculada para a data do item, a anterior ou a seguinte.", 400);
        }
        if (input.type !== "transfer") {
          const paid = await transaction.query<{ id: string }>(
            `SELECT id FROM credit_card_statements
             WHERE wallet_id = $1 AND credit_card_id = $2 AND closing_date = $3::date AND paid_date IS NOT NULL`,
            [walletId, card.id, statementClosingDate],
          );
          isInPaidStatement = paid.rows.length > 0;
        }
      }

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
      // Money received can never pay a statement, whatever type the user picked.
      if (reconciledStatementId !== null) assertOutgoingPayment(currentItem.rows[0].signed_amount);
      let counterpartWalletId = chosenCounterpartWalletId;
      if (chosenTransferId !== null) {
        // The chosen transfer already has both ends, so it decides the counterpart instead of the
        // wallet the client sent: the two can only disagree by mistake.
        counterpartWalletId = await assertPendingTransfer(
          transaction,
          walletId,
          chosenTransferId,
          currentItem.rows[0].signed_amount,
        );
      } else if (counterpartWalletId !== null) {
        await assertCounterpartWallet(transaction, userId, walletId, counterpartWalletId);
      }

      const hasCategory = input.type === "income" || input.type === "expense";
      const categoryId = hasCategory ? input.categoryId : null;
      const subcategoryId = hasCategory ? input.subcategoryId : null;
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
      // A transfer is ready to import once it has one destination: the statement it pays or the
      // wallet on the other end. Without either it stays out of the import.
      const isReconciledPayment = input.type === "transfer" && reconciledStatementId !== null;
      const isReconciledTransfer = input.type === "transfer" && counterpartWalletId !== null;
      const isReconciledMovement = isReconciledPayment || isReconciledTransfer;
      const validationStatus = isInPaidStatement
        ? "invalid"
        : (input.type === "transfer" && !isReconciledMovement) || (hasCategory && categoryId === null)
          ? "uncategorized"
          : "valid";
      const errorMessage = isInPaidStatement && statementClosingDate
        ? paidStatementMessage(statementClosingDate)
        : input.type === "transfer" && !isReconciledMovement
          ? card
            ? "Pagamento da fatura: ele é conciliado com o extrato bancário e não é importado como estorno."
            : RECONCILE_TRANSFER_MESSAGE
          : hasCategory && categoryId === null
            ? "Selecione uma categoria para importar a movimentação."
            : null;
      const result = await transaction.query<ImportItemRow>(
        `UPDATE import_items AS item
         SET transaction_date = $4::date,
             description = $5,
             type = $6,
             category_id = $7::uuid,
             subcategory_id = $8::uuid,
             category_nature = CASE WHEN $6 IN ('income', 'expense') THEN $6 ELSE NULL END,
             validation_status = $9,
             error_message = $10,
             is_repairable = $14::boolean,
             statement_closing_date = $15::date,
             credit_card_statement_id = $16::uuid,
             transfer_counterpart_wallet_id = $17::uuid,
             wallet_transfer_id = $18::uuid,
             duplicate_override_allowed = false,
             -- Saving a rule-suggested item unchanged keeps its origin; any edit makes it a manual choice.
             categorization_source = CASE
               WHEN $7::uuid IS NULL THEN NULL
               WHEN item.categorization_source = 'rule'
                 AND item.category_id = $7::uuid
                 AND item.subcategory_id IS NOT DISTINCT FROM $8::uuid
                 AND item.type = $6
                 AND item.description IS NOT DISTINCT FROM $5
               THEN 'rule'
               ELSE 'manual'
             END,
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
          isInPaidStatement,
          statementClosingDate,
          reconciledStatementId,
          counterpartWalletId,
          chosenTransferId,
        ],
      );
      const row = result.rows[0];
      if (!row) return null;
      await refreshCounters(transaction, walletId, importId);
      return mapItem(row, card);
    });
  }

  async confirmImport(
    userId: string,
    walletId: string,
    importId: string,
  ): Promise<FinancialImportSession | null> {
    return this.database.transaction(async (transaction) => {
      await lockWalletImports(transaction, walletId);
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
      const cardSession = await transaction.query<{ credit_card_id: string | null; closing_day: number | null; due_day: number | null; is_active: boolean | null }>(
        `SELECT session.credit_card_id, card.closing_day, card.due_day, card.is_active
         FROM import_sessions AS session
         LEFT JOIN credit_cards AS card
           ON card.id = session.credit_card_id AND card.wallet_id = session.wallet_id
         WHERE session.id = $1 AND session.wallet_id = $2`,
        [importId, walletId],
      );
      const cardRow = cardSession.rows[0];
      const card: ImportCreditCard | null = cardRow?.credit_card_id && cardRow.closing_day !== null && cardRow.due_day !== null
        ? { id: cardRow.credit_card_id, closingDay: cardRow.closing_day, dueDay: cardRow.due_day }
        : null;
      if (card && cardRow?.is_active !== true) {
        throw new FinancialImportError("O cartão desta fatura está inativo. Reative-o para confirmar a importação.", 409);
      }
      const newlyDetectedDuplicates = await markCurrentSessionDuplicates(transaction, walletId, importId);
      const newlyPaidStatementItems = card ? await markValidItemsInPaidStatements(transaction, walletId, importId, card) : 0;
      if (newlyDetectedDuplicates > 0 || newlyPaidStatementItems > 0) {
        await refreshCounters(transaction, walletId, importId);
        await transaction.query(
          `UPDATE import_sessions
           SET status = 'preview', confirmed_at = NULL, updated_at = now()
           WHERE id = $1 AND wallet_id = $2`,
          [importId, walletId],
        );
        return getSessionWithItems(transaction, walletId, userId, importId);
      }
      const items = await transaction.query<{
        id: string;
        sequence: number;
        type: FinancialImportItemType;
        category_id: string | null;
        subcategory_id: string | null;
        amount: string;
        transaction_date: string | Date;
        description: string | null;
        statement_closing_date: string | Date | null;
        credit_card_statement_id: string | null;
        signed_amount: string;
        transfer_counterpart_wallet_id: string | null;
        wallet_transfer_id: string | null;
      }>(
        `SELECT id, sequence, type, category_id, subcategory_id, abs(signed_amount)::text AS amount,
                transaction_date, description, statement_closing_date, credit_card_statement_id,
                signed_amount::text AS signed_amount, transfer_counterpart_wallet_id, wallet_transfer_id
         FROM import_items
         WHERE import_session_id = $1 AND wallet_id = $2 AND validation_status = 'valid'
         ORDER BY sequence
         FOR UPDATE`,
        [importId, walletId],
      );
      if (items.rows.length === 0) {
        await refreshCounters(transaction, walletId, importId);
        await transaction.query(
          `UPDATE import_sessions
           SET status = 'preview', confirmed_at = NULL, updated_at = now()
           WHERE id = $1 AND wallet_id = $2`,
          [importId, walletId],
        );
        return getSessionWithItems(transaction, walletId, userId, importId);
      }

      if (card && items.rows.some((item) => item.type === "transfer")) {
        throw new FinancialImportError("Concilie as transferências antes de confirmar a importação.", 409);
      }

      // Card purchases are credit card expenses posted to their statement; they leave the cash
      // balance only when the statement is paid.
      if (card) await lockCardPurchasesForCredits(transaction, walletId, card, items.rows);
      const cardPosting = card ? await prepareCardPosting(transaction, walletId, card, items.rows) : null;

      for (const type of ["income", "expense"] as const) {
        const target = type === "income" ? "incomes" : "expenses";
        const resultColumn = type === "income" ? "resulting_income_id" : "resulting_expense_id";
        const cardColumns = type === "expense" && cardPosting;
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
            statement_id: cardColumns ? cardPosting.statementIds.get(dateValue(item.statement_closing_date)) ?? null : null,
          }));
          if (cardColumns && payload.some((entry) => entry.statement_id === null)) {
            throw new FinancialImportError("Uma compra da fatura não possui fatura de destino válida.", 409);
          }
          const imported = await transaction.query<{ id: string }>(
            `WITH input AS (
               SELECT * FROM jsonb_to_recordset($3::jsonb) AS data(
                 import_item_id uuid,
                 movement_id uuid,
                 category_id uuid,
                 subcategory_id uuid,
                 amount numeric,
                 transaction_date date,
                 description text,
                 statement_id uuid
               )
             ), inserted AS (
               INSERT INTO ${target} (
                 id, user_id, wallet_id, category_id, subcategory_id, amount, date, description${cardColumns
                   ? ", payment_method_id, payment_method_nature, credit_card_statement_id"
                   : ""}
               )
               SELECT input.movement_id, $1, $2, category.id, input.subcategory_id,
                      input.amount, input.transaction_date, input.description${cardColumns
                        ? ", $5::uuid, 'credit_card', input.statement_id"
                        : ""}
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
            cardColumns
              ? [userId, walletId, JSON.stringify(payload), importId, cardPosting.paymentMethodId]
              : [userId, walletId, JSON.stringify(payload), importId],
          );
          if (imported.rows.length !== batch.length) {
            throw new FinancialImportError("Uma categoria ou subcategoria da importação não está mais disponível.", 409);
          }
        }
      }

      if (cardPosting) {
        await importCardCredits(transaction, userId, walletId, importId, card!, cardPosting.statementIds, items.rows);
      } else {
        await importBankPayments(transaction, walletId, importId, items.rows);
        await importWalletTransfers(transaction, walletId, userId, importId, items.rows);
      }

      await refreshCounters(transaction, walletId, importId);
      await transaction.query(
        `UPDATE import_sessions
         SET status = 'completed',
             completed_at = now(),
             updated_at = now()
         WHERE id = $1 AND wallet_id = $2`,
        [importId, walletId],
      );
      return getSessionWithItems(transaction, walletId, userId, importId);
    });
  }

  async undoImport(
    userId: string,
    walletId: string,
    importId: string,
  ): Promise<FinancialImportSession | null> {
    return this.database.transaction((transaction) => undoImportInTransaction(transaction, userId, walletId, importId));
  }

  async discardImport(
    userId: string,
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
             categorization_source = NULL,
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
      await refreshCounters(transaction, walletId, importId);
      await transaction.query(
        `UPDATE import_sessions
         SET status = 'failed',
             failure_message = 'Importação descartada pelo usuário.',
             failed_at = now(),
             updated_at = now()
         WHERE id = $1 AND wallet_id = $2`,
        [importId, walletId],
      );
      return getSessionWithItems(transaction, walletId, userId, importId);
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


}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "23505";
}
