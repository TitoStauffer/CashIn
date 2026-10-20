export type Wallet = {
  id: string
  name: string
  isPersonal: boolean
  role: 'owner' | 'member'
}

type WalletListResponse = { items: Wallet[] }
export type WalletInvitationStatus = 'pending' | 'expired' | 'cancelled' | 'accepted'
export type WalletInvitation = {
  id: string
  email: string
  status: WalletInvitationStatus
  expiresAt: string
  createdAt: string
}
export type WalletMember = {
  id: string
  email: string
  role: 'owner' | 'member'
  createdAt: string
}
type WalletInvitationListResponse = { items: WalletInvitation[] }
type WalletMemberListResponse = { items: WalletMember[] }
type WalletInvitationCreateResponse = { invitation: WalletInvitation; message?: string }
type WalletInvitationAcceptResponse = { wallet: Wallet; message?: string }
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
  listInvitations(walletId: string, signal?: AbortSignal) {
    return request<WalletInvitationListResponse>(`/wallets/${encodeURIComponent(walletId)}/invites`, { signal })
  },
  createInvitation(walletId: string, email: string) {
    return request<WalletInvitationCreateResponse>(`/wallets/${encodeURIComponent(walletId)}/invites`, {
      method: 'POST',
      body: JSON.stringify({ email }),
    })
  },
  cancelInvitation(walletId: string, invitationId: string) {
    return request<void>(`/wallets/${encodeURIComponent(walletId)}/invites/${encodeURIComponent(invitationId)}`, {
      method: 'DELETE',
    })
  },
  listMembers(walletId: string, signal?: AbortSignal) {
    return request<WalletMemberListResponse>(`/wallets/${encodeURIComponent(walletId)}/members`, { signal })
  },
  removeMember(walletId: string, memberId: string) {
    return request<void>(`/wallets/${encodeURIComponent(walletId)}/members/${encodeURIComponent(memberId)}`, {
      method: 'DELETE',
    })
  },
  acceptInvitation(token: string) {
    return request<WalletInvitationAcceptResponse>('/wallet-invitations/accept', {
      method: 'POST',
      body: JSON.stringify({ token }),
    })
  },
}

const pendingInviteStorageKey = 'saldocerto.pending-wallet-invite'

export function getPendingInviteToken() {
  try {
    return window.sessionStorage.getItem(pendingInviteStorageKey)
  } catch {
    return null
  }
}

export function storePendingInviteToken(token: string | null) {
  try {
    if (token) window.sessionStorage.setItem(pendingInviteStorageKey, token)
    else window.sessionStorage.removeItem(pendingInviteStorageKey)
  } catch {
    // Keep the invite flow usable when session storage is unavailable.
  }
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
