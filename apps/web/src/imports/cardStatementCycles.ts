// Mirrors apps/api/src/credit-cards/billing-cycle.ts so the preview offers exactly the statements
// the API accepts for a card item: the previous, the calculated and the next one.

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate()
}

function dateForDay(year: number, month: number, day: number): string {
  const normalizedYear = year + Math.floor(month / 12)
  const normalizedMonth = ((month % 12) + 12) % 12
  const boundedDay = Math.min(day, daysInMonth(normalizedYear, normalizedMonth))
  return new Date(Date.UTC(normalizedYear, normalizedMonth, boundedDay)).toISOString().slice(0, 10)
}

function splitDate(value: string): [number, number] {
  const [year, month] = value.split('-').map(Number)
  return [year, month - 1]
}

export function calculateDueDate(closingDate: string, closingDay: number, dueDay: number): string {
  const [year, month] = splitDate(closingDate)
  return dateForDay(year, dueDay > closingDay ? month : month + 1, dueDay)
}

export function calculateClosingDate(purchaseDate: string, closingDay: number): string {
  const [year, month] = splitDate(purchaseDate)
  const currentClosingDate = dateForDay(year, month, closingDay)
  return purchaseDate <= currentClosingDate ? currentClosingDate : dateForDay(year, month + 1, closingDay)
}

export function adjacentClosingDates(purchaseDate: string, closingDay: number): string[] {
  const [year, month] = splitDate(calculateClosingDate(purchaseDate, closingDay))
  return [dateForDay(year, month - 1, closingDay), dateForDay(year, month, closingDay), dateForDay(year, month + 1, closingDay)]
}

export function isValidIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const date = new Date(`${value}T00:00:00.000Z`)
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
}
