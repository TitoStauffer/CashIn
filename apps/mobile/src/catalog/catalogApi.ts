import type { ApiClient } from '../api/client'

export type CategoryNature = 'income' | 'expense' | 'investment' | 'investment_goal'
export type Subcategory = { id: string; name: string; categoryId: string }
export type Category = { id: string; name: string; nature: CategoryNature; subcategories: Subcategory[] }

export type PaymentMethodNature =
  | 'immediate'
  | 'credit_card'
  | 'food_benefit'
  | 'meal_benefit'
  | 'food_meal_benefit'
  | 'home_office_benefit'
export type PaymentMethod = { id: string; name: string; nature: PaymentMethodNature; isActive: boolean }

const path = (...segments: string[]) =>
  segments.map((segment, index) => (index % 2 === 0 ? segment : encodeURIComponent(segment))).join('/')

/**
 * The category and payment method routes of `docs/api.md`. All of them belong to the active wallet, so
 * every call keeps the default `X-Wallet-Id` scope. Payment methods are never deleted by the API: they
 * are deactivated, which keeps the history of the expenses that used them.
 */
export function createCatalogApi(request: ApiClient) {
  return {
    listCategories: (nature: CategoryNature) =>
      request<{ items: Category[] }>(`/categories?nature=${encodeURIComponent(nature)}`),
    createCategory: (name: string, nature: CategoryNature) =>
      request<Category>('/categories', { method: 'POST', body: { name, nature } }),
    renameCategory: (categoryId: string, name: string) =>
      request<Category>(path('/categories', categoryId), { method: 'PATCH', body: { name } }),
    removeCategory: (categoryId: string) =>
      request<void>(path('/categories', categoryId), { method: 'DELETE' }),
    createSubcategory: (categoryId: string, name: string) =>
      request<Subcategory>(path('/categories', categoryId, 'subcategories'), { method: 'POST', body: { name } }),
    renameSubcategory: (categoryId: string, subcategoryId: string, name: string) =>
      request<Subcategory>(path('/categories', categoryId, 'subcategories', subcategoryId), { method: 'PATCH', body: { name } }),
    removeSubcategory: (categoryId: string, subcategoryId: string) =>
      request<void>(path('/categories', categoryId, 'subcategories', subcategoryId), { method: 'DELETE' }),

    listPaymentMethods: () => request<{ items: PaymentMethod[] }>('/payment-methods'),
    createPaymentMethod: (name: string, nature: PaymentMethodNature) =>
      request<PaymentMethod>('/payment-methods', { method: 'POST', body: { name, nature } }),
    updatePaymentMethod: (paymentMethodId: string, changes: { name?: string; nature?: PaymentMethodNature; isActive?: boolean }) =>
      request<PaymentMethod>(path('/payment-methods', paymentMethodId), { method: 'PATCH', body: changes }),
  }
}

export type CatalogApi = ReturnType<typeof createCatalogApi>

export const CATEGORY_NATURES: { value: CategoryNature; label: string }[] = [
  { value: 'income', label: 'Entradas' },
  { value: 'expense', label: 'Saídas' },
  { value: 'investment', label: 'Metas de investimento' },
  { value: 'investment_goal', label: 'Metas de investimento (legado)' },
]

/** The natures a new or edited payment method can take; VA and VR share one benefit balance. */
export const PAYMENT_METHOD_NATURES: { value: PaymentMethodNature; label: string }[] = [
  { value: 'immediate', label: 'Imediata (dinheiro, débito ou Pix)' },
  { value: 'credit_card', label: 'Cartão de crédito' },
  { value: 'food_meal_benefit', label: 'Cartão de benefícios (VA/VR)' },
  { value: 'home_office_benefit', label: 'Auxílio home office (AHO)' },
]

export function paymentMethodNatureLabel(nature: PaymentMethodNature): string {
  if (nature === 'food_benefit') return 'Vale-alimentação (VA) · histórico'
  if (nature === 'meal_benefit') return 'Vale-refeição (VR) · histórico'
  return PAYMENT_METHOD_NATURES.find((item) => item.value === nature)?.label ?? ''
}
