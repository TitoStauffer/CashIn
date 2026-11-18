import type { ApiClient } from '../api/client'

export type ImportStatus = 'processing' | 'preview' | 'confirming' | 'completed' | 'failed' | 'undone'
export type ImportKind = 'bank_statement' | 'credit_card_statement'
export type ImportItemType = 'income' | 'expense' | 'transfer' | 'card_credit'
export type ImportItemStatus = 'valid' | 'duplicate' | 'invalid' | 'uncategorized' | 'imported'

export type ImportSummary = { total: number; valid: number; duplicate: number; invalid: number; uncategorized: number; imported: number }

/** An open statement a bank payment may settle. */
export type StatementCandidate = {
  statementId: string
  creditCardId: string
  creditCardName: string
  closingDate: string
  dueDate: string
  outstandingAmount: string
}

/** A transfer between wallets whose side in this wallet is still pending. */
export type TransferCandidate = {
  walletTransferId: string
  counterpartWalletId: string
  /** Null when the person no longer reaches the wallet on the other end; the candidate still applies. */
  counterpartWalletName: string | null
  amount: string
  date: string
  description: string | null
  direction: 'outgoing' | 'incoming'
}

/** A wallet the person reaches, offered as the other end of a transfer. */
export type CounterpartWallet = { walletId: string; walletName: string; isPersonal: boolean }

export type ImportItem = {
  id: string
  sequence: number
  date: string
  description: string | null
  /** The absolute amount, as a decimal string; the type says the direction. */
  amount: string
  type: ImportItemType
  categoryId: string | null
  subcategoryId: string | null
  validationStatus: ImportItemStatus
  errorMessage: string | null
  canEdit: boolean
  canIncludeDuplicate?: boolean
  categorizationSource?: 'rule' | 'manual' | null
  statementClosingDate?: string | null
  statementDueDate?: string | null
  creditCardStatementId?: string | null
  statementCandidates?: StatementCandidate[]
  walletTransferId?: string | null
  transferCounterpartWalletId?: string | null
  transferCandidates?: TransferCandidate[]
  transferCounterpartWallets?: CounterpartWallet[]
  reconciliationUnavailableReason?: 'not_a_transfer' | 'card_payment' | null
}

/** A statement of a card import, computed by the API over the valid or imported items. */
export type ImportStatementPreview = {
  closingDate: string
  dueDate: string
  purchasesAmount: string
  creditsAmount: string
  totalAmount: string
  isPaid: boolean
}

export type ImportSession = {
  id: string
  importedBy: { userId: string; email: string | null; isCurrentUser: boolean }
  format: 'ofx' | 'csv'
  kind?: ImportKind
  creditCardId?: string | null
  creditCardName?: string | null
  creditCardClosingDay?: number | null
  creditCardDueDay?: number | null
  statements?: ImportStatementPreview[]
  fileName: string
  fileSize: number
  status: ImportStatus
  summary: ImportSummary
  items?: ImportItem[]
  canUndo: boolean
  undoBlockedReason: string | null
  failureMessage: string | null
  createdAt: string
  confirmedAt: string | null
}

export type ImportItemInput = {
  date: string
  description: string
  type: ImportItemType
  categoryId: string | null
  subcategoryId: string | null
  includeDuplicate?: boolean
  statementClosingDate?: string | null
  creditCardStatementId?: string | null
  transferCounterpartWalletId?: string | null
  walletTransferId?: string | null
}

/** A file chosen on the device: its name and its content, which this module never reads. */
export type ImportFile = { name: string; content: Blob }

export type CsvDelimiter = ',' | ';'
export type CsvEncoding = 'utf-8' | 'windows-1252' | 'iso-8859-1'
export type CsvDateFormat = 'dd/MM/yyyy' | 'MM/dd/yyyy' | 'yyyy-MM-dd'
export type CsvNumberFormat = 'pt-BR' | 'en-US'

/** Zero-based column indexes; exactly one money layout: `amount` alone, or `credit` and `debit`. */
export type CsvColumnMapping = {
  date: number
  description: number | null
  amount: number | null
  credit: number | null
  debit: number | null
  externalId: number | null
}

export type CsvConfiguration = {
  delimiter: CsvDelimiter
  encoding: CsvEncoding
  hasHeader: boolean
  dateFormat: CsvDateFormat
  numberFormat: CsvNumberFormat
  columns: CsvColumnMapping
}

export type CsvInspection = {
  detectedConfiguration: Omit<CsvConfiguration, 'columns'>
  suggestedMapping: CsvColumnMapping
  columns: { index: number; label: string }[]
  sample: { lineNumber: number; values: string[] }[]
}

