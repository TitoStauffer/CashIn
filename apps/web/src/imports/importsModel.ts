import type {
  FinancialImportItem,
  FinancialImportItemInput,
  FinancialImportItemStatus,
  FinancialImportItemType,
  FinancialImportSession,
  FinancialImportStatus,
} from './importsApi'

// Labels and pure helpers shared by the import page and its preview.

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
}
