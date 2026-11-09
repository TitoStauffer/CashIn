import { createApiRequest } from '../api/request'

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
  paymentMethodNature: import('../paymentMethods/paymentMethodsApi').PaymentMethodNature | null
  creditCardId?: string | null
  creditCardStatementId?: string | null
  creditCardName?: string | null
  createdAt: string
  updatedAt: string
}

export type ExpenseInput = {
  amount: string
  date: string
  description?: string | null
  categoryId: string
  subcategoryId?: string | null
  paymentMethodId?: string | null
  creditCardId?: string | null
}

type ExpenseListResponse = { items: Expense[] }

export class ExpenseApiError extends Error {
  readonly status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = 'ExpenseApiError'
    this.status = status
  }
}

const request = createApiRequest(ExpenseApiError)

function expensePath(expenseId: string) {
  return `/expenses/${encodeURIComponent(expenseId)}`
}

export const expensesApi = {
  list(from: string, to: string, signal?: AbortSignal) {
    const query = new URLSearchParams({ from, to })
    return request<ExpenseListResponse>(`/expenses?${query.toString()}`, { signal })
  },

  create(input: ExpenseInput) {
    return request<Expense>('/expenses', { method: 'POST', body: JSON.stringify(input) })
  },

  update(expenseId: string, input: ExpenseInput) {
    return request<Expense>(expensePath(expenseId), { method: 'PUT', body: JSON.stringify(input) })
  },

  remove(expenseId: string) {
    return request<void>(expensePath(expenseId), { method: 'DELETE' })
  },
}
