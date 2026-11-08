import { describe, expect, it } from 'vitest'
import { amountToCents, barPercentage, cashInflow, cashOutflow, categoryChanges, centsToAmount, hasActivity, topCategories, transferInflow } from './dashboardMetrics'

describe('dashboard exact calculations', () => {
  it('preserves signed cent values beyond the safe integer limit', () => {
    expect(amountToCents('9007199254740993.01') + amountToCents('0.02')).toBe(900719925474099303n)
    expect(centsToAmount(-1n)).toBe('-0.01')
    expect(amountToCents('-0.01')).toBe(-1n)
    expect(amountToCents('-12.3')).toBe(-1230n)
    expect(amountToCents('12')).toBe(1200n)
    expect(centsToAmount(0n)).toBe('0.00')
    expect(centsToAmount(900719925474099303n)).toBe('9007199254740993.03')
  })

  it('scales only bounded chart percentages and handles zero denominators', () => {
    expect(barPercentage(0n, 10n)).toBe(0)
    expect(barPercentage(-1n, 10n)).toBe(0)
    expect(barPercentage(1n, 0n)).toBe(0)
    expect(barPercentage(20n, 10n)).toBe(100)
    expect(barPercentage(900719925474099301n, 9007199254740993010n)).toBe(10)
    expect(barPercentage(1n, 3n)).toBe(33.3)
  })

  it('sorts totals numerically without mutating the API array', () => {
    const items = [{ categoryId: 'a', categoryName: 'A', amount: '9.00' }, { categoryId: 'b', categoryName: 'B', amount: '10.00' }]
    expect(topCategories(items).map((item) => item.categoryId)).toEqual(['b', 'a'])
    expect(items[0].categoryId).toBe('a')
    expect(topCategories([])).toEqual([])
  })

  it('compares new, removed and unchanged categories using exact absolute differences', () => {
    const previous = [{ categoryId: 'removed', categoryName: 'Antiga', amount: '50.01' }, { categoryId: 'same', categoryName: 'Igual', amount: '10.00' }]
    const current = [{ categoryId: 'new', categoryName: 'Nova', amount: '60.00' }, { categoryId: 'same', categoryName: 'Igual', amount: '10.00' }, { categoryId: 'tie', categoryName: 'Outra', amount: '50.01' }, { categoryId: 'largest', categoryName: 'Maior', amount: '1000.00' }]
    expect(categoryChanges(current, previous).map((item) => [item.categoryId, item.previous, item.amount, item.difference])).toEqual([
      ['largest', '0.00', '1000.00', 100000n], ['new', '0.00', '60.00', 6000n], ['removed', '50.01', '0.00', -5001n], ['tie', '0.00', '50.01', 5001n],
    ])
  })
  it('moves transfers between wallets through the cash flow without touching income or expense', () => {
    const summary = {
      incomeTotal: '0.00', expenseTotal: '0.00', contributionTotal: '0.00',
      cashIncomeTotal: '100.00', cashExpenseTotal: '0.00', creditPurchaseTotal: '0.00', cardPaymentTotal: '0.00',
      transferOutTotal: '500.00', transferInTotal: '80.00',
      contributionsByGoal: [], availableBalance: '-320.00', cashBalance: '-320.00',
      benefitBalances: [], incomeByCategory: [], expenseByCategory: [],
    }

    // What left the wallet joins the outflow and what arrived joins the inflow, so the two sides of a
    // transfer appear where the money actually moved.
    expect(cashOutflow(summary)).toBe(50000n)
    expect(cashInflow(summary)).toBe(18000n)
    expect(transferInflow(summary)).toBe(8000n)
    // A wallet whose only activity is a transfer still has activity to show.
    expect(hasActivity({ ...summary, cashIncomeTotal: '0.00', transferInTotal: '0.00' })).toBe(true)
  })

  // A month whose refunds cancel its purchases exactly has a zero expense and still had movement:
  // a purchase and a refund. Calling it empty would contradict the refund line shown right below.
  it('counts a month whose refunds cancel its purchases as having movement', () => {
    const summary = {
      incomeTotal: '0.00', expenseTotal: '0.00', contributionTotal: '0.00',
      cashIncomeTotal: '0.00', cashExpenseTotal: '0.00', creditPurchaseTotal: '0.00', cardPaymentTotal: '0.00',
      transferOutTotal: '0.00', transferInTotal: '0.00',
      cardCreditTotal: '30.00', unlinkedCardCreditTotal: '0.00',
      contributionsByGoal: [], availableBalance: '0.00', cashBalance: '0.00',
      benefitBalances: [], incomeByCategory: [], expenseByCategory: [],
    }

    expect(hasActivity(summary)).toBe(true)
    // Without any refund the same all-zero month is empty, which is what the state is for.
    expect(hasActivity({ ...summary, cardCreditTotal: '0.00' })).toBe(false)
    // An older API that omits the field is read as zero, like the transfer totals.
    expect(hasActivity({ ...summary, cardCreditTotal: undefined })).toBe(false)
  })

  it('treats an older API without transfer totals as zero', () => {
    const summary = {
      incomeTotal: '0.00', expenseTotal: '0.00', contributionTotal: '0.00',
      cashIncomeTotal: '100.00', cashExpenseTotal: '10.00', creditPurchaseTotal: '0.00', cardPaymentTotal: '0.00',
      contributionsByGoal: [], availableBalance: '90.00', cashBalance: '90.00',
      benefitBalances: [], incomeByCategory: [], expenseByCategory: [],
    }

    expect(cashOutflow(summary)).toBe(1000n)
    expect(cashInflow(summary)).toBe(10000n)
    expect(hasActivity(summary)).toBe(false)
  })
})
