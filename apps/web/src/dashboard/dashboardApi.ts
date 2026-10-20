import type { InvestmentGoal } from '../goals/goalsApi'

export type FinancialSummary = {
  incomeTotal: string
  expenseTotal: string
  contributionTotal: string
  availableBalance: string
}

type ItemsResponse<T> = { items: T[] }
type ErrorResponse = { message?: string }

export class DashboardApiError extends Error {
  readonly status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = 'DashboardApiError'
    this.status = status
  }
}

async function request<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`/api${path}`, { credentials: 'include', signal })
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as ErrorResponse | null
    throw new DashboardApiError(body?.message ?? '', response.status)
  }
  return (await response.json()) as T
}

export const dashboardApi = {
  summary(from: string, to: string, signal?: AbortSignal) {
    const params = new URLSearchParams({ from, to })
    return request<FinancialSummary>(`/financial-summary?${params.toString()}`, signal)
  },
  goals(signal?: AbortSignal) {
    return request<ItemsResponse<InvestmentGoal>>('/investment-goals', signal)
  },
}
