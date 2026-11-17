import type { ApiClient, ApiRequestOptions } from '../api/client'
import { createAuthApi } from './authApi'

function recordingClient(answer: unknown = {}) {
  const calls: { path: string; options?: ApiRequestOptions }[] = []
  const client = (async (path: string, options?: ApiRequestOptions) => {
    calls.push({ path, options })
    return answer
  }) as ApiClient
  return { client, calls }
}

// The contract is `docs/api.md`: register and the token login send e-mail and password; the session is
// read with GET /auth/me and ended with POST /auth/logout, all outside any wallet.
describe('createAuthApi', () => {
  it('signs up with POST /auth/register, outside any wallet', async () => {
    const { client, calls } = recordingClient({ message: 'Email enviado, favor confirmar seu cadastro' })
    await expect(createAuthApi(client).register('pessoa@example.com', 'Abcdef1!secure')).resolves.toEqual({ message: 'Email enviado, favor confirmar seu cadastro' })
    expect(calls).toEqual([{ path: '/auth/register', options: { method: 'POST', body: { email: 'pessoa@example.com', password: 'Abcdef1!secure' }, scopeToActiveWallet: false } }])
  })

  it('signs in with the token login, POST /auth/token, never the cookie login', async () => {
    const session = { user: { id: '1', email: 'pessoa@example.com' }, token: 't'.repeat(43), expiresAt: '2026-12-17T00:00:00.000Z' }
    const { client, calls } = recordingClient(session)
    await expect(createAuthApi(client).login('pessoa@example.com', 'Abcdef1!secure')).resolves.toEqual(session)
    expect(calls).toEqual([{ path: '/auth/token', options: { method: 'POST', body: { email: 'pessoa@example.com', password: 'Abcdef1!secure' }, scopeToActiveWallet: false } }])
  })

  it('reads the session with GET /auth/me', async () => {
    const { client, calls } = recordingClient({ user: { id: '1', email: 'pessoa@example.com' } })
    await createAuthApi(client).me()
    expect(calls).toEqual([{ path: '/auth/me', options: { scopeToActiveWallet: false } }])
  })

  it('ends the session with POST /auth/logout, without reporting its own 401 as an expired session', async () => {
    const { client, calls } = recordingClient(undefined)
    await createAuthApi(client).logout()
    expect(calls).toEqual([{ path: '/auth/logout', options: { method: 'POST', scopeToActiveWallet: false, reportUnauthorized: false } }])
  })
})
