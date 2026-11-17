import type { ApiClient } from '../api/client'

export type User = { id: string; email: string }

/** What `POST /auth/token` answers (DEV-140): the session token travels in the body for native clients. */
export type TokenSession = { user: User; token: string; expiresAt: string }

/**
 * The account routes of the API, as the app uses them. None of them is scoped to a wallet: signing up,
 * signing in and reading the session happen before or regardless of any wallet choice. The contract is
 * in `docs/api.md`, section "Sessão: cookie na Web, token nos clientes nativos".
 */
export function createAuthApi(request: ApiClient) {
  return {
    register(email: string, password: string) {
      return request<{ message: string }>('/auth/register', { method: 'POST', body: { email, password }, scopeToActiveWallet: false })
    },
    login(email: string, password: string) {
      return request<TokenSession>('/auth/token', { method: 'POST', body: { email, password }, scopeToActiveWallet: false })
    },
    me() {
      return request<{ user: User }>('/auth/me', { scopeToActiveWallet: false })
    },
    logout() {
      return request<void>('/auth/logout', { method: 'POST', scopeToActiveWallet: false, reportUnauthorized: false })
    },
  }
}

export type AuthApi = ReturnType<typeof createAuthApi>
