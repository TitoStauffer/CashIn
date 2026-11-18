import type { ApiClient, ApiRequestOptions } from '../api/client'
import { balanceTypeLabel, createIncomeApi, type IncomeApi, type IncomeInput } from './incomeApi'

function recordingClient() {
  const calls: { path: string; options?: ApiRequestOptions }[] = []
  const client = (async (path: string, options?: ApiRequestOptions) => {
    calls.push({ path, options })
    return { items: [] }
  }) as ApiClient
  return { api: createIncomeApi(client), calls }
}

const INPUT: IncomeInput = {
  amount: '0.10',
  date: '2026-11-18',
  description: 'Troco',
  categoryId: 'c1',
  subcategoryId: null,
  balanceType: 'cash',
}

// The contract is `docs/api.md`, section "Lançamentos de entrada". Every route belongs to the active
// wallet, so none of them opts out of X-Wallet-Id.
describe('createIncomeApi', () => {
  it.each([
    ['list', (api: IncomeApi) => api.list('2026-11-01', '2026-11-30'), '/incomes?from=2026-11-01&to=2026-11-30', undefined, undefined],
    ['create', (api: IncomeApi) => api.create(INPUT), '/incomes', 'POST', INPUT],
    ['update', (api: IncomeApi) => api.update('i1', INPUT), '/incomes/i1', 'PUT', INPUT],
    ['remove', (api: IncomeApi) => api.remove('i1'), '/incomes/i1', 'DELETE', undefined],
  ])('%s calls the documented route in the active wallet', async (_name, call, path, method, body) => {
    const { api, calls } = recordingClient()
    await call(api)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.path).toBe(path)
    expect(calls[0]?.options?.scopeToActiveWallet).toBeUndefined()
    expect(calls[0]?.options?.method).toBe(method)
    expect(calls[0]?.options?.body).toEqual(body)
  })

  it('sends the amount as the exact decimal string, never as a number', async () => {
    const { api, calls } = recordingClient()
    await api.create(INPUT)
    expect((calls[0]?.options?.body as IncomeInput).amount).toBe('0.10')
  })

  it('encodes the income id, so it cannot leave its route', async () => {
    const { api, calls } = recordingClient()
    await api.remove('i/../1')
    expect(calls[0]?.path).toBe('/incomes/i%2F..%2F1')
  })

  it('labels the current and the historical balances, and old records without one as cash', () => {
    expect(balanceTypeLabel('food_meal_benefit')).toBe('Cartão de benefícios (VA/VR)')
    expect(balanceTypeLabel('food_benefit')).toBe('Vale-alimentação (VA) · histórico')
    expect(balanceTypeLabel(undefined)).toBe('Dinheiro')
  })
})
