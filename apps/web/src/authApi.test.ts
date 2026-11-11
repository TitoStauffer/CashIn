import { afterEach, describe, expect, it, vi } from 'vitest'
import { AuthApiError, authApi } from './authApi'
import { setRequestWalletId } from './wallets/walletApi'

// DEV-123: authentication now goes through the shared client, like every other domain, so its paths pass
// the same guard. These tests pin the requests the screens depended on before the move, so the change of
// client cannot alter what reaches the API.
function mockFetch(response: Response) {
  const spy = vi.fn().mockResolvedValue(response)
  vi.stubGlobal('fetch', spy)
  return spy
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

function sent(spy: ReturnType<typeof vi.fn>) {
  const [url, init] = spy.mock.calls[0]! as [string, RequestInit]
  return { url, init, headers: new Headers(init.headers) }
}

describe('authApi', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); setRequestWalletId(null) })

  it('posts each auth action to its /api/auth route with credentials and a JSON body', async () => {
    const cases: Array<[string, () => Promise<unknown>, unknown]> = [
      ['/api/auth/register', () => authApi.register('tito@example.com', 'SenhaForte1!'), { email: 'tito@example.com', password: 'SenhaForte1!' }],
      ['/api/auth/register', () => authApi.register('tito@example.com', 'SenhaForte1!', 'convite'), { email: 'tito@example.com', password: 'SenhaForte1!', invitationToken: 'convite' }],
      ['/api/auth/verify-email', () => authApi.verifyEmail('token-1'), { token: 'token-1' }],
      ['/api/auth/login', () => authApi.login('tito@example.com', 'SenhaForte1!'), { email: 'tito@example.com', password: 'SenhaForte1!' }],
    ]
    for (const [url, call, body] of cases) {
      const spy = mockFetch(json({ message: 'ok', user: { id: '1', email: 'tito@example.com' } }))
      await call()
      const request = sent(spy)
      expect(request.url).toBe(url)
      expect(request.init.method).toBe('POST')
      expect(request.init.credentials).toBe('include')
      expect(request.headers.get('Content-Type')).toBe('application/json')
      expect(JSON.parse(request.init.body as string)).toEqual(body)
      vi.unstubAllGlobals()
    }
  })

  it('reads the session with a GET that forwards the abort signal and sends no body', async () => {
    const spy = mockFetch(json({ user: { id: '1', email: 'tito@example.com' } }))
    const controller = new AbortController()

    await expect(authApi.me(controller.signal)).resolves.toEqual({ user: { id: '1', email: 'tito@example.com' } })
    const request = sent(spy)
    expect(request.url).toBe('/api/auth/me')
    expect(request.init.method).toBeUndefined()
    expect(request.init.signal).toBe(controller.signal)
    expect(request.headers.has('Content-Type')).toBe(false)
  })

  it('never carries the active wallet, which the auth routes do not read', async () => {
    setRequestWalletId('wallet-1')
    const spy = mockFetch(json({ user: { id: '1', email: 'tito@example.com' } }))

    await authApi.login('tito@example.com', 'SenhaForte1!')
    expect(sent(spy).headers.has('X-Wallet-Id')).toBe(false)
  })

  it('accepts the empty 204 of logout', async () => {
    mockFetch(new Response(null, { status: 204 }))
    await expect(authApi.logout()).resolves.toBeUndefined()
  })

  it('turns an API error into AuthApiError with the server message and status', async () => {
    mockFetch(json({ message: 'Este e-mail já possui uma conta.' }, 409))

    const error = await authApi.register('tito@example.com', 'SenhaForte1!').catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(AuthApiError)
    expect(error).toMatchObject({ message: 'Este e-mail já possui uma conta.', status: 409 })
  })
})
