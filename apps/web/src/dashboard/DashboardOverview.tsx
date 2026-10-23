import type { BenefitBalanceSummary, FinancialSummary } from './dashboardApi'
import { amountToCents, barPercentage, cashOutflow, centsToAmount, hasActivity } from './dashboardMetrics'
import { formatBrazilianCurrency as money } from '../money/currency'
import { formatMonth } from '../period/month'
import { recordLink } from '../period/recordLinks'

const benefitLabels: Record<BenefitBalanceSummary['balanceType'], string> = {
  food_benefit: 'Vale-alimentação (VA)', meal_benefit: 'Vale-refeição (VR)',
  food_meal_benefit: 'Cartão de benefícios (VA/VR)', home_office_benefit: 'Auxílio home office (AHO)',
}

export function DashboardOverview({ summary, month }: { summary: FinancialSummary; month: string }) {
  const income = amountToCents(summary.cashIncomeTotal)
  const outflow = cashOutflow(summary)
  const scale = income > outflow ? income : outflow
  return <>
    <div className="dashboard-summary-grid" aria-label={`Resumo financeiro de ${formatMonth(month)}`}>
      <article className="dashboard-summary-card dashboard-summary-card--income"><span>Entradas totais</span><strong>{money(summary.incomeTotal)}</strong><small>dinheiro e benefícios no mês</small><a href={recordLink('/incomes', month)}>Ver entradas</a></article>
      <article className="dashboard-summary-card dashboard-summary-card--expense"><span>Despesas registradas</span><strong>{money(summary.expenseTotal)}</strong><small>inclui benefícios e compras no crédito; exclui pagamentos de faturas</small><a href={recordLink('/expenses', month)}>Ver despesas</a></article>
      <article className="dashboard-summary-card dashboard-summary-card--contribution"><span>Aportes</span><strong>{money(summary.contributionTotal)}</strong><small>destinados às metas no mês</small><a href={recordLink('/goals', month)}>Ver aportes</a></article>
      <article className={`dashboard-summary-card dashboard-summary-card--balance${summary.cashBalance.startsWith('-') ? ' dashboard-summary-card--negative' : ''}`}><span>Fluxo restante em dinheiro</span><strong>{money(summary.cashBalance)}</strong><small>resultado dos movimentos do mês; não é saldo bancário acumulado</small><a href="#cash-flow-title">Ver composição</a></article>
    </div>
    <section className="dashboard-panel" aria-labelledby="benefits-title"><div className="dashboard-panel__heading"><div><h2 id="benefits-title">Benefícios separados do dinheiro</h2></div></div><p className="dashboard-section-note">Entradas menos despesas de cada benefício no período. Esses valores não compõem o fluxo restante em dinheiro.</p>
      {summary.benefitBalances.length === 0 ? <p className="dashboard-section-note">Nenhuma movimentação de benefícios neste mês.</p> : <div className="dashboard-benefit-balances">{summary.benefitBalances.map((balance) => <article className="dashboard-benefit-balance" key={balance.balanceType}><span>{benefitLabels[balance.balanceType]}</span><strong>{money(balance.amount)}</strong></article>)}</div>}
    </section>
    <section className="dashboard-panel dashboard-flow" aria-labelledby="cash-flow-title"><div className="dashboard-panel__heading"><div><p className="dashboard-eyebrow">MOVIMENTO DO MÊS</p><h2 id="cash-flow-title">Composição do fluxo em dinheiro</h2></div></div>
      {!hasActivity(summary) && <p className="dashboard-empty dashboard-empty--compact">Nenhuma entrada, despesa, aporte ou fatura paga neste mês.</p>}
      <div className="dashboard-flow__rows">
        <div className="dashboard-flow__row"><div><span>Entradas em dinheiro</span><strong>{money(summary.cashIncomeTotal)}</strong></div><div className="dashboard-flow__track" aria-hidden="true"><span className="dashboard-flow__bar dashboard-flow__bar--income" style={{ width: `${barPercentage(income, scale)}%` }} /></div></div>
        <div className="dashboard-flow__row"><div><span>Saídas em dinheiro</span><strong>{money(centsToAmount(outflow))}</strong></div><div className="dashboard-flow__track" aria-hidden="true"><span className="dashboard-flow__bar dashboard-flow__bar--outflow" style={{ width: `${barPercentage(outflow, scale)}%` }} /></div></div>
      </div>
      <dl className="dashboard-cash-details"><div><dt>Despesas em dinheiro</dt><dd>{money(summary.cashExpenseTotal)}</dd></div><div><dt>Faturas pagas no mês</dt><dd>{money(summary.cardPaymentTotal)}</dd></div><div><dt>Aportes do mês</dt><dd>{money(summary.contributionTotal)}</dd></div><div><dt>Compras no crédito no mês</dt><dd>{money(summary.creditPurchaseTotal)}</dd></div></dl>
      <p className="dashboard-section-note">Fluxo restante = entradas em dinheiro − despesas em dinheiro − faturas pagas − aportes.</p>
      <p className="dashboard-section-note">{money(summary.cashIncomeTotal)} − {money(summary.cashExpenseTotal)} − {money(summary.cardPaymentTotal)} − {money(summary.contributionTotal)} = {money(summary.cashBalance)}.</p>
      <p className="dashboard-section-note">Compras no crédito entram nas despesas pela data da compra, mas afetam o dinheiro somente pelo pagamento da fatura. Faturas pagas são consideradas pela data do pagamento, uma única vez.</p>
      <nav className="dashboard-record-links" aria-label="Conferir composição"><a href={recordLink('/incomes', month)}>Consultar entradas do mês</a><a href={recordLink('/expenses', month)}>Consultar despesas do mês</a><a href={recordLink('/goals', month)}>Consultar aportes do mês</a><a href="/credit-cards">Consultar cartões e faturas</a></nav>
    </section>
  </>
}
