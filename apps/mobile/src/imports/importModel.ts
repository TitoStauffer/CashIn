import { formatAmount } from '../money/amount'
import { formatDate } from '../period/period'
import type {
  CounterpartWallet,
  ImportItem,
  ImportItemInput,
  ImportItemStatus,
  ImportItemType,
  ImportSession,
  ImportStatus,
  StatementCandidate,
  TransferCandidate,
} from './importApi'

// Labels and pure rules of the import screens, ported from the Web's `importsModel.ts` so both clients
// describe a preview the same way.

export const DISCARDED_MESSAGE = 'Importação descartada pelo usuário.'

const STATUS_LABELS: Record<ImportStatus, string> = {
  processing: 'Processando',
  preview: 'Aguardando confirmação',
  confirming: 'Confirmando',
  completed: 'Concluída',
  failed: 'Falhou',
  undone: 'Desfeita',
}

export function sessionStatusLabel(session: Pick<ImportSession, 'status' | 'failureMessage'>): string {
  return session.status === 'failed' && session.failureMessage === DISCARDED_MESSAGE ? 'Descartada' : STATUS_LABELS[session.status]
}

export const ITEM_STATUS_LABELS: Record<ImportItemStatus, string> = {
  valid: 'Pronta para importar',
  duplicate: 'Duplicada',
  invalid: 'Inválida',
  uncategorized: 'Não categorizada',
  imported: 'Importada',
}

const BANK_TYPE_LABELS: Partial<Record<ImportItemType, string>> = { income: 'Entrada', expense: 'Saída', transfer: 'Transferência' }
// A card statement holds purchases, refunds and the payment of the previous statement.
const CARD_TYPE_LABELS: Partial<Record<ImportItemType, string>> = { expense: 'Compra', card_credit: 'Estorno/crédito na fatura', transfer: 'Pagamento da fatura' }

export function isCardSession(session: Pick<ImportSession, 'kind'>): boolean {
  return session.kind === 'credit_card_statement'
}

/** The types an item of this import may take, with their labels, in the order they are offered. */
export function typeOptions(session: Pick<ImportSession, 'kind'>): { value: ImportItemType; label: string }[] {
  const labels = isCardSession(session) ? CARD_TYPE_LABELS : BANK_TYPE_LABELS
  return (Object.keys(labels) as ImportItemType[]).map((value) => ({ value, label: labels[value] as string }))
}

export function typeLabel(session: Pick<ImportSession, 'kind'>, type: ImportItemType): string {
  return (isCardSession(session) ? CARD_TYPE_LABELS : BANK_TYPE_LABELS)[type] ?? type
}

/** Only incomes and expenses take a category; transfers and card credits never do. */
export function hasCategory(type: ImportItemType): boolean {
  return type === 'income' || type === 'expense'
}

/**
 * In a bank statement a transfer is either the payment of a card statement or one side of a transfer
 * between wallets, so it is the only type that asks to be reconciled.
 */
export function canReconcile(session: Pick<ImportSession, 'kind'>, type: ImportItemType): boolean {
  return !isCardSession(session) && type === 'transfer'
}

export function createDraft(item: ImportItem): ImportItemInput {
  return {
    date: item.date,
    description: item.description ?? '',
    type: item.type,
    categoryId: item.categoryId,
    subcategoryId: item.subcategoryId,
    statementClosingDate: item.statementClosingDate ?? null,
    creditCardStatementId: item.creditCardStatementId ?? null,
    transferCounterpartWalletId: item.transferCounterpartWalletId ?? null,
    walletTransferId: item.walletTransferId ?? null,
  }
}

/**
 * The draft after the type changed. A category belongs to a nature and a reconciliation to a transfer, so
 * neither survives a new type: what the API would refuse is cleared here instead of sent.
 */
export function withType(draft: ImportItemInput, type: ImportItemType): ImportItemInput {
  return {
    ...draft,
    type,
    categoryId: null,
    subcategoryId: null,
    creditCardStatementId: null,
    transferCounterpartWalletId: null,
    walletTransferId: null,
  }
}

