import type { CategorySummary } from './dashboardApi'
import { amountToCents, barPercentage, topCategories } from './dashboardMetrics'
import { formatBrazilianCurrency as money } from '../money/currency'
import { recordLink } from '../period/recordLinks'

export function DashboardCategories({ items, tone, month }: { items: CategorySummary[]; tone: 'income' | 'expense'; month: string }) {
  const title = tone === 'income' ? 'Entradas' : 'Despesas'
  const path = tone === 'income' ? '/incomes' : '/expenses'
  const ranked = topCategories(items)
  const maximum = amountToCents(ranked[0]?.amount ?? '0.00')
  return (
    <section className={`dashboard-category dashboard-category--${tone}`} aria-label={`Top 5 categorias de ${title.toLowerCase()}`}>
      <h3>{title} · Top 5 categorias</h3>
      {ranked.length === 0 ? <p className="dashboard-category__empty">Nenhuma {tone === 'income' ? 'entrada' : 'despesa'} neste período.</p> : (
        <ol className="dashboard-category__list">
          {ranked.map((item) => (
            <li className="dashboard-category__item" key={item.categoryId}>
              <div className="dashboard-category__label"><a href={recordLink(path, month, { categoryId: item.categoryId })}>{item.categoryName}</a><strong>{money(item.amount)}</strong></div>
              <div className="dashboard-category__track" aria-hidden="true"><span style={{ width: `${barPercentage(amountToCents(item.amount), maximum)}%` }} /></div>
            </li>
          ))}
        </ol>
      )}
      <a className="dashboard-record-link" href={recordLink(path, month)}>Ver todas as {title.toLowerCase()}</a>
    </section>
  )
}
