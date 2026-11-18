// The app's wiring: the token from the secure store, the active wallet in X-Wallet-Id, and the 401
// and 404 reports reaching whoever registered for them.
jest.mock('expo-constants', () => ({ __esModule: true, default: { expoConfig: { hostUri: undefined } } }))
jest.mock('../auth/tokenStorage', () => ({ tokenStorage: { read: async () => 'token-do-aparelho' } }))

type Call = { url: string; init: RequestInit }

function loadApp(status: number) {
  process.env.EXPO_PUBLIC_API_URL = 'https://api.saldocerto.example'
  const calls: Call[] = []
  let app!: typeof import('./appClient')
  let wallet!: typeof import('../wallets/activeWallet')
  jest.isolateModules(() => {
    app = jest.requireActual('./appClient')
    wallet = jest.requireActual('../wallets/activeWallet')
  })
  // Loading the modules may install Expo's own fetch, so the fake replaces it afterwards.
  global.fetch = jest.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    return new Response(JSON.stringify({ items: [], message: 'Carteira não encontrada.' }), { status, headers: { 'Content-Type': 'application/json' } })
  }) as unknown as typeof fetch
  return { app, wallet, calls }
}

describe('appClient', () => {
  it('sends the stored token and the active wallet', async () => {
    const { app, wallet, calls } = loadApp(200)
    wallet.setActiveWalletId('wallet-7')
    await app.getApiClient()('/incomes')
    const headers = calls[0]?.init.headers as Record<string, string>
    expect(calls[0]?.url).toBe('https://api.saldocerto.example/incomes')
    expect(headers.Authorization).toBe('Bearer token-do-aparelho')
    expect(headers['X-Wallet-Id']).toBe('wallet-7')

    await app.appWalletApi.list()
    expect((calls[1]?.init.headers as Record<string, string>)['X-Wallet-Id']).toBeUndefined()
  })

  it('passes a 404 for the active wallet to the registered handler until it unregisters', async () => {
    const { app, wallet } = loadApp(404)
    wallet.setActiveWalletId('wallet-7')
    const handler = jest.fn()
    const unregister = app.registerWalletNotFoundHandler(handler)
    await app.getApiClient()('/incomes').catch(() => undefined)
    expect(handler).toHaveBeenCalledWith('wallet-7')

    unregister()
    await app.getApiClient()('/incomes').catch(() => undefined)
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('passes a 401 to the registered handler, and an old unregister never drops a newer handler', async () => {
    const { app } = loadApp(401)
    const first = jest.fn()
    const second = jest.fn()
    const unregisterFirst = app.registerUnauthorizedHandler(first)
    app.registerUnauthorizedHandler(second)
    unregisterFirst()
    await app.appAuthApi.me().catch(() => undefined)
    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledWith('token-do-aparelho')
  })
})
