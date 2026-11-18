import type { FinancialSummary } from './dashboardApi'
import { formatPercentage, goalContribution, hasActivity, topCategories } from './dashboardView'

const EMPTY: FinancialSummary = {
  incomeTotal: '0.00',
  expenseTotal: '0.00',
  contributionTotal: '0.00',
  cashIncomeTotal: '0.00',
  cashExpenseTotal: '0.00',
  creditPurchaseTotal: '0.00',
  cardCreditTotal: '0.00',
  unlinkedCardCreditTotal: '0.00',
  cardPaymentTotal: '0.00',
  transferOutTotal: '0.00',
  transferInTotal: '0.00',
  contributionsByGoal: [],
  cashBalance: '0.00',
  availableBalance: '0.00',
  benefitBalances: [],
  incomeByCategory: [],
  expenseByCategory: [],
}

describe('dashboardView', () => {
  it('keeps the five largest categories, ties by name, without touching the amounts', () => {
    const items = ['10.00', '200', '35.50', '35.50', '-4.00', '99.99'].map((amount, index) => ({ categoryId: `c${index}`, categoryName: `Cat ${'FEDCBA'[index]}`, amount }))
    expect(topCategories(items).map((item) => `${item.categoryName}=${item.amount}`)).toEqual([
      'Cat E=200',
      'Cat A=99.99',
      'Cat C=35.50',
      'Cat D=35.50',
      'Cat F=10.00',
    ])
  })

  it('sees activity in any total, refunds included, and none in an empty month', () => {
    expect(hasActivity(EMPTY)).toBe(false)
    expect(hasActivity({ ...EMPTY, cardCreditTotal: '4.00' })).toBe(true)
    expect(hasActivity({ ...EMPTY, transferInTotal: '50.00' })).toBe(true)
    expect(hasActivity({ ...EMPTY, contributionTotal: '20.00' })).toBe(true)
  })

  it('takes the period contribution of a goal from the summary, zero when absent', () => {
    const summary = { ...EMPTY, contributionsByGoal: [{ goalId: 'g1', amount: '20.00' }] }
    expect(goalContribution(summary, 'g1')).toBe('20.00')
    expect(goalContribution(summary, 'g2')).toBe('0.00')
  })

  it('writes the progress the Brazilian way', () => {
    expect(formatPercentage(42.35)).toBe('42,4%')
    expect(formatPercentage(100)).toBe('100%')
  })
})
