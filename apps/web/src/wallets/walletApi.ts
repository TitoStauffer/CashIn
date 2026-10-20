export type Wallet = {
  id: string
  name: string
  isPersonal: boolean
  role: 'owner' | 'member'
}

type WalletListResponse = { items: Wallet[] }
type ErrorResponse = { message?: string }

export class WalletApiError extends Error {
  readonly status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = 'WalletApiError'
    this.status = status
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`/api${path}`, {
    ...init,
    credentials: 'include',
    headers: {
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...init.headers,
    },
  })

  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as ErrorResponse | null
    throw new WalletApiError(body?.message ?? '', response.status)
  }

  if (response.status === 204) return undefined as T
  return (await response.json()) as T
}

export const walletApi = {
  list(signal?: AbortSignal) {
    return request<WalletListResponse>('/wallets', { signal })
  },
  create(name: string) {
    return request<Wallet>('/wallets', {
      method: 'POST',
      body: JSON.stringify({ name }),
    })
  },
}

export function getWalletStorageKey(userId: string) {
  return `saldocerto.active-wallet.${userId}`
}

export function getStoredWalletId(userId: string) {
  try {
    return window.localStorage.getItem(getWalletStorageKey(userId))
  } catch {
    return null
  }
}

export function storeWalletId(userId: string, walletId: string) {
  try {
    window.localStorage.setItem(getWalletStorageKey(userId), walletId)
  } catch {
    // Keep wallet selection usable when browser storage is unavailable.
  }
}

let activeWalletId: string | null = null

export function setRequestWalletId(walletId: string | null) {
  activeWalletId = walletId
}

export function withActiveWallet(init: RequestInit = {}): RequestInit {
  if (!activeWalletId) return init

  const headers = new Headers(init.headers)
  headers.set('X-Wallet-Id', activeWalletId)
  return {
    ...init,
    headers,
  }
}
