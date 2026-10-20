import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  getPaymentMethodNatureLabel,
  PaymentMethodApiError,
  paymentMethodsApi,
} from './paymentMethodsApi'

const paymentMethod = { id: 'method-id', name: 'Pix', nature: 'immediate' as const, isActive: true }

describe('paymentMethodsApi', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('loads methods with credentials and returns the wallet response', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ items: [paymentMethod] }) })
    vi.stubGlobal('fetch', fetchMock)

    await expect(paymentMethodsApi.list()).resolves.toEqual({ items: [paymentMethod] })
    expect(fetchMock).toHaveBeenCalledWith('/api/payment-methods', expect.objectContaining({ credentials: 'include' }))
  })

  it('creates and updates a method with JSON payloads and encoded ids', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 201, json: async () => paymentMethod })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => paymentMethod })
    vi.stubGlobal('fetch', fetchMock)

    await paymentMethodsApi.create({ name: 'Pix', nature: 'immediate' })
    await paymentMethodsApi.update('method /id', { isActive: false })

    expect(fetchMock).toHaveBeenNthCalledWith(1, '/api/payment-methods', expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ name: 'Pix', nature: 'immediate' }),
    }))
    expect(fetchMock).toHaveBeenNthCalledWith(2, '/api/payment-methods/method%20%2Fid', expect.objectContaining({
      method: 'PATCH',
      body: JSON.stringify({ isActive: false }),
    }))
  })

  it('maps server errors and tolerates an invalid error payload', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 409, json: async () => ({ message: 'Duplicada' }) })
      .mockResolvedValueOnce({ ok: false, status: 400, json: async () => { throw new Error('invalid json') } })
    vi.stubGlobal('fetch', fetchMock)

    await expect(paymentMethodsApi.list()).rejects.toMatchObject({ name: 'PaymentMethodApiError', status: 409, message: 'Duplicada' })
    await expect(paymentMethodsApi.list()).rejects.toBeInstanceOf(PaymentMethodApiError)
  })

  it('labels supported natures and returns an empty label for missing values', () => {
    expect(getPaymentMethodNatureLabel('credit_card')).toBe('Cartão de crédito')
    expect(getPaymentMethodNatureLabel(null)).toBe('')
  })
})