/** A reusable CSV layout of the wallet. */
export type CsvMappingTemplate = { id: string; name: string; configuration: CsvConfiguration; createdAt: string; updatedAt: string }

/** How a card statement CSV writes its purchases; OFX already says it, so it is sent only with a CSV. */
export type CardAmountSign = 'purchases_positive' | 'purchases_negative'

/** What an upload declares besides the file. A CSV goes with a saved model or an ad hoc layout, never both. */
export type UploadOptions =
  | { format: 'ofx'; creditCardId: string | null }
  | {
      format: 'csv'
      csvMapping: { mappingId: string } | { configuration: CsvConfiguration }
      card: { creditCardId: string; amountSign: CardAmountSign } | null
    }

const encodedJson = (value: unknown) => encodeURIComponent(JSON.stringify(value))

function uploadHeaders(file: ImportFile, options: UploadOptions): Record<string, string> {
  const headers: Record<string, string> = { 'X-File-Name': encodeURIComponent(file.name), 'X-File-Format': options.format }
  if (options.format === 'ofx') {
    if (options.creditCardId) headers['X-Credit-Card-Id'] = options.creditCardId
    return headers
  }
  if ('mappingId' in options.csvMapping) headers['X-Csv-Mapping-Id'] = options.csvMapping.mappingId
  else headers['X-Csv-Mapping'] = encodedJson(options.csvMapping.configuration)
  if (options.card) {
    headers['X-Credit-Card-Id'] = options.card.creditCardId
    headers['X-Card-Amount-Sign'] = options.card.amountSign
  }
  return headers
}

/** An upload of up to 10 MB on a phone connection takes longer than an ordinary request. */
export const UPLOAD_TIMEOUT_MS = 120_000

/**
 * The import routes of `docs/financial-imports-contract.md`, in the active wallet. The file goes as is,
 * in `application/octet-stream`, with its name encoded in `X-File-Name`; a card statement names the card
 * in `X-Credit-Card-Id`, and a card CSV says how it writes purchases in `X-Card-Amount-Sign`. A CSV layout
 * goes encoded in `X-Csv-Mapping`, or a saved model in `X-Csv-Mapping-Id`. Size, format and content are
 * checked by the API, whose message is shown.
 */
export function createImportApi(request: ApiClient) {
  const session = (importId: string) => `/financial-imports/${encodeURIComponent(importId)}`
  return {
    list: () => request<{ items: ImportSession[] }>('/financial-imports'),
    get: (importId: string) => request<ImportSession>(session(importId)),
    upload: (file: ImportFile, options: UploadOptions) =>
      request<ImportSession>('/financial-imports', {
        method: 'POST',
        rawBody: file.content,
        timeoutMs: UPLOAD_TIMEOUT_MS,
        headers: uploadHeaders(file, options),
      }),
    /** Reads a CSV in the API's memory; with a layout, recomputes columns and sample from its five formats. */
    inspectCsv: (file: ImportFile, configuration?: CsvConfiguration) =>
      request<CsvInspection>('/financial-imports/csv/inspect', {
        method: 'POST',
        rawBody: file.content,
        timeoutMs: UPLOAD_TIMEOUT_MS,
        headers: {
          'X-File-Name': encodeURIComponent(file.name),
          ...(configuration ? { 'X-Csv-Mapping': encodedJson(configuration) } : {}),
        },
      }),
    listCsvMappings: () => request<{ items: CsvMappingTemplate[] }>('/financial-imports/csv-mappings'),
    createCsvMapping: (name: string, configuration: CsvConfiguration) =>
      request<CsvMappingTemplate>('/financial-imports/csv-mappings', { method: 'POST', body: { name, configuration } }),
    updateCsvMapping: (mappingId: string, name: string, configuration: CsvConfiguration) =>
      request<CsvMappingTemplate>(`/financial-imports/csv-mappings/${encodeURIComponent(mappingId)}`, { method: 'PATCH', body: { name, configuration } }),
    updateItem: (importId: string, itemId: string, input: ImportItemInput) =>
      request<ImportItem>(`${session(importId)}/items/${encodeURIComponent(itemId)}`, { method: 'PATCH', body: input }),
    confirm: (importId: string) => request<ImportSession>(`${session(importId)}/confirm`, { method: 'POST' }),
    undo: (importId: string) => request<ImportSession>(`${session(importId)}/undo`, { method: 'POST' }),
    discard: (importId: string) => request<ImportSession>(session(importId), { method: 'DELETE' }),
  }
}

export type ImportApi = ReturnType<typeof createImportApi>
