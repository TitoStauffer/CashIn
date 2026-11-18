import { ApiError, assertSafeApiPath, createApiClient } from './client'

const TOKEN = 'tokenDeSessaoMovel'.padEnd(43, 'x')

type Call = { url: string; init: RequestInit }

function jsonResponse(status: number, body: unknown): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function clientWith(respond: (call: Call) => Response | Promise<Response>, overrides: Partial<Parameters<typeof createApiClient>[0]> = {}) {
  const calls: Call[] = []
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const call = { url, init }
    calls.push(call)
    return respond(call)
  }) as unknown as typeof fetch
  const request = createApiClient({
    baseUrl: 'https://api.saldocerto.example',
    getToken: async () => TOKEN,
    getActiveWalletId: () => 'wallet-1',
    fetchImpl,
    ...overrides,
  })
  return { request, calls }
}

function headersOf(call: Call | undefined): Record<string, string> {
  return (call?.init.headers ?? {}) as Record<string, string>
}

describe('createApiClient', () => {
  it('sends the token as a bearer header and the active wallet on scoped routes', async () => {
    const { request, calls } = clientWith(() => jsonResponse(200, { items: [] }))

    await expect(request('/categories')).resolves.toEqual({ items: [] })

    expect(calls[0]?.url).toBe('https://api.saldocerto.example/categories')
    expect(headersOf(calls[0])).toEqual({
      Accept: 'application/json',
      Authorization: `Bearer ${TOKEN}`,
      'X-Wallet-Id': 'wallet-1',
    })
  })

  it('leaves the wallet out of unscoped routes and the token out when there is no session', async () => {
    const { request, calls } = clientWith(() => jsonResponse(200, { status: 'ok' }), { getToken: async () => null })

    await request('/health', { scopeToActiveWallet: false })

    expect(headersOf(calls[0])).toEqual({ Accept: 'application/json' })
  })

  it('sends a JSON body with its content type', async () => {
    const { request, calls } = clientWith(() => jsonResponse(201, { id: '1' }))

    await request('/expenses', { method: 'POST', body: { amount: '10.50' } })

    expect(calls[0]?.init.method).toBe('POST')
    expect(calls[0]?.init.body).toBe('{"amount":"10.50"}')
    expect(headersOf(calls[0])['Content-Type']).toBe('application/json')
  })

  it('returns nothing for a 204', async () => {
    const { request } = clientWith(() => new Response(null, { status: 204 }))
    await expect(request('/auth/logout', { method: 'POST' })).resolves.toBeUndefined()
  })

  it('shows the API message when it sends one', async () => {
    const { request } = clientWith(() => jsonResponse(409, { message: 'A categoria já existe.' }))
    await expect(request('/categories')).rejects.toEqual(new ApiError('A categoria já existe.', 409))
  })

  it.each([
    [401, 'Sua sessão expirou. Entre novamente.'],
    [403, 'Você não tem permissão para esta ação.'],
    [404, 'Não encontramos o que você procurava.'],
    [429, 'Muitas tentativas. Aguarde alguns minutos e tente novamente.'],
    [503, 'O servidor não conseguiu concluir a solicitação. Tente novamente.'],
    [418, 'Não foi possível concluir a solicitação.'],
  ])('falls back to a Portuguese message for status %i without a usable body', async (status, message) => {
    const { request } = clientWith(() => new Response('<html>', { status }))
    const error = await request('/categories').catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(ApiError)
    expect(error).toMatchObject({ message, status })
  })

  it('tells the app when the session is no longer valid', async () => {
    const onUnauthorized = jest.fn()
    const { request } = clientWith(() => jsonResponse(401, { message: 'Autenticação necessária.' }), { onUnauthorized })

    await expect(request('/auth/me')).rejects.toMatchObject({ status: 401, message: 'Autenticação necessária.' })
    expect(onUnauthorized).toHaveBeenCalledTimes(1)
    // The refused token travels with the report, so the session can ignore a late 401 for an older one.
    expect(onUnauthorized).toHaveBeenCalledWith(TOKEN)

    const other = clientWith(() => jsonResponse(403, {}), { onUnauthorized })
    await other.request('/auth/me').catch(() => undefined)
    expect(onUnauthorized).toHaveBeenCalledTimes(1)
  })

  // DEV-142: a 401 ends the app session only when the request carried one. A wrong password on the
  // login is a 401 without a token, and the logout opts out of reporting its own 401.
  it('does not end the session on a 401 that carried no session, nor on an opted-out request', async () => {
    const onUnauthorized = jest.fn()
    const anonymous = clientWith(() => jsonResponse(401, { message: 'E-mail ou senha inválidos.' }), { onUnauthorized, getToken: async () => null })
    await expect(anonymous.request('/auth/token', { method: 'POST', body: {} })).rejects.toMatchObject({ status: 401, message: 'E-mail ou senha inválidos.' })
    expect(onUnauthorized).not.toHaveBeenCalled()

    const logout = clientWith(() => jsonResponse(401, { message: 'Autenticação necessária.' }), { onUnauthorized })
    await logout.request('/auth/logout', { method: 'POST', reportUnauthorized: false }).catch(() => undefined)
    expect(onUnauthorized).not.toHaveBeenCalled()
  })

  // DEV-143: the API answers 404 for a wallet the person no longer has. Only a request that sent
  // X-Wallet-Id reports it, naming the wallet it sent; a 404 elsewhere is just a missing resource.
  it('reports a 404 on a wallet-scoped request with the wallet it sent', async () => {
    const onWalletNotFound = jest.fn()
    const scoped = clientWith(() => jsonResponse(404, { message: 'Carteira não encontrada.' }), { onWalletNotFound })
    await expect(scoped.request('/incomes')).rejects.toMatchObject({ status: 404, message: 'Carteira não encontrada.' })
    expect(onWalletNotFound).toHaveBeenCalledWith('wallet-1')

    onWalletNotFound.mockClear()
    await scoped.request('/wallets/w9/members', { scopeToActiveWallet: false }).catch(() => undefined)
    const noWallet = clientWith(() => jsonResponse(404, {}), { onWalletNotFound, getActiveWalletId: () => null })
    await noWallet.request('/incomes').catch(() => undefined)
    const otherStatus = clientWith(() => jsonResponse(403, {}), { onWalletNotFound })
    await otherStatus.request('/incomes').catch(() => undefined)
    expect(onWalletNotFound).not.toHaveBeenCalled()
  })

  it('reports a success without a JSON body as an ApiError in Portuguese', async () => {
    const { request } = clientWith(() => new Response('<html>ok</html>', { status: 200 }))
    await expect(request('/health')).rejects.toEqual(new ApiError('A API respondeu de forma inesperada. Tente novamente.', 200))
  })

  it('refuses an unsafe path as a programming error, before any request', async () => {
    const { request, calls } = clientWith(() => jsonResponse(200, {}))
    const error = await request('/%2e%2e/admin').catch((caught: unknown) => caught)
    expect(error).not.toBeInstanceOf(ApiError)
    expect(error).toEqual(new Error('Unsafe API path: /%2e%2e/admin'))
    expect(calls).toHaveLength(0)
  })

  it('reports a connection failure in Portuguese', async () => {
    const { request } = clientWith(() => { throw new TypeError('Network request failed') })
    await expect(request('/health')).rejects.toEqual(new ApiError('Não foi possível conectar à API. Verifique sua conexão.', 0))
  })

  it('gives up after the timeout and says so', async () => {
    const { request } = clientWith(({ init }) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new Error('aborted')))
    }), { timeoutMs: 10 })
    await expect(request('/health')).rejects.toEqual(new ApiError('A API demorou para responder. Tente novamente.', 0))
  })

  it('sends a file as is, in octet-stream, with the route headers and without replacing its own', async () => {
    const { request, calls } = clientWith(() => jsonResponse(201, { id: 'imp-1' }))
    const file = new Blob(['OFXHEADER:100'])
    await request('/financial-imports', {
      method: 'POST',
      rawBody: file,
      headers: { 'X-File-Name': 'extrato.ofx', Authorization: 'Bearer forjado', 'X-Wallet-Id': 'outra' },
    })
    expect(calls[0]?.init.body).toBe(file)
    expect(headersOf(calls[0])).toEqual({
      Accept: 'application/json',
      'Content-Type': 'application/octet-stream',
      Authorization: `Bearer ${TOKEN}`,
      'X-Wallet-Id': 'wallet-1',
      'X-File-Name': 'extrato.ofx',
    })
  })

  it('waits longer on a route that asks for it', async () => {
    const { request } = clientWith(({ init }) => new Promise<Response>((resolve, reject) => {
      const timer = setTimeout(() => resolve(jsonResponse(200, { ok: true })), 30)
      init.signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('aborted')) })
    }), { timeoutMs: 10 })
    await expect(request('/financial-imports', { timeoutMs: 1_000 })).resolves.toEqual({ ok: true })
  })

  it('never writes the token to the console, on success or on failure', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((method) => jest.spyOn(console, method).mockImplementation(() => undefined))
    try {
      await clientWith(() => jsonResponse(200, {})).request('/auth/me')
      await clientWith(() => jsonResponse(500, {})).request('/auth/me').catch(() => undefined)
      await clientWith(() => { throw new Error('boom') }).request('/auth/me').catch(() => undefined)
      for (const spy of spies) expect(spy).not.toHaveBeenCalled()
    } finally {
      for (const spy of spies) spy.mockRestore()
    }
  })
})

describe('assertSafeApiPath', () => {
  it('accepts absolute API paths', () => {
    expect(assertSafeApiPath('/credit-cards/1/statements?month=2026-11')).toBe('/credit-cards/1/statements?month=2026-11')
  })

  it.each([
    'health',
    '//evil.example/x',
    '/../admin',
    '/a/./b',
    '/a\\b',
    '/https://evil.example',
    '/%2e%2e/admin',
    '/categories/.%2E/admin',
    '/a%5Cb',
    '/%2F%2Fevil.example',
    '/broken%zz',
  ])('refuses %s', (path) => {
    expect(() => assertSafeApiPath(path)).toThrow('Unsafe API path')
  })
})
