import type { ApiClient, ApiRequestOptions } from '../api/client'
import { balanceDebitedBy, createExpenseApi, type ExpenseApi, type ExpenseInput } from './expenseApi'

function recordingClient() {
  const calls: { path: string; options?: ApiRequestOptions }[] = []
  const client = (async (path: string, options?: ApiRequestOptions) => {
    calls.push({ path, options })
    return { items: [] }
  }) as ApiClient
  return { api: createExpenseApi(client), calls }
}

const INPUT: ExpenseInput = {
  amount: '0.10',
  date: '2026-11-18',
  description: 'Café',
  categoryId: 'c1',
  subcategoryId: null,
  paymentMethodId: 'p1',
  creditCardId: null,
}

// The contract is `docs/api.md`, sections "Lançamentos de saída" and "Cartões de crédito e faturas".
// Every route belongs to the active wallet, so none of them opts out of X-Wallet-Id.
describe('createExpenseApi', () => {
  it.each([
    ['list', (api: ExpenseApi) => api.list('2026-11-01', '2026-11-30'), '/expenses?from=2026-11-01&to=2026-11-30', undefined, undefined],
    ['create', (api: ExpenseApi) => api.create(INPUT), '/expenses', 'POST', INPUT],
    ['update', (api: ExpenseApi) => api.update('e1', INPUT), '/expenses/e1', 'PUT', INPUT],
    ['remove', (api: ExpenseApi) => api.remove('e1'), '/expenses/e1', 'DELETE', undefined],
    ['listCreditCards', (api: ExpenseApi) => api.listCreditCards(), '/credit-cards', undefined, undefined],
  ])('%s calls the documented route in the active wallet', async (_name, call, path, method, body) => {
    const { api, calls } = recordingClient()
    await call(api)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.path).toBe(path)
    expect(calls[0]?.options?.scopeToActiveWallet).toBeUndefined()
    expect(calls[0]?.options?.method).toBe(method)
    expect(calls[0]?.options?.body).toEqual(body)
  })

  it('encodes the expense id, so it cannot leave its route', async () => {
    const { api, calls } = recordingClient()
    await api.remove('e/../1')
    expect(calls[0]?.path).toBe('/expenses/e%2F..%2F1')
  })

  it('says which balance each payment nature reduces', () => {
    expect(balanceDebitedBy('food_meal_benefit')).toBe('Reduz o saldo do cartão de benefícios (VA/VR).')
    expect(balanceDebitedBy('meal_benefit')).toBe('Reduz o saldo do cartão de benefícios (VA/VR).')
    expect(balanceDebitedBy('home_office_benefit')).toBe('Reduz o saldo do auxílio home office (AHO).')
    expect(balanceDebitedBy('credit_card')).toBe('Entra na fatura do cartão escolhido.')
    expect(balanceDebitedBy('immediate')).toBe('Reduz o saldo em dinheiro.')
    expect(balanceDebitedBy(null)).toBe('Reduz o saldo em dinheiro.')
  })
})
