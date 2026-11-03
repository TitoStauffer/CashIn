import { withActiveWallet } from '../wallets/walletApi'

export type FinancialImportFormat = 'ofx' | 'csv'
export type FinancialImportStatus = 'processing' | 'preview' | 'confirming' | 'completed' | 'failed' | 'undone'
export type FinancialImportItemType = 'income' | 'expense' | 'transfer'
export type FinancialImportItemStatus = 'valid' | 'duplicate' | 'invalid' | 'uncategorized' | 'imported'

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
}

export type FinancialImportSession = {
  id: string
  format: FinancialImportFormat
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
}

type FinancialImportListResponse = { items: FinancialImportSession[] }
type CsvMappingListResponse = { items: CsvMappingTemplate[] }
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

  get(importId: string, signal?: AbortSignal) {
    return request<FinancialImportSession>(importPath(importId), { signal })
  },

  upload(file: File, format: FinancialImportFormat, csvMapping?: CsvUploadMapping) {
    const csvHeaders: Record<string, string> = !csvMapping
      ? {}
      : 'mappingId' in csvMapping
        ? { 'X-Csv-Mapping-Id': csvMapping.mappingId }
        : { 'X-Csv-Mapping': encodeURIComponent(JSON.stringify(csvMapping.configuration)) }
    return request<FinancialImportSession>('/financial-imports', {
      method: 'POST',
      body: file,
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-File-Name': encodeURIComponent(file.name),
        'X-File-Format': format,
        ...csvHeaders,
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
