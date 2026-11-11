import { afterEach, describe, expect, it, vi } from 'vitest'

// DEV-123: the point of moving authentication onto the shared client is that its paths pass the guard.
// The request tests in authApi.test.ts would stay green if authApi went back to its own `fetch`, because
// the URLs are the same, so this file asserts the guard itself is called for every auth action.
const guard = vi.hoisted(() => vi.fn((path: string) => path))
vi.mock('./api/requestPath', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./api/requestPath')>()),
  assertSafeApiPath: guard,
}))

const { authApi } = await import('./authApi')

describe('authApi path guard', () => {
  afterEach(() => { vi.unstubAllGlobals(); guard.mockClear() })

  it('sends every auth path through assertSafeApiPath', async () => {
    const calls: Array<[string, () => Promise<unknown>]> = [
      ['/auth/register', () => authApi.register('tito@example.com', 'SenhaForte1!')],
      ['/auth/verify-email', () => authApi.verifyEmail('token-1')],
      ['/auth/login', () => authApi.login('tito@example.com', 'SenhaForte1!')],
      ['/auth/me', () => authApi.me()],
      ['/auth/logout', () => authApi.logout()],
    ]
    for (const [path, call] of calls) {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 204 })))
      await call()
      expect(guard).toHaveBeenLastCalledWith(path)
    }
    expect(guard).toHaveBeenCalledTimes(calls.length)
  })
})
