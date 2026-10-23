import { afterEach, describe, expect, it } from 'vitest'
import { getCurrentMonth } from './month'
import { getInitialMonth, getLinkedMonth, recordLink } from './recordLinks'

afterEach(() => window.history.replaceState({}, '', '/'))

describe('period links', () => {
  it('reads only valid month filters and defaults to the current month', () => {
    window.history.replaceState({}, '', '/incomes?month=2026-02')
    expect(getLinkedMonth()).toBe('2026-02')
    expect(getInitialMonth()).toBe('2026-02')
    window.history.replaceState({}, '', '/incomes?month=2026-13')
    expect(getLinkedMonth()).toBeNull()
    expect(getInitialMonth()).toBe(getCurrentMonth())
    window.history.replaceState({}, '', '/incomes')
    expect(getLinkedMonth()).toBeNull()
  })
  it('encodes category identifiers and preserves the month', () => {
    expect(recordLink('/expenses', '2026-10', { categoryId: 'category&x' })).toBe('/expenses?month=2026-10&categoryId=category%26x')
    expect(recordLink('/goals', '2026-10')).toBe('/goals?month=2026-10')
  })
})
