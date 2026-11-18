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

/** An upload of up to 10 MB on a phone connection takes longer than an ordinary request. */
export const UPLOAD_TIMEOUT_MS = 120_000

/**
 * The OFX import routes of `docs/financial-imports-contract.md`, in the active wallet. The file goes as
 * is, in `application/octet-stream`, with its name encoded in `X-File-Name`; a card statement names the
 * card in `X-Credit-Card-Id`. Size, format and content are checked by the API, whose message is shown.
 */
export function createImportApi(request: ApiClient) {
  const session = (importId: string) => `/financial-imports/${encodeURIComponent(importId)}`
  return {
    list: () => request<{ items: ImportSession[] }>('/financial-imports'),
    get: (importId: string) => request<ImportSession>(session(importId)),
    upload: (file: ImportFile, creditCardId: string | null) =>
      request<ImportSession>('/financial-imports', {
        method: 'POST',
        rawBody: file.content,
        timeoutMs: UPLOAD_TIMEOUT_MS,
        headers: {
          'X-File-Name': encodeURIComponent(file.name),
          'X-File-Format': 'ofx',
          ...(creditCardId ? { 'X-Credit-Card-Id': creditCardId } : {}),
        },
      }),
    updateItem: (importId: string, itemId: string, input: ImportItemInput) =>
      request<ImportItem>(`${session(importId)}/items/${encodeURIComponent(itemId)}`, { method: 'PATCH', body: input }),
    confirm: (importId: string) => request<ImportSession>(`${session(importId)}/confirm`, { method: 'POST' }),
    undo: (importId: string) => request<ImportSession>(`${session(importId)}/undo`, { method: 'POST' }),
    discard: (importId: string) => request<ImportSession>(session(importId), { method: 'DELETE' }),
  }
}

export type ImportApi = ReturnType<typeof createImportApi>
