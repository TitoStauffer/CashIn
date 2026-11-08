import { withActiveWallet } from '../wallets/walletApi'

export type FinancialImportFormat = 'ofx' | 'csv'
export type FinancialImportStatus = 'processing' | 'preview' | 'confirming' | 'completed' | 'failed' | 'undone'
export type FinancialImportItemType = 'income' | 'expense' | 'transfer' | 'card_credit'
export type FinancialImportKind = 'bank_statement' | 'credit_card_statement'
export type CardAmountSign = 'purchases_negative' | 'purchases_positive'
export type CardStatementUpload = { creditCardId: string; amountSign?: CardAmountSign }
export type FinancialImportItemStatus = 'valid' | 'duplicate' | 'invalid' | 'uncategorized' | 'imported'
export type FinancialCategorizationRuleType = 'income' | 'expense'

export type CsvDelimiter = ',' | ';'
export type CsvEncoding = 'utf-8' | 'windows-1252' | 'iso-8859-1'
export type CsvDateFormat = 'dd/MM/yyyy' | 'MM/dd/yyyy' | 'yyyy-MM-dd'
export type CsvNumberFormat = 'pt-BR' | 'en-US'

export type CsvColumnMapping = {
  date: number
  description: number | null
  amount: number | null
  credit: number | null
  debit: number | null
  externalId: number | null
}

export type CsvImportConfiguration = {
  delimiter: CsvDelimiter
  encoding: CsvEncoding
  hasHeader: boolean
  dateFormat: CsvDateFormat
  numberFormat: CsvNumberFormat
  columns: CsvColumnMapping
}

export type CsvInspection = {
  detectedConfiguration: Omit<CsvImportConfiguration, 'columns'>
  suggestedMapping: CsvColumnMapping
  columns: Array<{ index: number; label: string }>
  sample: Array<{ lineNumber: number; values: string[] }>
}

export type CsvMappingTemplate = {
  id: string
  name: string
  configuration: CsvImportConfiguration
  createdAt: string
  updatedAt: string
}

export type CsvUploadMapping =
  | { mappingId: string }
  | { configuration: CsvImportConfiguration }

export type FinancialImportSummary = {
  total: number
  valid: number
  duplicate: number
  invalid: number
  uncategorized: number
  imported: number
}

export type FinancialImportItem = {
  id: string
  sequence: number
  date: string
  description: string | null
  amount: string
  type: FinancialImportItemType
  categoryId: string | null
  subcategoryId: string | null
  validationStatus: FinancialImportItemStatus
  errorMessage: string | null
  canEdit: boolean
  canIncludeDuplicate?: boolean
  categorizationSource?: 'rule' | 'manual' | null
  statementClosingDate?: string | null
  statementDueDate?: string | null
  // Bank statement imports only: the statement this payment settles, and the open statements it
  // could settle. An ambiguous match is never reconciled automatically.
  creditCardStatementId?: string | null
  statementCandidates?: BankPaymentCandidate[]
  // Bank statement imports only: the transfer between wallets this line is one side of, the wallet on
  // the other end, the pending transfers it could complete and the wallets it could be paired with.
  walletTransferId?: string | null
  transferCounterpartWalletId?: string | null
  transferCandidates?: WalletTransferCandidate[]
  transferCounterpartWallets?: TransferCounterpartWallet[]
}

// An open statement a bank payment may be reconciled with.
export type BankPaymentCandidate = {
  statementId: string
  creditCardId: string
  creditCardName: string
  closingDate: string
  dueDate: string
  outstandingAmount: string
}

// A transfer between wallets whose side in this wallet has not been reconciled yet.
export type WalletTransferCandidate = {
  walletTransferId: string
  counterpartWalletId: string
  counterpartWalletName: string
  amount: string
  date: string
  description: string | null
  direction: 'outgoing' | 'incoming'
}

// A wallet the user can reach, offered as the other end of a transfer.
export type TransferCounterpartWallet = {
  walletId: string
  walletName: string
  isPersonal: boolean
}

export type FinancialImportStatementPreview = {
  closingDate: string
  dueDate: string
  purchasesAmount: string
  creditsAmount: string
  totalAmount: string
  isPaid: boolean
}

export type FinancialCategorizationRule = {
  id: string
  type: FinancialCategorizationRuleType
  description: string
  categoryId: string
  categoryName: string | null
  subcategoryId: string | null
  subcategoryName: string | null
  isActive: boolean
  isStale: boolean
  createdAt: string
  updatedAt: string
}

export type FinancialCategorizationRuleInput = {
  type: FinancialCategorizationRuleType
  description: string
  categoryId: string
  subcategoryId?: string | null
  isActive?: boolean
}

// Who imported a file. The e-mail only comes for the viewer's own imports and, for the wallet's
// owner, for everyone else's — the owner is the only member who may list the wallet's members.
export type FinancialImportImporter = {
  userId: string
  email: string | null
  isCurrentUser: boolean
}

export type FinancialImportSession = {
  id: string
  importedBy: FinancialImportImporter
  format: FinancialImportFormat
  kind?: FinancialImportKind
  creditCardId?: string | null
  creditCardName?: string | null
  creditCardClosingDay?: number | null
  creditCardDueDay?: number | null
  statements?: FinancialImportStatementPreview[]
  fileName: string
  fileSize: number
  status: FinancialImportStatus
  summary: FinancialImportSummary
  items?: FinancialImportItem[]
  canUndo: boolean
  undoBlockedReason: string | null
  failureMessage: string | null
  createdAt: string
  confirmedAt: string | null
  completedAt?: string | null
  undoneAt?: string | null
}

