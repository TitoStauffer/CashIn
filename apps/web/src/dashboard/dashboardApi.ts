import type { InvestmentGoal } from '../goals/goalsApi'
import type { IncomeBalanceType } from '../incomes/incomesApi'
import { createApiRequest } from '../api/request'

export type FinancialSummary = {
  incomeTotal: string
  expenseTotal: string
  contributionTotal: string
  cashIncomeTotal: string
  cashExpenseTotal: string
  creditPurchaseTotal: string
  // Refunds on a statement, already subtracted from the expense totals and from the category of the
  // purchase each one reverses. They are reported so the dashboard can say why the expense fell; the
  // unlinked share has no known purchase, so it lowered no category. An older API omits both.
  cardCreditTotal?: string
  unlinkedCardCreditTotal?: string
  cardPaymentTotal: string
  // Transfers between wallets are not income nor expense: they only move cash out of one wallet and
  // into another. An older API omits them, so the dashboard treats the absence as zero.
  transferOutTotal?: string
  transferInTotal?: string
  contributionsByGoal: { goalId: string; amount: string }[]
  availableBalance: string
  cashBalance: string
  benefitBalances: BenefitBalanceSummary[]
  incomeByCategory: CategorySummary[]
  expenseByCategory: CategorySummary[]
}

export type BenefitBalanceSummary = {
  balanceType: Exclude<IncomeBalanceType, 'cash'>
  amount: string
}

export type CategorySummary = {
  categoryId: string
  categoryName: string
  amount: string
}

type ItemsResponse<T> = { items: T[] }

export class DashboardApiError extends Error {
  readonly status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = 'DashboardApiError'
    this.status = status
  }
}

const request = createApiRequest(DashboardApiError)

export const dashboardApi = {
  summary(from: string, to: string, signal?: AbortSignal) {
    const params = new URLSearchParams({ from, to })
    return request<FinancialSummary>(`/financial-summary?${params.toString()}`, { signal })
  },
  goals(signal?: AbortSignal) {
    return request<ItemsResponse<InvestmentGoal>>('/investment-goals', { signal })
  },
}
