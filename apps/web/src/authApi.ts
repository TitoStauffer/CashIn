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

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`/api/auth/${path}`, {
    ...init,
    credentials: 'include',
    headers: {
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...init.headers,
    },
  })

  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as MessageResponse | null
    throw new AuthApiError(body?.message ?? '', response.status)
  }

  if (response.status === 204) {
    return undefined as T
  }

  return (await response.json()) as T
}

export const authApi = {
  register(email: string, password: string, invitationToken?: string) {
    return request<MessageResponse>('register', {
      method: 'POST',
      body: JSON.stringify({ email, password, ...(invitationToken ? { invitationToken } : {}) }),
    })
  },

  verifyEmail(token: string) {
    return request<MessageResponse>('verify-email', {
      method: 'POST',
      body: JSON.stringify({ token }),
    })
  },

  login(email: string, password: string) {
    return request<UserResponse>('login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    })
  },

  me(signal?: AbortSignal) {
    return request<UserResponse>('me', { signal })
  },

  logout() {
    return request<void>('logout', { method: 'POST' })
  },
}
