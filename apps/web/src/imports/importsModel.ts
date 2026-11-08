import { formatBrazilianCurrency } from '../money/currency'
import type {
  BankPaymentCandidate,
  CsvImportConfiguration,
  TransferCounterpartWallet,
  WalletTransferCandidate,
  FinancialImportItem,
  FinancialImportItemInput,
  FinancialImportItemStatus,
  FinancialImportItemType,
  FinancialImportSession,
  FinancialImportStatus,
} from './importsApi'

// Labels and pure helpers shared by the import page and its components.

export function isCsvConfigurationValid(configuration: CsvImportConfiguration | null, columns: Array<{ index: number }>) {
  if (!configuration) return false
  const availableIndexes = new Set(columns.map((column) => column.index))
  const mappedIndexes = Object.values(configuration.columns).filter((index): index is number => index !== null)
  const usesAmount = Number.isInteger(configuration.columns.amount)
  const usesCreditAndDebit = Number.isInteger(configuration.columns.credit) && Number.isInteger(configuration.columns.debit)
  const usesOnlyAmount = usesAmount && configuration.columns.credit === null && configuration.columns.debit === null
  const usesOnlyCreditAndDebit = !usesAmount && usesCreditAndDebit
  return mappedIndexes.every((index) => availableIndexes.has(index))
    && new Set(mappedIndexes).size === mappedIndexes.length
    && Number.isInteger(configuration.columns.date)
    && (usesOnlyAmount || usesOnlyCreditAndDebit)
}

export const statusLabels: Record<FinancialImportStatus, string> = {
  processing: 'Processando',
  preview: 'Aguardando confirmação',
  confirming: 'Confirmando',
  completed: 'Concluída',
  failed: 'Falhou',
  undone: 'Desfeita',
}

export const busyImportStatuses = new Set<FinancialImportStatus>(['processing', 'confirming'])

export const importItemsPerPage = 100

export const maxAutomaticPollFailures = 3

export function isImportBusy(status: FinancialImportStatus) {
  return busyImportStatuses.has(status)
}

export function getSessionStatusLabel(session: FinancialImportSession) {
  return session.status === 'failed' && session.failureMessage === 'Importação descartada pelo usuário.'
    ? 'Descartada'
    : statusLabels[session.status]
}

export const itemStatusLabels: Record<FinancialImportItemStatus, string> = {
  valid: 'Pronta para importar',
  duplicate: 'Duplicada',
  invalid: 'Inválida',
  uncategorized: 'Não categorizada',
  imported: 'Importada',
}

export const typeLabels: Record<FinancialImportItemType, string> = {
  income: 'Entrada',
  expense: 'Saída',
  transfer: 'Transferência',
  card_credit: 'Estorno/crédito na fatura',
}

// A card statement holds purchases, refunds/chargebacks and the payment of the previous statement.
export const cardTypeLabels: Partial<Record<FinancialImportItemType, string>> = {
  expense: 'Compra',
  card_credit: 'Estorno/crédito na fatura',
  transfer: 'Pagamento da fatura',
}

export const bankTypeOptions: FinancialImportItemType[] = ['income', 'expense', 'transfer']

export const cardTypeOptions: FinancialImportItemType[] = ['expense', 'card_credit', 'transfer']

export function isCardSession(session: FinancialImportSession) {
  return session.kind === 'credit_card_statement'
}

// In a bank statement a transfer is either the payment of a card statement or one side of a transfer
// between two wallets, so it is the only type that asks to be reconciled — and with exactly one of
// the two.
export function canReconcileStatement(session: FinancialImportSession, type: FinancialImportItemType) {
  return !isCardSession(session) && type === 'transfer'
}

// The two reconciliations are mutually exclusive, so the preview offers them as one choice. The
// value carries which kind was picked, because the API takes a different field for each.
export type ReconciliationChoice =
  | { kind: 'none' }
  | { kind: 'statement'; statementId: string }
  | { kind: 'transfer'; walletTransferId: string; counterpartWalletId: string }
  | { kind: 'wallet'; counterpartWalletId: string }

export function reconciliationChoiceValue(choice: ReconciliationChoice) {
  switch (choice.kind) {
    case 'statement': return `statement:${choice.statementId}`
    case 'transfer': return `transfer:${choice.walletTransferId}`
    case 'wallet': return `wallet:${choice.counterpartWalletId}`
    default: return ''
  }
}

export function currentReconciliationChoice(draft: FinancialImportItemInput): ReconciliationChoice {
  if (draft.creditCardStatementId) return { kind: 'statement', statementId: draft.creditCardStatementId }
  if (draft.walletTransferId && draft.transferCounterpartWalletId) {
    return { kind: 'transfer', walletTransferId: draft.walletTransferId, counterpartWalletId: draft.transferCounterpartWalletId }
  }
  if (draft.transferCounterpartWalletId) return { kind: 'wallet', counterpartWalletId: draft.transferCounterpartWalletId }
  return { kind: 'none' }
}

