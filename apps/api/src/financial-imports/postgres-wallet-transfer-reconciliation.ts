import type { QueryExecutor } from "../database.js";
import { looksLikeCardPayment } from "./postgres-bank-payment-reconciliation.js";
import { createFinancialImportFingerprint } from "./financial-imports.fingerprint.js";
import { FinancialImportError } from "./financial-imports.errors.js";
import { moneyToCents } from "../shared/money.js";
import type {
  FinancialImportItem,
  ParsedFinancialImportItem,
  ReconciliationUnavailableReason,
  TransferCounterpartWallet,
  WalletTransferCandidate,
} from "./financial-imports.types.js";

// Reconciling a transfer between wallets (DEV-58): the money leaves one wallet and arrives in
// another, so it is never income nor expense. The transfer itself records the money once, and each
// side is a line of the corresponding wallet's statement. The sides may be imported in any order, or
// only one of them ever imported, so a line either creates the transfer or completes the side still
// missing from one that already exists.

// How far apart the two sides of the same transfer may be dated.
const TRANSFER_DATE_WINDOW_DAYS = 3;
const MAX_CANDIDATES = 5;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// Shared with updateItem: a transfer has two possible destinations, so a line saved without either
// says both in the same message.
export const RECONCILE_TRANSFER_MESSAGE = "Concilie esta transferência: escolha a fatura que ela paga ou a carteira do outro lado.";
export const SELECT_TRANSFER_MESSAGE = "Escolha a carteira do outro lado desta transferência para incluí-la na importação.";
export const SELECT_PENDING_TRANSFER_MESSAGE = "Escolha a transferência que esta movimentação completa, ou a carteira do outro lado.";

function dateValue(value: string | Date | null): string {
  if (value === null) return "";
  return value instanceof Date ? value.toISOString().slice(0, 10) : value.slice(0, 10);
}

function toCents(value: string): bigint {
  const cents = moneyToCents(value);
  if (cents === null) throw new FinancialImportError("O valor da movimentação é inválido.", 422);
  return cents;
}

// An outgoing line pays another wallet, an incoming line receives from one. Which end of the
// transfer the line is depends only on its sign.
export function isOutgoingTransfer(signedAmount: string | null): boolean {
  return signedAmount !== null && signedAmount.startsWith("-");
}


interface CandidateRow {
  id: string;
  amount: string;
  date: string | Date;
  description: string | null;
  counterpart_wallet_id: string;
  // Null when the reader is no longer a member of the wallet on the other end. Access to a wallet
  // can be revoked after a transfer exists, and the transfer itself stays: the money did move. What
  // stops being theirs to read is the wallet's name.
  counterpart_wallet_name: string | null;
  direction: "outgoing" | "incoming";
}


// The wallets the user may put on the other end: the ones they can access, never the item's own.
export async function findCounterpartWallets(
  executor: QueryExecutor,
  userId: string,
  walletId: string,
): Promise<TransferCounterpartWallet[]> {
  const result = await executor.query<{ id: string; name: string; is_personal: boolean }>(
    `SELECT wallet.id, wallet.name, wallet.is_personal
     FROM wallets AS wallet
     JOIN wallet_members AS membership
       ON membership.wallet_id = wallet.id AND membership.user_id = $1
     WHERE wallet.id <> $2
     ORDER BY wallet.is_personal DESC, wallet.name, wallet.id`,
    [userId, walletId],
  );
  return result.rows.map((row) => ({
    walletId: row.id,
    walletName: row.name,
    isPersonal: row.is_personal,
  }));
}

// Changing the type changes the item's identity, so the fingerprint is recalculated with the fields
// that will be persisted. Without this, a later import of the same line would not be seen as a
// duplicate and the money would be counted twice.
function asWalletTransfer(
  item: ParsedFinancialImportItem,
  candidate: WalletTransferCandidate | null,
  validationStatus: "valid" | "uncategorized",
  errorMessage: string | null,
): ParsedFinancialImportItem {
  return {
    ...item,
    type: "transfer",
    recordHash: createFinancialImportFingerprint({
      date: item.date,
      signedAmount: item.signedAmount,
      type: "transfer",
      description: item.description,
    }),
    categoryId: null,
    subcategoryId: null,
    creditCardStatementId: null,
    walletTransferId: candidate?.walletTransferId ?? null,
    transferCounterpartWalletId: candidate?.counterpartWalletId ?? null,
    validationStatus,
    errorMessage,
  };
}

