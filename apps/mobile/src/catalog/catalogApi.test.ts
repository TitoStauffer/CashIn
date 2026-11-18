import type { ApiClient, ApiRequestOptions } from '../api/client'
import { createCatalogApi, paymentMethodNatureLabel, type CatalogApi } from './catalogApi'

function recordingClient() {
  const calls: { path: string; options?: ApiRequestOptions }[] = []
  const client = (async (path: string, options?: ApiRequestOptions) => {
    calls.push({ path, options })
    return { items: [] }
  }) as ApiClient
  return { api: createCatalogApi(client), calls }
}

// The contract is `docs/api.md`, sections "Categorias financeiras" and "Formas de pagamento". Every
// route belongs to the active wallet, so none of them opts out of X-Wallet-Id.
describe('createCatalogApi', () => {
  it.each([
    ['listCategories', (api: CatalogApi) => api.listCategories('expense'), '/categories?nature=expense', undefined, undefined],
    ['createCategory', (api: CatalogApi) => api.createCategory('Mercado', 'expense'), '/categories', 'POST', { name: 'Mercado', nature: 'expense' }],
    ['renameCategory', (api: CatalogApi) => api.renameCategory('c1', 'Feira'), '/categories/c1', 'PATCH', { name: 'Feira' }],
    ['removeCategory', (api: CatalogApi) => api.removeCategory('c1'), '/categories/c1', 'DELETE', undefined],
    ['createSubcategory', (api: CatalogApi) => api.createSubcategory('c1', 'Hortifrúti'), '/categories/c1/subcategories', 'POST', { name: 'Hortifrúti' }],
    ['renameSubcategory', (api: CatalogApi) => api.renameSubcategory('c1', 's2', 'Frutas'), '/categories/c1/subcategories/s2', 'PATCH', { name: 'Frutas' }],
    ['removeSubcategory', (api: CatalogApi) => api.removeSubcategory('c1', 's2'), '/categories/c1/subcategories/s2', 'DELETE', undefined],
    ['listPaymentMethods', (api: CatalogApi) => api.listPaymentMethods(), '/payment-methods', undefined, undefined],
    ['createPaymentMethod', (api: CatalogApi) => api.createPaymentMethod('Pix', 'immediate'), '/payment-methods', 'POST', { name: 'Pix', nature: 'immediate' }],
    ['updatePaymentMethod', (api: CatalogApi) => api.updatePaymentMethod('p3', { isActive: false }), '/payment-methods/p3', 'PATCH', { isActive: false }],
  ])('%s calls the documented route in the active wallet', async (_name, call, path, method, body) => {
    const { api, calls } = recordingClient()
    await call(api)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.path).toBe(path)
    expect(calls[0]?.options?.scopeToActiveWallet).toBeUndefined()
    expect(calls[0]?.options?.method).toBe(method)
    expect(calls[0]?.options?.body).toEqual(body)
  })

  it('encodes every identifier, so it cannot leave its route', async () => {
    const { api, calls } = recordingClient()
    await api.removeSubcategory('c/../1', 's?2')
    await api.updatePaymentMethod('p#3', { name: 'Pix' })
    expect(calls[0]?.path).toBe('/categories/c%2F..%2F1/subcategories/s%3F2')
    expect(calls[1]?.path).toBe('/payment-methods/p%233')
  })

  it('labels the current and the historical payment method natures', () => {
    expect(paymentMethodNatureLabel('credit_card')).toBe('Cartão de crédito')
    expect(paymentMethodNatureLabel('meal_benefit')).toBe('Vale-refeição (VR) · histórico')
  })
})
