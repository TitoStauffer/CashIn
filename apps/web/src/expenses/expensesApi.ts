import { withActiveWallet } from '../wallets/walletApi'

export type Expense = {
  id: string
  amount: string
  date: string
  description: string | null
  categoryId: string
  categoryName: string
  subcategoryId: string | null
  subcategoryName: string | null
  createdAt: string
  updatedAt: string
}

export type ExpenseInput = {
  amount: string
  date: string
  description?: string | null
  categoryId: string
  subcategoryId?: string | null
}

type ExpenseListResponse = { items: Expense[] }
type ErrorResponse = { message?: string }

export class ExpenseApiError extends Error {
  readonly status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = 'ExpenseApiError'
    this.status = status
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`/api${path}`, withActiveWallet({
    ...init,
    credentials: 'include',
    headers: {
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...init.headers,
    },
  }))

  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as ErrorResponse | null
    throw new ExpenseApiError(body?.message ?? '', response.status)
  }

  if (response.status === 204) return undefined as T
  return (await response.json()) as T
}

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
