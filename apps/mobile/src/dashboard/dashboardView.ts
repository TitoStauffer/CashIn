import { compareAmounts, isZeroAmount } from '../money/amount'
import type { CategorySummary, FinancialSummary } from './dashboardApi'

/**
 * Presentation of the summary only: these functions order, pick and format what the API sent and never
 * add, subtract or derive an amount. Every number on the dashboard is one the API returned.
 */

/** The five largest categories, by amount and then name, exactly as the API valued them. */
export function topCategories(items: CategorySummary[], limit = 5): CategorySummary[] {
  return [...items]
    .sort((a, b) => compareAmounts(b.amount, a.amount) || a.categoryName.localeCompare(b.categoryName, 'pt-BR'))
    .slice(0, limit)
}

/**
 * Whether the month had any movement. Refunds count: the expense total arrives net of them, so a month
 * whose refunds cancel its purchases shows a zero expense and still had activity.
 */
export function hasActivity(summary: FinancialSummary): boolean {
  return [
    summary.incomeTotal,
    summary.expenseTotal,
    summary.contributionTotal,
    summary.cardPaymentTotal,
    summary.transferOutTotal ?? '0.00',
    summary.transferInTotal ?? '0.00',
    summary.cardCreditTotal ?? '0.00',
  ].some((amount) => !isZeroAmount(amount))
}

/** What the period added to a goal; a goal without an item had no contribution in the period. */
export function goalContribution(summary: FinancialSummary, goalId: string): string {
  return summary.contributionsByGoal.find((item) => item.goalId === goalId)?.amount ?? '0.00'
}

/** The API's progress percentage, written the Brazilian way with at most one decimal place. */
export function formatPercentage(value: number): string {
  return `${(Math.round(value * 10) / 10).toString().replace('.', ',')}%`
}
