import type { ApiClient, ApiRequestOptions } from '../api/client'
import { createCreditCardApi, type CreditCardApi } from './creditCardApi'

function recordingClient() {
  const calls: { path: string; options?: ApiRequestOptions }[] = []
  const client = (async (path: string, options?: ApiRequestOptions) => {
    calls.push({ path, options })
    return { items: [] }
  }) as ApiClient
  return { api: createCreditCardApi(client), calls }
}

// The contract is `docs/api.md`, section "Cartões de crédito e faturas". Every route belongs to the
// active wallet, so none of them opts out of X-Wallet-Id.
describe('createCreditCardApi', () => {
  it.each([
    ['list', (api: CreditCardApi) => api.list(), '/credit-cards', undefined, undefined],
    ['create', (api: CreditCardApi) => api.create({ nickname: 'Gold', closingDay: 10, dueDay: 20 }), '/credit-cards', 'POST', { nickname: 'Gold', closingDay: 10, dueDay: 20 }],
    ['update', (api: CreditCardApi) => api.update('k1', { isActive: false }), '/credit-cards/k1', 'PATCH', { isActive: false }],
    ['listStatements', (api: CreditCardApi) => api.listStatements('k1', '2026-11-01', '2026-11-30'), '/credit-cards/k1/statements?from=2026-11-01&to=2026-11-30', undefined, undefined],
    ['payStatement in full', (api: CreditCardApi) => api.payStatement('k1', 's2', { date: '2026-11-18' }), '/credit-cards/k1/statements/s2/pay', 'POST', { date: '2026-11-18' }],
    ['payStatement in part', (api: CreditCardApi) => api.payStatement('k1', 's2', { date: '2026-11-18', amount: '300.00' }), '/credit-cards/k1/statements/s2/pay', 'POST', { date: '2026-11-18', amount: '300.00' }],
  ])('%s calls the documented route in the active wallet', async (_name, call, path, method, body) => {
    const { api, calls } = recordingClient()
    await call(api)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.path).toBe(path)
    expect(calls[0]?.options?.scopeToActiveWallet).toBeUndefined()
    expect(calls[0]?.options?.method).toBe(method)
    expect(calls[0]?.options?.body).toEqual(body)
  })

  it('encodes card and statement ids, so they cannot leave their route', async () => {
    const { api, calls } = recordingClient()
    await api.payStatement('k/../1', 's?2', { date: '2026-11-18' })
    expect(calls[0]?.path).toBe('/credit-cards/k%2F..%2F1/statements/s%3F2/pay')
  })
})
