import type { ApiClient } from '../api/client'

export type CategorySummary = { categoryId: string; categoryName: string; amount: string }
export type BenefitBalance = { balanceType: 'food_meal_benefit' | 'home_office_benefit' | 'food_benefit' | 'meal_benefit'; amount: string }

/** `GET /financial-summary`, as `docs/dashboard-summary-contract.md` describes it. Every amount is a decimal string. */
export type FinancialSummary = {
  incomeTotal: string
  expenseTotal: string
  contributionTotal: string
  cashIncomeTotal: string
  cashExpenseTotal: string
  creditPurchaseTotal: string
  cardCreditTotal?: string
  unlinkedCardCreditTotal?: string
  cardPaymentTotal: string
  transferOutTotal?: string
  transferInTotal?: string
  contributionsByGoal: { goalId: string; amount: string }[]
  cashBalance: string
  availableBalance: string
  benefitBalances: BenefitBalance[]
  incomeByCategory: CategorySummary[]
  expenseByCategory: CategorySummary[]
}

export type InvestmentGoal = {
  id: string
  title: string
  targetAmount: string
  dueDate: string | null
  status: 'active' | 'closed'
  contributedAmount: string
  progressPercentage: number
}

/** The dashboard reads, in the active wallet: the summary of a period and the investment goals. */
export function createDashboardApi(request: ApiClient) {
  return {
    summary: (from: string, to: string) =>
      request<FinancialSummary>(`/financial-summary?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`),
    goals: () => request<{ items: InvestmentGoal[] }>('/investment-goals'),
  }
}

export type DashboardApi = ReturnType<typeof createDashboardApi>
