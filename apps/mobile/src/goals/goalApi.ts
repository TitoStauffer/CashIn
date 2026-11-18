import type { ApiClient } from '../api/client'

export type Goal = {
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
  /** Derived by the API from the current contributions; the app never adds them up. */
  contributedAmount: string
  progressPercentage: number
}

export type GoalInput = {
  title: string
  description: string
  targetAmount: string
  dueDate: string | null
  categoryId: string | null
  subcategoryId: string | null
}

export type Contribution = { id: string; amount: string; date: string; description: string | null }
export type ContributionInput = { amount: string; date: string; description: string | null }

/**
 * The investment goal routes of `docs/api.md`, in the active wallet. `PUT` replaces every editable
 * field. A closed goal stays readable, and the API answers 409 to any change to it or its contributions.
 */
export function createGoalApi(request: ApiClient) {
  const goal = (goalId: string) => `/investment-goals/${encodeURIComponent(goalId)}`
  return {
    list: () => request<{ items: Goal[] }>('/investment-goals'),
    create: (input: GoalInput) => request<Goal>('/investment-goals', { method: 'POST', body: input }),
    update: (goalId: string, input: GoalInput) => request<Goal>(goal(goalId), { method: 'PUT', body: input }),
    close: (goalId: string) => request<Goal>(`${goal(goalId)}/close`, { method: 'POST' }),
    listContributions: (goalId: string) => request<{ items: Contribution[] }>(`${goal(goalId)}/contributions`),
    createContribution: (goalId: string, input: ContributionInput) =>
      request<Contribution>(`${goal(goalId)}/contributions`, { method: 'POST', body: input }),
    removeContribution: (goalId: string, contributionId: string) =>
      request<void>(`${goal(goalId)}/contributions/${encodeURIComponent(contributionId)}`, { method: 'DELETE' }),
  }
}

export type GoalApi = ReturnType<typeof createGoalApi>
