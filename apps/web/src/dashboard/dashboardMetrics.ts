import type { CategorySummary, FinancialSummary } from './dashboardApi'

export function amountToCents(amount: string) {
  const [integer, fraction = ''] = amount.split('.')
  const absolute = BigInt(integer.replace('-', '')) * 100n + BigInt(fraction.padEnd(2, '0'))
  return amount.startsWith('-') ? -absolute : absolute
}

export function centsToAmount(cents: bigint) {
  const absolute = cents < 0n ? -cents : cents
  return `${cents < 0n ? '-' : ''}${absolute / 100n}.${String(absolute % 100n).padStart(2, '0')}`
}

export function barPercentage(amount: bigint, maximum: bigint) {
  if (amount <= 0n || maximum <= 0n) return 0
  if (amount >= maximum) return 100
  return Number(amount * 1000n / maximum) / 10
}

export function topCategories(items: CategorySummary[]) {
  return [...items].sort((a, b) => {
    const difference = amountToCents(b.amount) - amountToCents(a.amount)
    if (difference === 0n) return a.categoryName.localeCompare(b.categoryName, 'pt-BR')
    return difference > 0n ? 1 : -1
  }).slice(0, 5)
}

export function cashOutflow(summary: FinancialSummary) {
  return amountToCents(summary.cashExpenseTotal) + amountToCents(summary.cardPaymentTotal) + amountToCents(summary.contributionTotal)
}

export function hasActivity(summary: FinancialSummary) {
  return [summary.incomeTotal, summary.expenseTotal, summary.contributionTotal, summary.cardPaymentTotal]
    .some((amount) => amountToCents(amount) !== 0n)
}

export function categoryChanges(current: CategorySummary[], previous: CategorySummary[]) {
  const categories = new Map(previous.map((item) => [item.categoryId, { ...item, previous: item.amount, amount: '0.00' }]))
  for (const item of current) categories.set(item.categoryId, { ...item, previous: categories.get(item.categoryId)?.previous ?? '0.00' })
  return [...categories.values()].map((item) => ({ ...item, difference: amountToCents(item.amount) - amountToCents(item.previous) }))
    .filter((item) => item.difference !== 0n)
    .sort((a, b) => {
      const absoluteA = a.difference < 0n ? -a.difference : a.difference
      const absoluteB = b.difference < 0n ? -b.difference : b.difference
      if (absoluteA === absoluteB) return a.categoryName.localeCompare(b.categoryName, 'pt-BR')
      return absoluteB > absoluteA ? 1 : -1
    }).slice(0, 5)
}