export type FinancialImportItemInput = {
  date: string
  description: string
  type: FinancialImportItemType
  categoryId: string | null
  subcategoryId: string | null
  includeDuplicate?: boolean
  statementClosingDate?: string | null
  creditCardStatementId?: string | null
  transferCounterpartWalletId?: string | null
  walletTransferId?: string | null
}

type FinancialImportListResponse = { items: FinancialImportSession[] }
type CsvMappingListResponse = { items: CsvMappingTemplate[] }
type CategorizationRuleListResponse = { items: FinancialCategorizationRule[] }
type ErrorResponse = { message?: string }

export class FinancialImportApiError extends Error {
  readonly status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = 'FinancialImportApiError'
    this.status = status
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`/api${path}`, withActiveWallet({
    ...init,
    credentials: 'include',
    headers: {
      ...(typeof init.body === 'string' ? { 'Content-Type': 'application/json' } : {}),
      ...init.headers,
    },
  }))

  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as ErrorResponse | null
    throw new FinancialImportApiError(body?.message ?? '', response.status)
  }

  if (response.status === 204) return undefined as T
  return (await response.json()) as T
}

function importPath(importId: string) {
  return `/financial-imports/${encodeURIComponent(importId)}`
}

export const importsApi = {
  list(signal?: AbortSignal) {
    return request<FinancialImportListResponse>('/financial-imports', { signal })
  },

  listCategorizationRules(signal?: AbortSignal) {
    return request<CategorizationRuleListResponse>('/financial-imports/rules', { signal })
  },

  createCategorizationRule(input: FinancialCategorizationRuleInput) {
    return request<FinancialCategorizationRule>('/financial-imports/rules', { method: 'POST', body: JSON.stringify(input) })
  },

  updateCategorizationRule(ruleId: string, input: FinancialCategorizationRuleInput) {
    return request<FinancialCategorizationRule>(`/financial-imports/rules/${encodeURIComponent(ruleId)}`, { method: 'PATCH', body: JSON.stringify(input) })
  },

  deleteCategorizationRule(ruleId: string) {
    return request<void>(`/financial-imports/rules/${encodeURIComponent(ruleId)}`, { method: 'DELETE' })
  },

  get(importId: string, signal?: AbortSignal) {
    return request<FinancialImportSession>(importPath(importId), { signal })
  },

  upload(file: File, format: FinancialImportFormat, csvMapping?: CsvUploadMapping, card?: CardStatementUpload) {
    const csvHeaders: Record<string, string> = !csvMapping
      ? {}
      : 'mappingId' in csvMapping
        ? { 'X-Csv-Mapping-Id': csvMapping.mappingId }
        : { 'X-Csv-Mapping': encodeURIComponent(JSON.stringify(csvMapping.configuration)) }
    const cardHeaders: Record<string, string> = !card
      ? {}
      : {
          'X-Credit-Card-Id': card.creditCardId,
          ...(card.amountSign ? { 'X-Card-Amount-Sign': card.amountSign } : {}),
        }
    return request<FinancialImportSession>('/financial-imports', {
      method: 'POST',
      body: file,
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-File-Name': encodeURIComponent(file.name),
        'X-File-Format': format,
        ...csvHeaders,
        ...cardHeaders,
      },
    })
  },

  inspectCsv(file: File, signal?: AbortSignal, configuration?: CsvImportConfiguration) {
    return request<CsvInspection>('/financial-imports/csv/inspect', {
      method: 'POST',
      body: file,
      signal,
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-File-Name': encodeURIComponent(file.name),
        ...(configuration ? { 'X-Csv-Mapping': encodeURIComponent(JSON.stringify(configuration)) } : {}),
      },
    })
  },

  listCsvMappings(signal?: AbortSignal) {
    return request<CsvMappingListResponse>('/financial-imports/csv-mappings', { signal })
  },

  createCsvMapping(name: string, configuration: CsvImportConfiguration) {
    return request<CsvMappingTemplate>('/financial-imports/csv-mappings', {
      method: 'POST',
      body: JSON.stringify({ name, configuration }),
    })
  },

  updateCsvMapping(mappingId: string, name: string, configuration: CsvImportConfiguration) {
    return request<CsvMappingTemplate>(`/financial-imports/csv-mappings/${encodeURIComponent(mappingId)}`, {
      method: 'PATCH',
      body: JSON.stringify({ name, configuration }),
    })
  },

  updateItem(importId: string, itemId: string, input: FinancialImportItemInput) {
    return request<FinancialImportItem>(`${importPath(importId)}/items/${encodeURIComponent(itemId)}`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    })
  },

  confirm(importId: string) {
    return request<FinancialImportSession>(`${importPath(importId)}/confirm`, { method: 'POST' })
  },

  undo(importId: string) {
    return request<FinancialImportSession>(`${importPath(importId)}/undo`, { method: 'POST' })
  },

  discard(importId: string) {
    return request<FinancialImportSession>(importPath(importId), { method: 'DELETE' })
  },
}
