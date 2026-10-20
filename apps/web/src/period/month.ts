export function getCurrentMonth() {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
}

export function shiftMonth(month: string, offset: number) {
  const [year, monthNumber] = month.split('-').map(Number)
  const shifted = new Date(year, monthNumber - 1 + offset, 1)
  return `${shifted.getFullYear()}-${String(shifted.getMonth() + 1).padStart(2, '0')}`
}

export function getMonthRange(month: string) {
  const [year, monthNumber] = month.split('-').map(Number)
  const lastDay = new Date(year, monthNumber, 0).getDate()
  return { from: `${month}-01`, to: `${month}-${String(lastDay).padStart(2, '0')}` }
}

export function formatMonth(month: string) {
  const [year, monthNumber] = month.split('-').map(Number)
  const formatted = new Intl.DateTimeFormat('pt-BR', { month: 'long', year: 'numeric' })
    .format(new Date(year, monthNumber - 1, 1))
  return formatted.charAt(0).toLocaleUpperCase('pt-BR') + formatted.slice(1)
}

export function isValidMonth(value: string) {
  const match = /^(\d{4})-(\d{2})$/.exec(value)
  if (!match) return false
  const monthNumber = Number(match[2])
  return monthNumber >= 1 && monthNumber <= 12
}