// A line that the parser already classified as a transfer is reconciled with another wallet; a card
// payment is the other destination of the same type and keeps its own, more specific suggestion.
function isDeclaredTransfer(item: ParsedFinancialImportItem): boolean {
  return item.type === "transfer"
    && !item.creditCardStatementId
    && !looksLikeCardPayment(item.description);
}

// An ordinary debit or credit may still be the other side of a transfer already registered: most
// statements do not mark a transfer as such, so what identifies it is a pending transfer waiting for
// exactly this amount on this date. Without one, the line stays the movement it is.
function mayMirrorPendingTransfer(item: ParsedFinancialImportItem): boolean {
  return (item.type === "expense" || item.type === "income") && !looksLikeCardPayment(item.description);
}

// Attaches the pending transfers to the lines of a bank statement preview that may be one side of a
// transfer. A single pending transfer is suggested, because its two ends are already decided;
// anything else waits for the user, who still confirms which wallet is on the other end.
export async function reconcileWalletTransfers(
  executor: QueryExecutor,
  walletId: string,
  items: ParsedFinancialImportItem[],
): Promise<ParsedFinancialImportItem[]> {
  const reconcilable = items
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => item.date !== null
      && item.signedAmount !== null
      && item.validationStatus !== "invalid"
      && item.validationStatus !== "duplicate"
      && (isDeclaredTransfer(item) || mayMirrorPendingTransfer(item)));
  if (reconcilable.length === 0) return items;
  const candidatesByIndex = await findTransferCandidatesInBatch(
    executor,
    walletId,
    reconcilable.map(({ item, index }) => ({
      index,
      date: item.date!,
      amount: item.signedAmount!.startsWith("-") ? item.signedAmount!.slice(1) : item.signedAmount!,
      outgoing: item.signedAmount!.startsWith("-"),
    })),
  );
  const reconciled = [...items];
  // A pending transfer has a single side to fill in this wallet, so it is suggested to at most one
  // line: a second line of the same amount and date waits for the user instead of being confirmed
  // into a conflict it did not cause.
  const claimed = new Set<string>();
  for (const { item, index } of reconcilable) {
    const candidates = (candidatesByIndex.get(index) ?? []).filter((candidate) => !claimed.has(candidate.walletTransferId));
    if (candidates.length === 1) {
      claimed.add(candidates[0]!.walletTransferId);
      reconciled[index] = asWalletTransfer(item, candidates[0]!, "valid", null);
    } else if (isDeclaredTransfer(item)) {
      reconciled[index] = asWalletTransfer(
        item,
        null,
        "uncategorized",
        candidates.length > 0 ? SELECT_PENDING_TRANSFER_MESSAGE : SELECT_TRANSFER_MESSAGE,
      );
    }
    // An ordinary line with no single pending transfer stays the income or expense it is.
  }
  return reconciled;
}

const CANDIDATE_BATCH_SIZE = 500;

