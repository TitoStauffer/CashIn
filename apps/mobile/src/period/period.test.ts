import { formatDate, monthLabel, monthOf, monthRange, parseDateInput, shiftMonth, todayIso } from './period'

describe('period', () => {
  it('names the month in Portuguese without depending on the phone', () => {
    expect(monthLabel('2026-03')).toBe('Março de 2026')
    expect(monthLabel('2026-12')).toBe('Dezembro de 2026')
  })

  it('moves across years', () => {
    expect(shiftMonth('2026-01', -1)).toBe('2025-12')
    expect(shiftMonth('2026-12', 1)).toBe('2027-01')
  })

  it('filters a month by its real last day, leap years included', () => {
    expect(monthRange('2026-11')).toEqual({ from: '2026-11-01', to: '2026-11-30' })
    expect(monthRange('2028-02')).toEqual({ from: '2028-02-01', to: '2028-02-29' })
    expect(monthRange('2026-02')).toEqual({ from: '2026-02-01', to: '2026-02-28' })
  })

  it('knows today and its month', () => {
    const now = new Date(2026, 10, 8)
    expect(todayIso(now)).toBe('2026-11-08')
    expect(monthOf(now)).toBe('2026-11')
  })

  it('reads a typed date only when it is a real day', () => {
    expect(parseDateInput(' 18/11/2026 ')).toBe('2026-11-18')
    expect(parseDateInput('29/02/2028')).toBe('2028-02-29')
    expect(parseDateInput('29/02/2026')).toBeNull()
    expect(parseDateInput('31/04/2026')).toBeNull()
    expect(parseDateInput('2026-11-18')).toBeNull()
    expect(parseDateInput('1/11/2026')).toBeNull()
  })

  it('shows a stored day the Brazilian way', () => {
    expect(formatDate('2026-11-18')).toBe('18/11/2026')
  })
})
