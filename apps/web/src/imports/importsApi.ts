import { withActiveWallet } from '../wallets/walletApi'

export type FinancialImportFormat = 'ofx' | 'csv'
export type FinancialImportStatus = 'processing' | 'preview' | 'completed' | 'failed' | 'undone'
export type FinancialImportItemType = 'income' | 'expense' | 'transfer'
export type FinancialImportItemStatus = 'valid' | 'duplicate' | 'invalid' | 'uncategorized' | 'imported'

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
}

type FinancialImportListResponse = { items: FinancialImportSession[] }
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

  upload(file: File, format: FinancialImportFormat) {
    return request<FinancialImportSession>('/financial-imports', {
      method: 'POST',
      body: file,
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-File-Name': encodeURIComponent(file.name),
        'X-File-Format': format,
      },
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
}
