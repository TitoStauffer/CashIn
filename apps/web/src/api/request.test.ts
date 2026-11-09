import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApiRequest } from './request'
import { UnsafeApiPathError } from './requestPath'
import { setRequestWalletId } from '../wallets/walletApi'

class TestApiError extends Error {
  readonly status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = 'TestApiError'
    this.status = status
  }
}

function mockFetch(response: Response) {
  const spy = vi.fn().mockResolvedValue(response)
  vi.stubGlobal('fetch', spy)
  return spy
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

describe('createApiRequest', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); setRequestWalletId(null) })

  it('calls the API under the /api prefix and returns the parsed body', async () => {
    const spy = mockFetch(json({ items: [1, 2] }))
    const request = createApiRequest(TestApiError)

    await expect(request<{ items: number[] }>('/things')).resolves.toEqual({ items: [1, 2] })
    expect(spy.mock.calls[0]![0]).toBe('/api/things')
    expect(spy.mock.calls[0]![1]).toMatchObject({ credentials: 'include' })
  })

  it('sends the JSON content type only when there is a body', async () => {
    const withBody = mockFetch(json({}))
    await createApiRequest(TestApiError)('/things', { method: 'POST', body: '{}' })
    expect((withBody.mock.calls[0]![1] as RequestInit).headers).toMatchObject({ 'Content-Type': 'application/json' })

    vi.unstubAllGlobals()
    const withoutBody = mockFetch(json({}))
    await createApiRequest(TestApiError)('/things')
    expect((withoutBody.mock.calls[0]![1] as RequestInit).headers).not.toHaveProperty('Content-Type')
  })

  it('returns undefined for 204, which carries no body to parse', async () => {
    mockFetch(new Response(null, { status: 204 }))

    await expect(createApiRequest(TestApiError)('/things', { method: 'DELETE' })).resolves.toBeUndefined()
  })

  it('throws the domain error with the message and status the API returned', async () => {
    mockFetch(json({ message: 'A fatura escolhida não possui saldo devedor.' }, 409))

    await expect(createApiRequest(TestApiError)('/things')).rejects.toMatchObject({
      name: 'TestApiError',
      message: 'A fatura escolhida não possui saldo devedor.',
      status: 409,
    })
  })

  it('throws the domain error with an empty message when the failure body is not JSON', async () => {
    mockFetch(new Response('<html>502</html>', { status: 502 }))

    await expect(createApiRequest(TestApiError)('/things')).rejects.toMatchObject({ message: '', status: 502 })
  })

  // The guard runs before the request leaves, so a path that could redirect it never reaches `fetch`.
  it('refuses an unsafe path without calling fetch', async () => {
    const spy = mockFetch(json({}))

    await expect(createApiRequest(TestApiError)('//evil.example.com')).rejects.toThrow(UnsafeApiPathError)
    expect(spy).not.toHaveBeenCalled()
  })

  // The wallet routes themselves cannot be scoped by the wallet already chosen.
  it('carries the active wallet by default and omits it when the caller opts out', async () => {
    setRequestWalletId('wallet-1')

    const scoped = mockFetch(json({}))
    await createApiRequest(TestApiError)('/things')
    const scopedHeaders = new Headers((scoped.mock.calls[0]![1] as RequestInit).headers)

    vi.unstubAllGlobals()
    const unscoped = mockFetch(json({}))
    await createApiRequest(TestApiError, { scopeToActiveWallet: false })('/wallets')
    const unscopedHeaders = new Headers((unscoped.mock.calls[0]![1] as RequestInit).headers)

    expect(scopedHeaders.get('X-Wallet-Id')).toBe('wallet-1')
    expect(unscopedHeaders.get('X-Wallet-Id')).toBeNull()
  })
})
