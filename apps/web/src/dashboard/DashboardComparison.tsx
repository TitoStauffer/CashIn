import type { CategorySummary, FinancialSummary } from './dashboardApi'
import { amountToCents, categoryChanges, centsToAmount, hasActivity } from './dashboardMetrics'
import { formatBrazilianCurrency as money } from '../money/currency'
import { formatMonth, shiftMonth } from '../period/month'
import { recordLink } from '../period/recordLinks'

function changeLabel(current: string, previous: string) {
  const difference = amountToCents(current) - amountToCents(previous)
  if (difference === 0n) return 'Sem alteração'
  return `${money(centsToAmount(difference < 0n ? -difference : difference))} ${difference > 0n ? 'a mais' : 'a menos'}`
}

function CategoryComparison({ current, previous, month, tone }: { current: CategorySummary[]; previous: CategorySummary[]; month: string; tone: 'income' | 'expense' }) {
  const changes = categoryChanges(current, previous)
  if (changes.length === 0) return null
  const path = tone === 'income' ? '/incomes' : '/expenses'
  return <section className="dashboard-category-comparison" aria-label={`Variações de ${tone === 'income' ? 'entradas' : 'despesas'} por categoria`}>
    <h3>Maiores variações de {tone === 'income' ? 'entradas' : 'despesas'} por categoria</h3>
    <ul>{changes.map((item) => <li key={item.categoryId}>
      <strong>{item.categoryName}: {changeLabel(item.amount, item.previous)}</strong>
      <span><a href={recordLink(path, shiftMonth(month, -1), { categoryId: item.categoryId })}>Anterior: {money(item.previous)}</a>{' → '}<a href={recordLink(path, month, { categoryId: item.categoryId })}>Selecionado: {money(item.amount)}</a></span>
    </li>)}</ul>
  </section>
}

export function DashboardComparison({ current, previous, month }: { current: FinancialSummary; previous: FinancialSummary; month: string }) {
  const rows = [
    { title: 'Entradas totais', current: current.incomeTotal, previous: previous.incomeTotal, path: '/incomes' },
    { title: 'Despesas registradas', current: current.expenseTotal, previous: previous.expenseTotal, path: '/expenses' },
    { title: 'Aportes', current: current.contributionTotal, previous: previous.contributionTotal, path: '/goals' },
    { title: 'Fluxo restante em dinheiro', current: current.cashBalance, previous: previous.cashBalance, path: '/dashboard' },
  ]
  return <section className="dashboard-panel dashboard-comparison" aria-labelledby="comparison-title">
    <div className="dashboard-panel__heading"><div><p className="dashboard-eyebrow">EVOLUÇÃO REGISTRADA</p><h2 id="comparison-title">Comparação com o mês anterior</h2></div></div>
    <p>{formatMonth(shiftMonth(month, -1))} → {formatMonth(month)}. Os filtros abrangem cada mês completo; os totais refletem os registros disponíveis, sem projeção.</p>
    {!hasActivity(current) || !hasActivity(previous) ? <p className="dashboard-comparison__empty">Comparação indisponível: um dos meses não tem movimentações registradas.</p> : <>
      <div className="dashboard-comparison__table"><table><caption>Valores registrados por período</caption><thead><tr><th scope="col">Indicador</th><th scope="col">Mês anterior</th><th scope="col">Mês selecionado</th><th scope="col">Variação</th></tr></thead><tbody>{rows.map((row) => <tr key={row.title}><th scope="row">{row.title}</th><td><a href={recordLink(row.path, shiftMonth(month, -1))}>{money(row.previous)}</a></td><td><a href={recordLink(row.path, month)}>{money(row.current)}</a></td><td>{changeLabel(row.current, row.previous)}</td></tr>)}</tbody></table></div>
      <CategoryComparison current={current.incomeByCategory} previous={previous.incomeByCategory} month={month} tone="income" />
      <CategoryComparison current={current.expenseByCategory} previous={previous.expenseByCategory} month={month} tone="expense" />
    </>}
  </section>
}