/** A new date moves the item back to the statement its date calculates, as on the Web. */
export function withDate(draft: ImportItemInput, date: string): ImportItemInput {
  return { ...draft, date, statementClosingDate: null }
}

// --- Card statement cycles. Mirrors apps/api/src/credit-cards/billing-cycle.ts, as the Web does, so the
// preview offers exactly the statements the API accepts for an item: the previous, the calculated and the
// next one. ---

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate()
}

function dateForDay(year: number, month: number, day: number): string {
  const normalizedYear = year + Math.floor(month / 12)
  const normalizedMonth = ((month % 12) + 12) % 12
  const boundedDay = Math.min(day, daysInMonth(normalizedYear, normalizedMonth))
  return new Date(Date.UTC(normalizedYear, normalizedMonth, boundedDay)).toISOString().slice(0, 10)
}

function yearAndMonth(value: string): [number, number] {
  const [year = 0, month = 1] = value.split('-').map(Number)
  return [year, month - 1]
}

export function calculateClosingDate(purchaseDate: string, closingDay: number): string {
  const [year, month] = yearAndMonth(purchaseDate)
  const current = dateForDay(year, month, closingDay)
  return purchaseDate <= current ? current : dateForDay(year, month + 1, closingDay)
}

export function adjacentClosingDates(purchaseDate: string, closingDay: number): string[] {
  const [year, month] = yearAndMonth(calculateClosingDate(purchaseDate, closingDay))
  return [dateForDay(year, month - 1, closingDay), dateForDay(year, month, closingDay), dateForDay(year, month + 1, closingDay)]
}

function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const date = new Date(`${value}T00:00:00.000Z`)
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
}

/**
 * The statement a card item lands on. A null `statementClosingDate` means "the one the date calculates".
 */
export function effectiveClosingDate(value: { date: string; statementClosingDate?: string | null }, closingDay: number | null): string | null {
  if (value.statementClosingDate) return value.statementClosingDate
  if (closingDay === null || !isIsoDate(value.date)) return null
  return calculateClosingDate(value.date, closingDay)
}

// --- Reconciliation of a bank statement transfer: a card statement, a pending transfer or a new transfer
// with another wallet, offered as one choice because the API takes exactly one of them. ---

export type ReconciliationOption = { value: string; label: string; changes: Partial<ImportItemInput> }

const CLEAR_RECONCILIATION = { creditCardStatementId: null, walletTransferId: null, transferCounterpartWalletId: null }

/**
 * The direction of a transfer line is not derivable here: the amount is absolute and the type is
 * `transfer`. The pending candidates carry the direction the API decided; without one, none is claimed.
 */
export function transferDirection(candidates: TransferCandidate[]): 'outgoing' | 'incoming' | null {
  const directions = new Set(candidates.map((candidate) => candidate.direction))
  return directions.size === 1 ? [...directions][0] ?? null : null
}

export function describeStatementCandidate(candidate: StatementCandidate): string {
  return `Fatura ${candidate.creditCardName} · vence ${formatDate(candidate.dueDate)} · falta ${formatAmount(candidate.outstandingAmount)}`
}

export function describeTransferCandidate(candidate: TransferCandidate): string {
  const direction = candidate.direction === 'outgoing' ? 'para' : 'de'
  // Without the name the candidate is still the right one: this wallet is one end of the transfer.
  const wallet = candidate.counterpartWalletName ?? 'outra carteira'
  return `Transferência ${direction} ${wallet} · ${formatDate(candidate.date)} · ${formatAmount(candidate.amount)}`
}

export function describeCounterpartWallet(wallet: CounterpartWallet, direction: 'outgoing' | 'incoming' | null): string {
  if (direction === 'outgoing') return `Nova transferência para ${wallet.walletName}`
  if (direction === 'incoming') return `Nova transferência de ${wallet.walletName}`
  return `Nova transferência com ${wallet.walletName}`
}