// One query per batch of lines instead of one per line: a statement may bring thousands of them.
async function findTransferCandidatesInBatch(
  executor: QueryExecutor,
  walletId: string,
  lines: Array<{ index: number; date: string; amount: string; outgoing: boolean }>,
): Promise<Map<number, WalletTransferCandidate[]>> {
  const candidatesByIndex = new Map<number, WalletTransferCandidate[]>();
  for (const line of lines) candidatesByIndex.set(line.index, []);
  for (let start = 0; start < lines.length; start += CANDIDATE_BATCH_SIZE) {
    const batch = lines.slice(start, start + CANDIDATE_BATCH_SIZE);
    const result = await executor.query<CandidateRow & { line_index: number }>(
      `WITH line AS (
         SELECT * FROM jsonb_to_recordset($4::jsonb) AS entry(
           line_index integer,
           line_date text,
           amount text,
           outgoing boolean
         )
       )
       SELECT line.line_index,
              candidate.id,
              candidate.amount,
              candidate.date,
              candidate.description,
              candidate.counterpart_wallet_id,
              candidate.counterpart_wallet_name,
              candidate.direction
       FROM line
       CROSS JOIN LATERAL (
         SELECT transfer.id,
                transfer.amount::text AS amount,
                transfer.date,
                transfer.description,
                CASE WHEN line.outgoing THEN transfer.to_wallet_id ELSE transfer.from_wallet_id END AS counterpart_wallet_id,
                -- These candidates only decide the suggestion during the import and never reach a
                -- client, so the name is not read here at all. Selecting it would be the one way
                -- this path could ever leak a wallet the reader may no longer access.
                NULL::text AS counterpart_wallet_name,
                CASE WHEN line.outgoing THEN 'outgoing' ELSE 'incoming' END AS direction
         FROM wallet_transfers AS transfer
         JOIN wallets AS counterpart
           ON counterpart.id = CASE WHEN line.outgoing THEN transfer.to_wallet_id ELSE transfer.from_wallet_id END
         WHERE CASE WHEN line.outgoing THEN transfer.from_wallet_id ELSE transfer.to_wallet_id END = $1
           AND transfer.amount = line.amount::numeric
           AND transfer.date BETWEEN line.line_date::date - $2::integer AND line.line_date::date + $2::integer
           AND NOT EXISTS (
             SELECT 1 FROM import_items AS reconciled
             WHERE reconciled.resulting_wallet_transfer_id = transfer.id
               AND reconciled.wallet_id = $1
           )
         ORDER BY abs(transfer.date - line.line_date::date), transfer.date, transfer.id
         LIMIT $3
       ) AS candidate`,
      [walletId, TRANSFER_DATE_WINDOW_DAYS, MAX_CANDIDATES, JSON.stringify(batch.map((line) => ({
        line_index: line.index,
        line_date: line.date,
        amount: line.amount,
        outgoing: line.outgoing,
      })))],
    );
    for (const row of result.rows) {
      candidatesByIndex.get(row.line_index)?.push({
        walletTransferId: row.id,
        counterpartWalletId: row.counterpart_wallet_id,
        counterpartWalletName: row.counterpart_wallet_name,
        amount: row.amount,
        date: dateValue(row.date),
        description: row.description,
        direction: row.direction,
      });
    }
  }
  return candidatesByIndex;
}

// Loads candidates and wallets again when a preview is read, so the lists reflect what changed
// meanwhile — another import may have completed a transfer this preview still offers. The sign of
// each line decides which end of a transfer it is, and the mapped item carries the absolute amount,
// so the candidates are looked up from the stored lines instead.
export async function attachTransferOptions(
  executor: QueryExecutor,
  walletId: string,
  userId: string,
  importId: string,
  items: FinancialImportItem[],
  status: string,
): Promise<FinancialImportItem[]> {
  if (status !== "preview") return items;
  const pending = items.filter((item) => item.validationStatus !== "imported"
    && item.type === "transfer" && !item.creditCardStatementId && !looksLikeCardPayment(item.description) && item.date);
  const candidatesByItem = new Map<string, WalletTransferCandidate[]>();
  for (const item of pending) candidatesByItem.set(item.id, []);
  if (pending.length > 0) await loadTransferCandidates(executor, walletId, userId, importId, pending, candidatesByItem);
  // The wallets are only offered to a line that was evaluated as a transfer, so a preview with none
  // does not pay for the query.
  const counterpartWallets = pending.length > 0
    ? await findCounterpartWallets(executor, userId, walletId)
    : [];
  return items.map((item) => {
    // Only a line the user can still edit gets the lists: an imported one is settled, and an invalid
    // line beyond repair has no reconciliation to offer and no action to take about it. Saying
    // "not a transfer" there would answer a question nobody can act on.
    if (!item.canEdit) return item;
    const evaluated = candidatesByItem.has(item.id);
    const transferCandidates = candidatesByItem.get(item.id) ?? [];
    const statementCandidates = item.statementCandidates ?? [];
    const wallets = evaluated ? counterpartWallets : [];
    return {
      ...item,
      statementCandidates,
      transferCandidates,
      transferCounterpartWallets: wallets,
      reconciliationUnavailableReason: reconciliationUnavailableReason(item, evaluated, {
        statements: statementCandidates.length,
        transfers: transferCandidates.length,
        wallets: wallets.length,
      }),
    };
  });
}

