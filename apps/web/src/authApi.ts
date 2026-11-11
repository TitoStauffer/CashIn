import { createApiRequest } from './api/request'

export type User = {
  id: string
  email: string
}

type UserResponse = {
  user: User
}

type MessageResponse = {
  message?: string
}

export class AuthApiError extends Error {
  readonly status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = 'AuthApiError'
    this.status = status
  }
}

// Auth uses the same client as every other domain (DEV-123), so its paths go through `assertSafeApiPath`
// too. It does not carry the active wallet: registering, signing in and reading the session happen before or
// regardless of any wallet choice, and the auth routes never read `X-Wallet-Id`.
const request = createApiRequest(AuthApiError, { scopeToActiveWallet: false })

export const authApi = {
  register(email: string, password: string, invitationToken?: string) {
    return request<MessageResponse>('/auth/register', {
      method: 'POST',
      body: JSON.stringify({ email, password, ...(invitationToken ? { invitationToken } : {}) }),
    })
  },

  verifyEmail(token: string) {
    return request<MessageResponse>('/auth/verify-email', {
      method: 'POST',
      body: JSON.stringify({ token }),
    })
  },

  login(email: string, password: string) {
    return request<UserResponse>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    })
  },

  me(signal?: AbortSignal) {
    return request<UserResponse>('/auth/me', { signal })
  },

  logout() {
    return request<void>('/auth/logout', { method: 'POST' })
  },
}
