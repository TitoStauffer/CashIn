import { withActiveWallet } from '../wallets/walletApi'

export type Income = {
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

export type IncomeInput = {
  amount: string
  date: string
  description?: string | null
  categoryId: string
  subcategoryId?: string | null
}

type IncomeListResponse = { items: Income[] }
type ErrorResponse = { message?: string }

export class IncomeApiError extends Error {
  readonly status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = 'IncomeApiError'
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
    throw new IncomeApiError(body?.message ?? '', response.status)
  }

  if (response.status === 204) return undefined as T
  return (await response.json()) as T
}

function incomePath(incomeId: string) {
  return `/incomes/${encodeURIComponent(incomeId)}`
}

export const incomesApi = {
  list(from: string, to: string, signal?: AbortSignal) {
    const query = new URLSearchParams({ from, to })
    return request<IncomeListResponse>(`/incomes?${query.toString()}`, { signal })
  },

  create(input: IncomeInput) {
    return request<Income>('/incomes', { method: 'POST', body: JSON.stringify(input) })
  },

  update(incomeId: string, input: IncomeInput) {
    return request<Income>(incomePath(incomeId), { method: 'PUT', body: JSON.stringify(input) })
  },

  remove(incomeId: string) {
    return request<void>(incomePath(incomeId), { method: 'DELETE' })
  },
}