// Picking one reconciliation always clears the other, which is what the API requires.
export function reconciliationChoiceDraft(
  value: string,
  candidates: WalletTransferCandidate[],
  currentCounterpartWalletId: string | null = null,
): Partial<FinancialImportItemInput> {
  const [kind, id] = value.split(':')
  if (kind === 'statement' && id) {
    return { creditCardStatementId: id, transferCounterpartWalletId: null, walletTransferId: null }
  }
  if (kind === 'transfer' && id) {
    // The chosen transfer may no longer be among the candidates — that is exactly when the "chosen
    // earlier" option is shown — so the wallet already in the draft is kept instead of being cleared,
    // which would silently drop the choice.
    const candidate = candidates.find((option) => option.walletTransferId === id)
    return {
      creditCardStatementId: null,
      walletTransferId: id,
      transferCounterpartWalletId: candidate?.counterpartWalletId ?? currentCounterpartWalletId,
    }
  }
  if (kind === 'wallet' && id) {
    return { creditCardStatementId: null, walletTransferId: null, transferCounterpartWalletId: id }
  }
  return { creditCardStatementId: null, walletTransferId: null, transferCounterpartWalletId: null }
}

export function describeTransferCandidate(candidate: WalletTransferCandidate) {
  const direction = candidate.direction === 'outgoing' ? 'para' : 'de'
  return `${direction} ${candidate.counterpartWalletName} · ${formatIsoDate(candidate.date)} · ${formatBrazilianCurrency(candidate.amount)}`
}

// The direction of a line is not derivable on the client: the API exposes `amount` as an absolute
// value and the line is already stored as `transfer`, so neither the sign nor the type tells an
// outgoing line from an incoming one. The pending candidates carry the direction decided by the API,
// which is the only authoritative source here; without any candidate the label states no direction
// instead of guessing one.
export function transferDirection(candidates: WalletTransferCandidate[]): 'outgoing' | 'incoming' | null {
  const directions = new Set(candidates.map((candidate) => candidate.direction))
  return directions.size === 1 ? [...directions][0]! : null
}

export function counterpartWalletsLabel(direction: 'outgoing' | 'incoming' | null) {
  if (direction === 'outgoing') return 'Transferir para a carteira'
  if (direction === 'incoming') return 'Receber da carteira'
  return 'Carteira do outro lado'
}

export function describeCounterpartWallet(wallet: TransferCounterpartWallet, direction: 'outgoing' | 'incoming' | null) {
  if (direction === 'outgoing') return `para ${wallet.walletName}`
  if (direction === 'incoming') return `de ${wallet.walletName}`
  return wallet.walletName
}

export function hasCategory(type: FinancialImportItemType) {
  return type === 'income' || type === 'expense'
}

export function formatIsoDate(value: string) {
  const [year, month, day] = value.split('-')
  return `${day}/${month}/${year}`
}

export function canLearnRuleFromItem(item: FinancialImportItem, draft: FinancialImportItemInput | undefined) {
  return item.categorizationSource === 'manual'
    && hasCategory(item.type)
    && Boolean(item.categoryId)
    && !hasDraftChanged(item, draft)
}

export function formatFileSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1).replace('.', ',')} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1).replace('.', ',')} MB`
}

export function createDraft(item: FinancialImportItem): FinancialImportItemInput {
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

export function hasDraftChanged(item: FinancialImportItem, draft: FinancialImportItemInput | undefined) {
  if (!draft) return false
  const original = createDraft(item)
  return original.date !== draft.date
    || original.description !== draft.description
    || original.type !== draft.type
    || original.categoryId !== draft.categoryId
    || original.subcategoryId !== draft.subcategoryId
    || (original.statementClosingDate ?? null) !== (draft.statementClosingDate ?? null)
    || (original.creditCardStatementId ?? null) !== (draft.creditCardStatementId ?? null)
    || (original.transferCounterpartWalletId ?? null) !== (draft.transferCounterpartWalletId ?? null)
    || (original.walletTransferId ?? null) !== (draft.walletTransferId ?? null)
}

export function describeStatementCandidate(candidate: BankPaymentCandidate) {
  return `${candidate.creditCardName} · vence ${formatIsoDate(candidate.dueDate)} · falta ${formatBrazilianCurrency(candidate.outstandingAmount)}`
}

// Who imported a file, for the wallet's history. The API only sends the e-mail when the reader may
// already know it — their own imports, and, for the wallet's owner, everyone else's — so an import
// by another member is named by the e-mail when it comes and acknowledged as someone else's when it
// does not. Never "desconhecido": the import has an owner either way.
export function describeImporter(session: FinancialImportSession): string {
  if (session.importedBy.isCurrentUser) return 'importado por você'
  return session.importedBy.email
    ? `importado por ${session.importedBy.email}`
    : 'importado por outro membro da carteira'
}
