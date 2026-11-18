/**
 * Months ("2026-11") and days ("2026-11-18") as the API filters and stores them. Month names are a fixed
 * list instead of `Intl`, whose month names depend on the phone's language data.
 */

const MONTH_NAMES = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro']

export const DATE_INVALID = 'Informe a data no formato DD/MM/AAAA.'

const pad = (value: number) => String(value).padStart(2, '0')

function parts(month: string): [number, number] {
  const match = /^(\d{4})-(\d{2})$/.exec(month)
  if (!match) throw new Error(`Invalid month: ${month}`)
  return [Number(match[1]), Number(match[2])]
}

export function monthOf(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}`
}

export function todayIso(now: Date = new Date()): string {
  return `${monthOf(now)}-${pad(now.getDate())}`
}

export function shiftMonth(month: string, offset: number): string {
  const [year, monthNumber] = parts(month)
  return monthOf(new Date(year, monthNumber - 1 + offset, 1))
}

/** The inclusive `from`/`to` filter of a month, with its real last day. */
export function monthRange(month: string): { from: string; to: string } {
  const [year, monthNumber] = parts(month)
  const lastDay = new Date(year, monthNumber, 0).getDate()
  return { from: `${month}-01`, to: `${month}-${pad(lastDay)}` }
}

export function monthLabel(month: string): string {
  const [year, monthNumber] = parts(month)
  return `${MONTH_NAMES[monthNumber - 1] ?? month} de ${year}`
}

/** "18/11/2026" → "2026-11-18", or null when it is not a real day of the calendar. */
export function parseDateInput(text: string): string | null {
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(text.trim())
  if (!match) return null
  const [day, month, year] = [Number(match[1]), Number(match[2]), Number(match[3])]
  const date = new Date(year, month - 1, day)
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null
  return `${match[3]}-${match[2]}-${match[1]}`
}

/** "2026-11-18" → "18/11/2026". */
export function formatDate(iso: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso)
  return match ? `${match[3]}/${match[2]}/${match[1]}` : iso
}