export function reconciliationOptions(item: ImportItem): ReconciliationOption[] {
  const transfers = item.transferCandidates ?? []
  const direction = transferDirection(transfers)
  return [
    ...(item.statementCandidates ?? []).map((candidate) => ({
      value: `statement:${candidate.statementId}`,
      label: describeStatementCandidate(candidate),
      changes: { ...CLEAR_RECONCILIATION, creditCardStatementId: candidate.statementId },
    })),
    ...transfers.map((candidate) => ({
      value: `transfer:${candidate.walletTransferId}`,
      label: describeTransferCandidate(candidate),
      changes: { ...CLEAR_RECONCILIATION, walletTransferId: candidate.walletTransferId, transferCounterpartWalletId: candidate.counterpartWalletId },
    })),
    ...(item.transferCounterpartWallets ?? []).map((wallet) => ({
      value: `wallet:${wallet.walletId}`,
      label: describeCounterpartWallet(wallet, direction),
      changes: { ...CLEAR_RECONCILIATION, transferCounterpartWalletId: wallet.walletId },
    })),
  ]
}

/** The option the draft holds, by the field the API reads: a statement, a pending transfer or a wallet. */
export function currentReconciliation(draft: ImportItemInput): string {
  if (draft.creditCardStatementId) return `statement:${draft.creditCardStatementId}`
  if (draft.walletTransferId) return `transfer:${draft.walletTransferId}`
  if (draft.transferCounterpartWalletId) return `wallet:${draft.transferCounterpartWalletId}`
  return ''
}

/** What to tell the person when the API offered nothing to reconcile this line with. */
export function describeMissingReconciliation(item: ImportItem): string {
  if (!item.canEdit) return 'Esta movimentação não tem conciliação disponível nesta prévia.'
  switch (item.reconciliationUnavailableReason) {
    case 'not_a_transfer':
      return 'Esta movimentação ainda está salva como ' + (item.type === 'income' ? 'entrada' : 'saída')
        + '. Salve o tipo Transferência para a prévia buscar faturas em aberto e carteiras para conciliar.'
    case 'card_payment':
      return 'A descrição aponta pagamento de fatura, e nenhuma fatura em aberto corresponde a ela. Ajuste a descrição, escolha outro tipo ou deixe-a fora da importação.'
    case null:
      return 'Nenhuma fatura em aberto e nenhuma outra carteira para conciliar esta movimentação. Escolha outro tipo ou deixe-a fora da importação.'
    default:
      return 'Esta movimentação não tem conciliação disponível nesta prévia. Salve o ajuste e revise, escolha outro tipo ou deixe-a fora da importação.'
  }
}

// --- History. ---

/** Who imported a file. The API sends the e-mail only when the reader may already know it. */
export function describeImporter(session: Pick<ImportSession, 'importedBy'>): string {
  if (session.importedBy.isCurrentUser) return 'importado por você'
  return session.importedBy.email ? `importado por ${session.importedBy.email}` : 'importado por outro membro da carteira'
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1).replace('.', ',')} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1).replace('.', ',')} MB`
}

/** The date part of an API timestamp, in the person's DD/MM/AAAA. */
export function formatTimestampDate(timestamp: string): string {
  return formatDate(timestamp.slice(0, 10))
}

/**
 * The accessible names of the history's open actions: file and date, plus the position in the list when
 * two imports still coincide in both (rule 23 of the vault).
 */
export function importNames(sessions: Pick<ImportSession, 'fileName' | 'createdAt'>[]): string[] {
  const base = sessions.map((session) => `importação de ${session.fileName} em ${formatTimestampDate(session.createdAt)}`)
  return base.map((name, index) => (base.indexOf(name) !== base.lastIndexOf(name) ? `${name}, ${index + 1}ª da lista` : name))
}

/**
 * The accessible names of the preview's item actions: date, amount and description, plus the line of the
 * file, which is unique in a session (rule 23 of the vault).
 */
export function itemName(item: ImportItem): string {
  return `movimentação ${item.sequence} de ${itemDate(item)}, ${formatAmount(item.amount)}${item.description ? ` (${item.description})` : ''}`
}

/** An invalid date in the file reaches the preview as an empty string, to be corrected by the person. */
export function itemDate(item: Pick<ImportItem, 'date'>): string {
  return item.date ? formatDate(item.date) : 'data inválida'
}
