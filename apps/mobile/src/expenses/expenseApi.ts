import type { ApiClient } from '../api/client'
import type { PaymentMethodNature } from '../catalog/catalogApi'

export type Expense = {
  id: string
  amount: string
  date: string
  description: string | null
  categoryId: string
  categoryName: string
  subcategoryId: string | null
  subcategoryName: string | null
  paymentMethodId: string | null
  paymentMethodName: string | null
  paymentMethodNature: PaymentMethodNature | null
  creditCardId: string | null
  creditCardName: string | null
}

export type ExpenseInput = {
  amount: string
  date: string
  description: string | null
  categoryId: string
  subcategoryId: string | null
  paymentMethodId: string | null
  creditCardId: string | null
}

export type CreditCard = { id: string; nickname: string; closingDay: number; dueDay: number; isActive: boolean }

/**
 * The expense routes of `docs/api.md`, plus the card list a credit purchase needs, all in the active
 * wallet. The amount travels as the decimal string the person typed. The API requires the card when the
 * payment method is a credit card and refuses it otherwise; a purchase in a paid statement cannot be
 * changed or removed. Card management itself belongs to the Mobile 2 epic.
 */
export function createExpenseApi(request: ApiClient) {
  const path = (expenseId: string) => `/expenses/${encodeURIComponent(expenseId)}`
  return {
    list: (from: string, to: string) =>
      request<{ items: Expense[] }>(`/expenses?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`),
    create: (input: ExpenseInput) => request<Expense>('/expenses', { method: 'POST', body: input }),
    update: (expenseId: string, input: ExpenseInput) => request<Expense>(path(expenseId), { method: 'PUT', body: input }),
    remove: (expenseId: string) => request<void>(path(expenseId), { method: 'DELETE' }),
    listCreditCards: () => request<{ items: CreditCard[] }>('/credit-cards'),
  }
}

export type ExpenseApi = ReturnType<typeof createExpenseApi>

/** Which balance an expense paid with this nature reduces, as the API computes it. */
export function balanceDebitedBy(nature: PaymentMethodNature | null): string {
  if (nature === 'food_meal_benefit' || nature === 'food_benefit' || nature === 'meal_benefit') return 'Reduz o saldo do cartão de benefícios (VA/VR).'
  if (nature === 'home_office_benefit') return 'Reduz o saldo do auxílio home office (AHO).'
  if (nature === 'credit_card') return 'Entra na fatura do cartão escolhido.'
  return 'Reduz o saldo em dinheiro.'
}