// Said only when there is nothing to offer: with any option available the client has what it needs.
function reconciliationUnavailableReason(
  item: FinancialImportItem,
  evaluatedAsTransfer: boolean,
  counts: { statements: number; transfers: number; wallets: number },
): ReconciliationUnavailableReason {
  if (counts.statements > 0 || counts.transfers > 0 || counts.wallets > 0) return null;
  if (item.type !== "transfer") return "not_a_transfer";
  if (evaluatedAsTransfer) return null;
  // Stored as a transfer and still left out: the line is reserved to the statement reconciliation,
  // which is the more specific one for a description that points to a card payment.
  return "card_payment";
}

async function loadTransferCandidates(
  executor: QueryExecutor,
  walletId: string,
  userId: string,
  importId: string,
  pending: FinancialImportItem[],
  candidatesByItem: Map<string, WalletTransferCandidate[]>,
): Promise<void> {
  const result = await executor.query<CandidateRow & { item_id: string }>(
    `WITH pending AS (
       SELECT item.id,
              item.transaction_date AS date,
              item.signed_amount < 0 AS outgoing,
              abs(item.signed_amount) AS amount
       FROM import_items AS item
       WHERE item.import_session_id = $1
         AND item.wallet_id = $2
         AND item.type = 'transfer'
         AND item.credit_card_statement_id IS NULL
         AND item.id = ANY($5::uuid[])
         AND item.validation_status <> 'imported'
         AND item.transaction_date IS NOT NULL
         AND item.signed_amount IS NOT NULL
     )
     SELECT pending.id AS item_id,
            candidate.id,
            candidate.amount,
            candidate.date,
            candidate.description,
            candidate.counterpart_wallet_id,
            candidate.counterpart_wallet_name,
            candidate.direction
     FROM pending
     CROSS JOIN LATERAL (
       SELECT transfer.id,
              transfer.amount::text AS amount,
              transfer.date,
              transfer.description,
              CASE WHEN pending.outgoing THEN transfer.to_wallet_id ELSE transfer.from_wallet_id END AS counterpart_wallet_id,
              -- The name of the other wallet is only served while the reader is still a member of
              -- it. The candidate stays either way: this wallet is one end of the transfer, the
              -- money already left it, and the line deserves to be reconciled as what it is.
              CASE WHEN EXISTS (
                SELECT 1 FROM wallet_members AS viewer
                WHERE viewer.wallet_id = counterpart.id AND viewer.user_id = $6
              ) THEN counterpart.name END AS counterpart_wallet_name,
              CASE WHEN pending.outgoing THEN 'outgoing' ELSE 'incoming' END AS direction
       FROM wallet_transfers AS transfer
       JOIN wallets AS counterpart
         ON counterpart.id = CASE WHEN pending.outgoing THEN transfer.to_wallet_id ELSE transfer.from_wallet_id END
       WHERE CASE WHEN pending.outgoing THEN transfer.from_wallet_id ELSE transfer.to_wallet_id END = $2
         AND transfer.amount = pending.amount
         AND transfer.date BETWEEN pending.date - $3::integer AND pending.date + $3::integer
         AND NOT EXISTS (
           SELECT 1 FROM import_items AS reconciled
           WHERE reconciled.resulting_wallet_transfer_id = transfer.id
             AND reconciled.wallet_id = $2
         )
       ORDER BY abs(transfer.date - pending.date), transfer.date, transfer.id
       LIMIT $4
     ) AS candidate`,
    [importId, walletId, TRANSFER_DATE_WINDOW_DAYS, MAX_CANDIDATES, pending.map((item) => item.id), userId],
  );
  for (const row of result.rows) {
    candidatesByItem.get(row.item_id)?.push({
      walletTransferId: row.id,
      counterpartWalletId: row.counterpart_wallet_id,
      counterpartWalletName: row.counterpart_wallet_name,
      amount: row.amount,
      date: dateValue(row.date),
      description: row.description,
      direction: row.direction,
    });
  }
}

