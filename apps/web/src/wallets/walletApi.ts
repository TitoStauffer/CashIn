import { createApiRequest } from '../api/request'

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
export type WalletAccessRequestStatus = 'pending' | 'approved' | 'rejected' | 'cancelled' | 'expired' | 'accepted'
export type WalletAccessRequest = {
  id: string
  email: string
  status: WalletAccessRequestStatus
  createdAt: string
  expiresAt?: string
  approvedAt?: string | null
  rejectedAt?: string | null
  cancelledAt?: string | null
}
export type WalletAccessLink = {
  id: string
  url: string
  expiresAt: string
}
type WalletInvitationListResponse = { items: WalletInvitation[] }
type WalletMemberListResponse = { items: WalletMember[] }
type WalletAccessRequestListResponse = { items: WalletAccessRequest[] }
type WalletInvitationCreateResponse = { invitation: WalletInvitation; message?: string }
type WalletInvitationAcceptResponse = { wallet: Wallet; message?: string }

export class WalletApiError extends Error {
  readonly status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = 'WalletApiError'
    this.status = status
  }
}

const request = createApiRequest(WalletApiError, { scopeToActiveWallet: false })

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
  createAccessLink(walletId: string) {
    return request<{ link: WalletAccessLink }>(`/wallets/${encodeURIComponent(walletId)}/access-links`, {
      method: 'POST',
    })
  },
  listAccessRequests(walletId: string, signal?: AbortSignal) {
    return request<WalletAccessRequestListResponse>(`/wallets/${encodeURIComponent(walletId)}/access-requests`, { signal })
  },
  submitAccessRequest(token: string, email: string) {
    return request<{ message?: string }>('/wallet-access-requests', {
      method: 'POST',
      body: JSON.stringify({ token, email }),
    })
  },
  decideAccessRequest(walletId: string, requestId: string, decision: 'approve' | 'reject') {
    return request<void>(`/wallets/${encodeURIComponent(walletId)}/access-requests/${encodeURIComponent(requestId)}/${decision}`, {
      method: 'POST',
    })
  },
  cancelAccessRequest(walletId: string, requestId: string) {
    return request<void>(`/wallets/${encodeURIComponent(walletId)}/access-requests/${encodeURIComponent(requestId)}`, {
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

// The active wallet lives in `api/activeWallet.ts` so that the shared HTTP client can read it without
// importing this module, which imports the client. Re-exported here because `WalletContext` and the
// tests have always taken it from this file.
export { setRequestWalletId, withActiveWallet } from '../api/activeWallet'
