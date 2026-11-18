import type { ApiClient } from '../api/client'

export type Wallet = { id: string; name: string; isPersonal: boolean; role: 'owner' | 'member' }
export type WalletInvitation = {
  id: string
  email: string
  status: 'pending' | 'expired' | 'cancelled' | 'accepted'
  expiresAt: string
  createdAt: string
}
/** `id` is the member's user id: it is what `DELETE /wallets/:walletId/members/:userId` takes. */
export type WalletMember = { id: string; email: string; role: 'owner' | 'member'; createdAt: string }
export type WalletAccessRequest = {
  id: string
  email: string
  status: 'pending' | 'approved' | 'rejected' | 'cancelled' | 'expired' | 'accepted'
  createdAt: string
}
export type WalletAccessLink = { id: string; url: string; expiresAt: string }

const path = (walletId: string, ...rest: string[]) =>
  ['/wallets', walletId, ...rest].map((segment, index) => (index === 0 ? segment : encodeURIComponent(segment))).join('/')

/**
 * The wallet routes of `docs/api.md`. None carries `X-Wallet-Id`: listing and choosing wallets cannot be
 * scoped by the wallet being chosen, and the sharing routes name their wallet in the path. Sharing is
 * the owner's: for anyone else the API answers 404, so the app hiding the actions is convenience, never
 * the guard.
 */
export function createWalletApi(request: ApiClient) {
  const unscoped = { scopeToActiveWallet: false } as const
  return {
    list: () => request<{ items: Wallet[] }>('/wallets', unscoped),
    create: (name: string) => request<Wallet>('/wallets', { ...unscoped, method: 'POST', body: { name } }),

    listMembers: (walletId: string) => request<{ items: WalletMember[] }>(path(walletId, 'members'), unscoped),
    removeMember: (walletId: string, userId: string) => request<void>(path(walletId, 'members', userId), { ...unscoped, method: 'DELETE' }),

    listInvitations: (walletId: string) => request<{ items: WalletInvitation[] }>(path(walletId, 'invites'), unscoped),
    invite: (walletId: string, email: string) =>
      request<{ invitation: WalletInvitation; message: string }>(path(walletId, 'invites'), { ...unscoped, method: 'POST', body: { email } }),
    cancelInvitation: (walletId: string, invitationId: string) =>
      request<void>(path(walletId, 'invites', invitationId), { ...unscoped, method: 'DELETE' }),

    createAccessLink: (walletId: string) => request<{ link: WalletAccessLink }>(path(walletId, 'access-links'), { ...unscoped, method: 'POST' }),
    listAccessRequests: (walletId: string) => request<{ items: WalletAccessRequest[] }>(path(walletId, 'access-requests'), unscoped),
    approveAccessRequest: (walletId: string, requestId: string) =>
      request<{ message: string }>(path(walletId, 'access-requests', requestId, 'approve'), { ...unscoped, method: 'POST' }),
    rejectAccessRequest: (walletId: string, requestId: string) =>
      request<{ message: string }>(path(walletId, 'access-requests', requestId, 'reject'), { ...unscoped, method: 'POST' }),
    cancelAccessRequest: (walletId: string, requestId: string) =>
      request<void>(path(walletId, 'access-requests', requestId), { ...unscoped, method: 'DELETE' }),
  }
}

export type WalletApi = ReturnType<typeof createWalletApi>