// Validates the wallet the user chose for the other end: it must exist and be reachable by them.
export async function assertCounterpartWallet(
  executor: QueryExecutor,
  userId: string,
  walletId: string,
  counterpartWalletId: string,
): Promise<void> {
  if (!UUID_PATTERN.test(counterpartWalletId)) {
    throw new FinancialImportError("A carteira escolhida não foi encontrada.", 404);
  }
  if (counterpartWalletId === walletId) {
    throw new FinancialImportError("A transferência precisa envolver duas carteiras diferentes.", 400);
  }
  const result = await executor.query<{ reachable: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM wallet_members
       WHERE wallet_id = $1 AND user_id = $2
     ) AS reachable`,
    [counterpartWalletId, userId],
  );
  if (!result.rows[0]?.reachable) {
    throw new FinancialImportError("A carteira escolhida não foi encontrada.", 404);
  }
}

// Validates the pending transfer the user chose: it must have this wallet on the matching end, with
// that side still missing.
export async function assertPendingTransfer(
  executor: QueryExecutor,
  walletId: string,
  walletTransferId: string,
  signedAmount: string | null,
): Promise<string> {
  if (!UUID_PATTERN.test(walletTransferId)) {
    throw new FinancialImportError("A transferência escolhida não foi encontrada.", 404);
  }
  const outgoing = isOutgoingTransfer(signedAmount);
  const result = await executor.query<{ counterpart_wallet_id: string; amount: string; taken: boolean }>(
    `SELECT CASE WHEN $3::boolean THEN transfer.to_wallet_id ELSE transfer.from_wallet_id END AS counterpart_wallet_id,
            transfer.amount::text AS amount,
            EXISTS (
              SELECT 1 FROM import_items AS reconciled
              WHERE reconciled.resulting_wallet_transfer_id = transfer.id
                AND reconciled.wallet_id = $2
            ) AS taken
     FROM wallet_transfers AS transfer
     WHERE transfer.id = $1
       AND CASE WHEN $3::boolean THEN transfer.from_wallet_id ELSE transfer.to_wallet_id END = $2`,
    [walletTransferId, walletId, outgoing],
  );
  const transfer = result.rows[0];
  if (!transfer) throw new FinancialImportError("A transferência escolhida não foi encontrada.", 404);
  if (transfer.taken) {
    throw new FinancialImportError("Esta transferência já foi conciliada nesta carteira.", 409);
  }
  if (signedAmount === null || toCents(transfer.amount) !== (outgoing ? -toCents(signedAmount) : toCents(signedAmount))) {
    throw new FinancialImportError("O valor da movimentação não corresponde ao da transferência escolhida.", 409);
  }
  return transfer.counterpart_wallet_id;
}

// Turns each reconciled line into a transfer: it either completes the side missing from a transfer
// that already exists or creates the transfer with the wallet the user chose. Nothing becomes an
// income or an expense, so the wallets' cash balances move without touching their totals.
export async function importWalletTransfers(
  executor: QueryExecutor,
  walletId: string,
  userId: string,
  importId: string,
  items: Array<{
    id: string;
    type: string;
    amount: string;
    transaction_date: string | Date;
    description: string | null;
    signed_amount: string;
    credit_card_statement_id: string | null;
    wallet_transfer_id: string | null;
    transfer_counterpart_wallet_id: string | null;
  }>,
): Promise<void> {
  const transfers = items.filter((item) => item.type === "transfer" && !item.credit_card_statement_id);
  if (transfers.length === 0) return;
  // Existing transfers are locked in a stable order, so two confirmations cannot complete the same
  // side at once and cannot deadlock against each other.
  const pendingIds = [...new Set(transfers.flatMap((item) => item.wallet_transfer_id ? [item.wallet_transfer_id] : []))];
  if (pendingIds.length > 0) {
    await executor.query(
      `SELECT id FROM wallet_transfers WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE`,
      [pendingIds],
    );
  }
  for (const item of transfers) {
    if (!item.transfer_counterpart_wallet_id) {
      throw new FinancialImportError("Concilie as transferências antes de confirmar a importação.", 409);
    }
    const transferId = item.wallet_transfer_id ?? null;
    let resultingTransferId: string;
    if (transferId) {
      // Completing a side: the transfer already holds the money, so nothing is inserted.
      const sideTaken = await executor.query<{ taken: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM import_items
           WHERE resulting_wallet_transfer_id = $1 AND wallet_id = $2
         ) AS taken`,
        [transferId, walletId],
      );
      if (sideTaken.rows[0]?.taken) {
        throw new FinancialImportError("Esta transferência já foi conciliada nesta carteira.", 409);
      }
      resultingTransferId = transferId;
    } else {
      // The line's sign says which end its own wallet is: an outgoing line leaves this wallet, an
      // incoming one arrives in it. Getting this backwards would move the money the wrong way.
      const outgoing = isOutgoingTransfer(item.signed_amount);
      const fromWalletId = outgoing ? walletId : item.transfer_counterpart_wallet_id;
      const toWalletId = outgoing ? item.transfer_counterpart_wallet_id : walletId;
      const created = await executor.query<{ id: string }>(
        `INSERT INTO wallet_transfers (from_wallet_id, to_wallet_id, user_id, amount, date, description)
         VALUES ($1, $2, $3, $4::numeric, $5::date, $6)
         RETURNING id`,
        [fromWalletId, toWalletId, userId, item.amount, dateValue(item.transaction_date), item.description],
      );
      resultingTransferId = created.rows[0]!.id;
    }
    // The other wallet may have undone its import between reading the items and locking here, which
    // removes a transfer no side holds any more. The foreign key catches it, and the conflict is
    // reported as such instead of as an unexpected failure.
    const linked = await runWithTransferConflict(() => executor.query(
      `UPDATE import_items AS item
       SET validation_status = 'imported',
           resulting_wallet_transfer_id = $4,
           resulting_updated_at = (SELECT updated_at FROM wallet_transfers WHERE id = $4),
           error_message = NULL,
           is_repairable = false,
           updated_at = now()
       WHERE item.id = $1 AND item.import_session_id = $2 AND item.wallet_id = $3 AND item.validation_status = 'valid'`,
      [item.id, importId, walletId, resultingTransferId],
    ));
    if (linked.rowCount !== 1) {
      throw new FinancialImportError("Uma transferência foi alterada durante a confirmação.", 409);
    }
  }
}

const FOREIGN_KEY_VIOLATION = "23503";

async function runWithTransferConflict<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if ((error as { code?: string }).code === FOREIGN_KEY_VIOLATION) {
      throw new FinancialImportError("Uma transferência foi alterada durante a confirmação.", 409);
    }
    throw error;
  }
}

// Undoing an import releases its side of each transfer. A transfer whose other side is still
// reconciled keeps existing, because the money did move: only the side of this import goes away.
export async function undoWalletTransfers(
  executor: QueryExecutor,
  walletId: string,
  transferIds: string[],
): Promise<void> {
  if (transferIds.length === 0) return;
  await executor.query(
    `SELECT id FROM wallet_transfers WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE`,
    [transferIds],
  );
  // A transfer still reconciled with the other wallet's statement stays; one that only this import
  // held is removed with it.
  await executor.query(
    `DELETE FROM wallet_transfers AS transfer
     WHERE transfer.id = ANY($1::uuid[])
       AND NOT EXISTS (
         SELECT 1 FROM import_items AS reconciled
         WHERE reconciled.resulting_wallet_transfer_id = transfer.id
           AND reconciled.wallet_id <> $2
       )`,
    [transferIds, walletId],
  );
}
