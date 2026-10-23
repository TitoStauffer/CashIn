import type { InvestmentGoal } from '../goals/goalsApi'
import type { FinancialSummary } from './dashboardApi'
import { amountToCents, barPercentage, centsToAmount } from './dashboardMetrics'
import { formatBrazilianCurrency as money } from '../money/currency'
import { formatMonth } from '../period/month'
import { recordLink } from '../period/recordLinks'

function deadline(value: string | null) {
  return value ? `Prazo cadastrado: ${value.slice(0, 10).split('-').reverse().join('/')}` : 'Prazo não definido'
}

export function DashboardGoals({ goals, contributions, month }: { goals: InvestmentGoal[]; contributions: FinancialSummary['contributionsByGoal']; month: string }) {
  const amounts = new Map(contributions.map((item) => [item.goalId, item.amount]))
  const visibleGoals = goals.filter((goal) => goal.status === 'active' || amounts.has(goal.id))
    .sort((a, b) => a.title.localeCompare(b.title, 'pt-BR'))
  return <section className="dashboard-panel dashboard-goals" aria-labelledby="goals-title">
    <div className="dashboard-panel__heading"><div><p className="dashboard-eyebrow">PLANOS PARA O FUTURO</p><h2 id="goals-title">Progresso das metas</h2></div><a href={recordLink('/goals', month)}>Gerenciar metas →</a></div>
    <p className="dashboard-section-note">O acumulado considera todo o histórico. Os aportes abaixo correspondem a {formatMonth(month)}. Metas encerradas aparecem quando receberam aportes no período.</p>
    {visibleGoals.length === 0 ? <div className="dashboard-empty"><h3>Suas metas começam com um plano.</h3><p>Crie uma meta para acompanhar quanto já guardou e quanto falta para chegar ao seu objetivo.</p><a className="dashboard-primary-button" href="/goals">Criar primeira meta</a></div> : <ul className="dashboard-goal-list">
      {visibleGoals.map((goal) => {
        const accumulated = amountToCents(goal.contributedAmount)
        const target = amountToCents(goal.targetAmount)
        const remaining = target > accumulated ? target - accumulated : 0n
        const progress = barPercentage(accumulated, target)
        return <li className={`dashboard-goal${goal.status === 'closed' ? ' dashboard-goal--closed' : ''}`} key={goal.id}>
          <div className="dashboard-goal__header"><div><h3>{goal.title}</h3>{goal.description && <p>{goal.description}</p>}</div><span className="dashboard-goal__status">{goal.status === 'closed' ? 'Encerrada' : 'Em andamento'}</span></div>
          <div className="dashboard-goal__meta"><span>{deadline(goal.dueDate)}</span><span>Alvo: {money(goal.targetAmount)}</span><span>Restante: {money(centsToAmount(remaining))}</span></div>
          <div className="dashboard-goal__progress-label"><span>Acumulado total: {money(goal.contributedAmount)}</span><strong>{new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 1 }).format(goal.progressPercentage)}%</strong></div>
          <div className="dashboard-goal__track" role="progressbar" aria-label={`Progresso da meta ${goal.title}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress}><span style={{ width: `${progress}%` }} /></div>
          <a className="dashboard-record-link" href={recordLink('/goals', month, { goalId: goal.id })}>Aportes no período: {money(amounts.get(goal.id) ?? '0.00')} · Ver registros</a>
        </li>
      })}
    </ul>}
  </section>
}
