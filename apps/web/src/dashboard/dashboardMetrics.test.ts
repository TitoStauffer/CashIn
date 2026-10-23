import { describe, expect, it } from 'vitest'
import { amountToCents, barPercentage, categoryChanges, centsToAmount, topCategories } from './dashboardMetrics'

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
})
