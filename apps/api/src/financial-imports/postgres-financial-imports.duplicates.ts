import type { QueryExecutor } from "../database.js";
import {
  createFinancialImportFingerprint,
  createLegacyFinancialImportFingerprint,
  createLegacyOfxFinancialImportFingerprint,
  normalizeSignedAmount,
} from "./financial-imports.fingerprint.js";
import type {
  FinancialImportItemStatus,
  FinancialImportItemType,
  ParsedFinancialImportItem,
} from "./financial-imports.types.js";
import { chunks, dateValue } from "./postgres-financial-imports.shared.js";

// Duplicate detection for an import: inside the file being previewed, against what the wallet has
// already imported, and once more at confirmation time, when another import may have landed the same
// movement meanwhile. The identity of a movement is what this module is about — see
// duplicateIdentityTypes for why a bank statement line is compared under more than one type.

export function markInFileDuplicates(items: ParsedFinancialImportItem[]): ParsedFinancialImportItem[] {
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

// An outgoing line that may pay a statement has two possible identities: the expense the parser
// suggested and the statement payment it becomes once reconciled. Which one it takes depends on
// whether a statement was open at the time, so both are compared and a reimported payment is
// recognized either way.
// In a bank statement the same line may have been persisted as the movement the parser read or as a
// transfer: the payment of a card statement (DEV-85) or the mirror of another wallet's line
// (DEV-88). Which one it became depends on the state of the database at the time, so every identity
// the same real movement can take is compared. Comparing only the current type would miss a line
// already imported as a transfer and count the money twice.
export function duplicateIdentityTypes(item: ParsedFinancialImportItem, isCardImport: boolean): FinancialImportItemType[] {
  if (isCardImport || item.type === "card_credit" || !item.signedAmount) return [item.type];
  const parsedType: FinancialImportItemType = item.signedAmount.startsWith("-") ? "expense" : "income";
  return [...new Set<FinancialImportItemType>([item.type, parsedType, "transfer"])];
}

export function duplicateIdentityHashes(item: ParsedFinancialImportItem, isCardImport: boolean): string[] {
  if (!item.date || !item.signedAmount) return [];
  return duplicateIdentityTypes(item, isCardImport).flatMap((type) => {
    const hash = createFinancialImportFingerprint({
      date: item.date!,
      signedAmount: item.signedAmount!,
      type,
      description: item.description ?? null,
    });
    return hash ? [hash] : [];
  });
}

export async function markPreviouslyImportedDuplicates(
  executor: QueryExecutor,
  walletId: string,
  items: ParsedFinancialImportItem[],
  sourceMetadata: Record<string, string>,
  creditCardId: string | null,
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
    const candidatesPayload = batch.flatMap((item) => {
      const date = item.date!;
      const signedAmount = item.signedAmount!;
      const description = item.description ?? null;
      for (const hash of duplicateIdentityHashes(item, creditCardId !== null)) hashes.add(hash);
      hashes.add(createLegacyFinancialImportFingerprint({ date, signedAmount, description }));
      if (accountReferenceHash) {
        hashes.add(createLegacyOfxFinancialImportFingerprint({ accountReferenceHash, date, signedAmount, description }));
      }
      return duplicateIdentityTypes(item, creditCardId !== null).map((type) => (
        { transaction_date: date, signed_amount: signedAmount, type }
      ));
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
         AND session.credit_card_id IS NOT DISTINCT FROM $6::uuid
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
      [walletId, JSON.stringify(candidatesPayload), [...hashes], accountReferenceHash, externalIdBatch, creditCardId],
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
    const matchesFingerprint = duplicateIdentityHashes(item, creditCardId !== null).some((hash) => existingFingerprints.has(hash));
    const fingerprintWasReviewed = item.acceptedDuplicateFingerprint === item.recordHash;
    if (!matchesExternalId && (!matchesFingerprint || fingerprintWasReviewed)) return item;
    return {
      ...item,
      validationStatus: "duplicate",
      duplicateOverrideAllowed: !matchesExternalId,
      errorMessage: matchesExternalId
        ? creditCardId
          ? "Esta movimentação já foi importada: o FITID coincide na fatura deste cartão."
          : "Esta movimentação já foi importada: o FITID coincide na mesma conta bancária."
        : creditCardId
          ? "Possível duplicidade: já existe uma importação deste cartão com mesma data, valor, tipo e descrição. Revise antes de importar."
          : "Possível duplicidade: já existe uma importação nesta carteira com mesma data, valor, tipo e descrição. Revise antes de importar.",
    };
  });
}

export async function markCurrentSessionDuplicates(
  executor: QueryExecutor,
  walletId: string,
  importId: string,
): Promise<number> {
  const session = await executor.query<{ source_metadata: Record<string, string>; credit_card_id: string | null }>(
    "SELECT source_metadata, credit_card_id FROM import_sessions WHERE id = $1 AND wallet_id = $2",
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
  const inFileChecked = markInFileDuplicates(candidates);
  const marked = await markPreviouslyImportedDuplicates(
    executor,
    walletId,
    inFileChecked,
    session.rows[0]?.source_metadata ?? {},
    session.rows[0]?.credit_card_id ?? null,
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
