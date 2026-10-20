import { afterEach, describe, expect, it, vi } from 'vitest'
import { creditCardsApi } from './creditCardsApi'

const card = { id: 'card-1', nickname: 'Principal', closingDay: 10, dueDay: 17, isActive: true }
const statement = { id: 'statement-1', creditCardId: 'card-1', creditCardName: 'Principal', closingDate: '2026-10-10', dueDate: '2026-10-17', paidDate: null, paidAmount: null, totalAmount: '123.45', purchases: [] }

describe('creditCardsApi', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('lists and creates cards using the active wallet and expected REST payload', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ items: [card] }) })
      .mockResolvedValueOnce({ ok: true, status: 201, json: async () => card })
    vi.stubGlobal('fetch', fetchMock)

    await expect(creditCardsApi.list()).resolves.toEqual({ items: [card] })
    await creditCardsApi.create({ nickname: 'Principal', closingDay: 10, dueDay: 17 })
    expect(fetchMock).toHaveBeenNthCalledWith(1, '/api/credit-cards', expect.objectContaining({ credentials: 'include' }))
    expect(fetchMock).toHaveBeenNthCalledWith(2, '/api/credit-cards', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ nickname: 'Principal', closingDay: 10, dueDay: 17 }),
    }))
  })

  it('loads statements by month and posts full payment date', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ items: [statement] }) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ ...statement, paidDate: '2026-10-18', paidAmount: '123.45' }) })
    vi.stubGlobal('fetch', fetchMock)

    await expect(creditCardsApi.statements('card /1', '2026-10-01', '2026-10-31')).resolves.toEqual({ items: [statement] })
    await creditCardsApi.payStatement('card /1', 'statement/1', '2026-10-18')
    expect(fetchMock).toHaveBeenNthCalledWith(1, '/api/credit-cards/card%20%2F1/statements?from=2026-10-01&to=2026-10-31', expect.any(Object))
    expect(fetchMock).toHaveBeenNthCalledWith(2, '/api/credit-cards/card%20%2F1/statements/statement%2F1/pay', expect.objectContaining({
      method: 'POST', body: JSON.stringify({ date: '2026-10-18' }),
    }))
  })
})
