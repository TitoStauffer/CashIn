export type InvestmentContribution = {
  id: string
  amount: string
  date: string
  description: string | null
}

export type InvestmentGoal = {
  id: string
  title: string
  description: string
  targetAmount: string
  dueDate: string | null
  status: 'active' | 'closed'
  categoryId: string | null
  categoryName: string | null
  subcategoryId: string | null
  subcategoryName: string | null
  contributedAmount: string
  progressPercentage: number
}

export type InvestmentGoalInput = {
  title: string
  description: string
  targetAmount: string
  dueDate?: string | null
  categoryId?: string | null
  subcategoryId?: string | null
}

export type InvestmentContributionInput = {
  amount: string
  date: string
  description?: string | null
}

type ItemsResponse<T> = { items: T[] }
type ErrorResponse = { message?: string }

export class GoalApiError extends Error {
  readonly status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = 'GoalApiError'
    this.status = status
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`/api${path}`, {
    ...init,
    credentials: 'include',
    headers: {
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...init.headers,
    },
  })

  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as ErrorResponse | null
    throw new GoalApiError(body?.message ?? '', response.status)
  }

  if (response.status === 204) return undefined as T
  return (await response.json()) as T
}

const goalsPath = '/investment-goals'
const goalPath = (goalId: string) => `${goalsPath}/${encodeURIComponent(goalId)}`
const contributionsPath = (goalId: string) => `${goalPath(goalId)}/contributions`

export const goalsApi = {
  list(signal?: AbortSignal) {
    return request<ItemsResponse<InvestmentGoal>>(goalsPath, { signal })
  },
  create(input: InvestmentGoalInput) {
    return request<InvestmentGoal>(goalsPath, { method: 'POST', body: JSON.stringify(input) })
  },
  update(goalId: string, input: InvestmentGoalInput) {
    return request<InvestmentGoal>(goalPath(goalId), { method: 'PUT', body: JSON.stringify(input) })
  },
  close(goalId: string) {
    return request<InvestmentGoal>(`${goalPath(goalId)}/close`, { method: 'POST' })
  },
  contributions(goalId: string, signal?: AbortSignal) {
    return request<ItemsResponse<InvestmentContribution>>(contributionsPath(goalId), { signal })
  },
  createContribution(goalId: string, input: InvestmentContributionInput) {
    return request<InvestmentContribution>(contributionsPath(goalId), {
      method: 'POST', body: JSON.stringify(input),
    })
  },
  updateContribution(goalId: string, contributionId: string, input: InvestmentContributionInput) {
    return request<InvestmentContribution>(`${contributionsPath(goalId)}/${encodeURIComponent(contributionId)}`, {
      method: 'PUT', body: JSON.stringify(input),
    })
  },
  removeContribution(goalId: string, contributionId: string) {
    return request<void>(`${contributionsPath(goalId)}/${encodeURIComponent(contributionId)}`, { method: 'DELETE' })
  },
}
