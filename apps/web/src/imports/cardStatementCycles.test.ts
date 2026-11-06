import { describe, expect, it } from 'vitest'
import { adjacentClosingDates, calculateClosingDate, calculateDueDate, isValidIsoDate } from './cardStatementCycles'

// These rules mirror apps/api/src/credit-cards/billing-cycle.ts. The API revalidates the chosen
// statement, so a divergence here would show the wrong option instead of persisting bad data —
// which is exactly why the boundaries are pinned on both sides.
describe('cardStatementCycles', () => {
  it('keeps a purchase made on the closing day in that statement', () => {
    expect(calculateClosingDate('2026-10-10', 10)).toBe('2026-10-10')
    expect(calculateClosingDate('2026-10-11', 10)).toBe('2026-11-10')
  })

  it('clamps closing days that do not exist in the month', () => {
    expect(calculateClosingDate('2026-02-28', 31)).toBe('2026-02-28')
    expect(calculateClosingDate('2028-02-29', 31)).toBe('2028-02-29')
    expect(calculateClosingDate('2026-03-01', 31)).toBe('2026-03-31')
  })

  it('moves the due date to the next month unless its day comes after closing', () => {
    expect(calculateDueDate('2026-10-10', 10, 20)).toBe('2026-10-20')
    expect(calculateDueDate('2026-10-10', 10, 5)).toBe('2026-11-05')
    // Same day as closing is not "after", so it rolls over.
    expect(calculateDueDate('2026-10-10', 10, 10)).toBe('2026-11-10')
    expect(calculateDueDate('2026-12-31', 31, 8)).toBe('2027-01-08')
    expect(calculateDueDate('2026-01-31', 31, 30)).toBe('2026-02-28')
  })

  it('offers the previous, calculated and next statements, including across short months and years', () => {
    expect(adjacentClosingDates('2026-10-11', 10)).toEqual(['2026-10-10', '2026-11-10', '2026-12-10'])
    expect(adjacentClosingDates('2028-01-15', 31)).toEqual(['2027-12-31', '2028-01-31', '2028-02-29'])
    expect(adjacentClosingDates('2026-03-01', 31)).toEqual(['2026-02-28', '2026-03-31', '2026-04-30'])
  })

  it('accepts only real ISO dates', () => {
    expect(isValidIsoDate('2026-02-28')).toBe(true)
    expect(isValidIsoDate('2026-02-30')).toBe(false)
    expect(isValidIsoDate('2026-2-8')).toBe(false)
    expect(isValidIsoDate('')).toBe(false)
  })
})
