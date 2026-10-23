import { getCurrentMonth, isValidMonth } from './month'

export function getLinkedMonth() {
  const month = new URLSearchParams(window.location.search).get('month')
  return month && isValidMonth(month) ? month : null
}

export function getInitialMonth() {
  return getLinkedMonth() ?? getCurrentMonth()
}

export function recordLink(path: string, month: string, filters: Record<string, string> = {}) {
  return `${path}?${new URLSearchParams({ month, ...filters })}`
}
