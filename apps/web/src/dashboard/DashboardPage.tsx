import { useEffect, useMemo, useState } from 'react'
import type { CategorySummary, FinancialSummary } from './dashboardApi'
import { DashboardApiError, dashboardApi } from './dashboardApi'
import type { InvestmentGoal } from '../goals/goalsApi'
import './DashboardPage.css'

type DashboardPageProps = { userEmail: string; isLoggingOut: boolean; onLogout: () => void }

function getCurrentMonth() {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
}

function getMonthRange(month: string) {
  const [year, monthNumber] = month.split('-').map(Number)
  const lastDay = new Date(year, monthNumber, 0).getDate()
  return { from: `${month}-01`, to: `${month}-${String(lastDay).padStart(2, '0')}` }
}

function shiftMonth(month: string, offset: number) {
  const [year, monthNumber] = month.split('-').map(Number)
  const shifted = new Date(year, monthNumber - 1 + offset, 1)
  return `${shifted.getFullYear()}-${String(shifted.getMonth() + 1).padStart(2, '0')}`
}

function formatMonth(month: string) {
  const [year, monthNumber] = month.split('-').map(Number)
  const formatted = new Intl.DateTimeFormat('pt-BR', { month: 'long', year: 'numeric' })
    .format(new Date(year, monthNumber - 1, 1))
  return formatted.charAt(0).toLocaleUpperCase('pt-BR') + formatted.slice(1)
}

function formatAmount(value: string) {
  const amount = Number(value)
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' })
    .format(Number.isFinite(amount) ? amount : 0)
}

function CategoryBreakdown({ title, items, tone }: { title: string; items: CategorySummary[]; tone: 'income' | 'expense' }) {
  const amountsInCents = items.map((item) => amountToCents(item.amount))
  const maximum = Math.max(0, ...amountsInCents)

  return (
    <section className={`dashboard-category dashboard-category--${tone}`} aria-label={`${title} por categoria`}>
      <h3>{title}</h3>
      {items.length === 0 ? (
        <p className="dashboard-category__empty">Nenhuma {tone === 'income' ? 'entrada' : 'despesa'} neste período.</p>
      ) : (
        <ul className="dashboard-category__list">
          {items.map((item, index) => {
            const amountInCents = amountsInCents[index]
            const width = maximum > 0 ? amountInCents / maximum * 100 : 0
            return (
              <li className="dashboard-category__item" key={item.categoryId}>
                <div className="dashboard-category__label"><span>{item.categoryName}</span><strong>{formatAmount(item.amount)}</strong></div>
                <div className="dashboard-category__track" role="img" aria-label={`${item.categoryName}: ${formatAmount(item.amount)}`}>
                  <span style={{ width: `${width}%` }} />
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}

function amountToCents(value: string) {
  const [integerPart, fractionPart = ''] = value.split('.')
  const cents = Number(`${integerPart}${fractionPart.padEnd(2, '0').slice(0, 2)}`)
  return Number.isFinite(cents) ? cents : 0
}

function centsToAmount(value: number) {
  return `${Math.floor(value / 100)}.${String(value % 100).padStart(2, '0')}`
}

function formatDate(value: string | null) {
  if (!value) return 'Prazo não definido'
  const [year, month, day] = value.slice(0, 10).split('-')
  return `Prazo: ${day}/${month}/${year}`
}

function getErrorMessage(error: unknown) {
  if (error instanceof DashboardApiError) {
    if (error.status === 401 || error.status === 403) {
      window.location.assign('/login')
      return 'Sua sessão expirou. Entre novamente para continuar.'
    }
    if (error.message.trim()) return error.message
  }
  return 'Não foi possível carregar a visão geral. Verifique sua conexão e tente novamente.'
}

export function DashboardPage({ userEmail, isLoggingOut, onLogout }: DashboardPageProps) {
  const [month, setMonth] = useState(getCurrentMonth)
  const [summary, setSummary] = useState<FinancialSummary | null>(null)
  const [goals, setGoals] = useState<InvestmentGoal[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [reloadKey, setReloadKey] = useState(0)
  const range = useMemo(() => getMonthRange(month), [month])

  useEffect(() => {
    const controller = new AbortController()
    Promise.all([
      dashboardApi.summary(range.from, range.to, controller.signal),
      dashboardApi.goals(controller.signal),
    ])
      .then(([nextSummary, goalResponse]) => {
        setSummary(nextSummary)
        setGoals(goalResponse.items)
      })
      .catch((error: unknown) => {
        if (error instanceof Error && error.name === 'AbortError') return
        setLoadError(getErrorMessage(error))
      })
      .finally(() => { if (!controller.signal.aborted) setIsLoading(false) })
    return () => controller.abort()
  }, [range.from, range.to, reloadKey])

  const outflowCents = summary
    ? amountToCents(summary.expenseTotal) + amountToCents(summary.contributionTotal)
    : 0
  const incomeCents = summary ? amountToCents(summary.incomeTotal) : 0
  const outflow = centsToAmount(outflowCents)
  const scale = Math.max(incomeCents, outflowCents)
  const visibleGoals = useMemo(() => goals
    .filter((goal) => goal.status === 'active')
    .sort((a, b) => a.title.localeCompare(b.title, 'pt-BR')), [goals])

  function changeMonth(offset: number) {
    setLoadError('')
    setIsLoading(true)
    setMonth((value) => shiftMonth(value, offset))
  }

  return (
    <main className="dashboard-page">
      <div className="dashboard-shell">
        <header className="dashboard-topbar">
          <a className="dashboard-brand" href="/dashboard" aria-label="Saldo Certo, visão geral">
            <span className="dashboard-brand__mark" aria-hidden="true">SC</span>
            <span>saldo<span>certo</span></span>
          </a>
          <nav className="dashboard-account" aria-label="Navegação da área financeira">
            <a className="dashboard-account__link" href="/dashboard" aria-current="page">Visão geral</a>
            <a className="dashboard-account__link" href="/incomes">Entradas</a>
            <a className="dashboard-account__link" href="/expenses">Despesas</a>
            <a className="dashboard-account__link" href="/goals">Metas</a>
            <a className="dashboard-account__link" href="/categories">Categorias</a>
            <span className="dashboard-account__email">{userEmail}</span>
            <button className="dashboard-signout" type="button" onClick={onLogout} disabled={isLoggingOut}>
              {isLoggingOut ? 'Saindo…' : 'Sair'}
            </button>
          </nav>
        </header>

        <section className="dashboard-content" aria-labelledby="dashboard-title">
          <div className="dashboard-heading">
            <div>
              <p className="dashboard-eyebrow">SUA VIDA FINANCEIRA EM UM SÓ LUGAR</p>
              <h1 id="dashboard-title">Visão geral</h1>
              <p>Acompanhe o movimento do mês e o caminho até suas metas.</p>
            </div>
            <div className="dashboard-month" aria-label="Navegação por mês">
              <button type="button" onClick={() => changeMonth(-1)} aria-label="Mês anterior">‹</button>
              <span aria-live="polite">{formatMonth(month)}</span>
              <button type="button" onClick={() => changeMonth(1)} aria-label="Próximo mês">›</button>
            </div>
          </div>

          {loadError && (
            <div className="dashboard-alert" role="alert">
              <span>{loadError}</span>
              <button type="button" onClick={() => { setLoadError(''); setIsLoading(true); setReloadKey((value) => value + 1) }}>Tentar novamente</button>
            </div>
          )}

          {isLoading ? (
            <div className="dashboard-loading" role="status" aria-live="polite"><span className="dashboard-spinner" />Carregando sua visão financeira…</div>
          ) : !loadError && summary ? (
            <>
              <div className="dashboard-summary-grid" aria-label={`Resumo financeiro de ${formatMonth(month)}`}>
                <article className="dashboard-summary-card dashboard-summary-card--income">
                  <span>Entradas</span><strong>{formatAmount(summary.incomeTotal)}</strong><small>no mês</small>
                </article>
                <article className="dashboard-summary-card dashboard-summary-card--expense">
                  <span>Despesas</span><strong>{formatAmount(summary.expenseTotal)}</strong><small>no mês</small>
                </article>
                <article className="dashboard-summary-card dashboard-summary-card--contribution">
                  <span>Aportes</span><strong>{formatAmount(summary.contributionTotal)}</strong><small>destinados às metas</small>
                </article>
                <article className={`dashboard-summary-card dashboard-summary-card--balance${Number(summary.availableBalance) < 0 ? ' dashboard-summary-card--negative' : ''}`}>
                  <span>Saldo disponível</span><strong>{formatAmount(summary.availableBalance)}</strong><small>entradas menos despesas e aportes</small>
                </article>
              </div>

              <nav className="dashboard-quick-actions" aria-label="Ações rápidas">
                <a className="dashboard-primary-button" href="/incomes">＋ Registrar entrada</a>
                <a className="dashboard-secondary-button" href="/expenses">＋ Registrar despesa</a>
                <a className="dashboard-secondary-button" href="/goals">＋ Registrar aporte</a>
              </nav>

              <section className="dashboard-panel dashboard-flow" aria-labelledby="flow-title">
                <div className="dashboard-panel__heading">
                  <div><p className="dashboard-eyebrow">MOVIMENTO DO MÊS</p><h2 id="flow-title">Entradas e saídas</h2></div>
                  <a href="/expenses">Ver despesas <span aria-hidden="true">→</span></a>
                </div>
                {scale === 0 ? (
                  <div className="dashboard-empty dashboard-empty--compact">
                    <span className="dashboard-empty__icon" aria-hidden="true">↗</span>
                    <p>Nenhuma entrada, despesa ou aporte neste mês.</p>
                    <div><a href="/incomes">Registrar entrada</a><a href="/expenses">Registrar despesa</a><a href="/goals">Registrar aporte</a></div>
                  </div>
                ) : (
                  <div className="dashboard-flow__rows">
                    <div className="dashboard-flow__row">
                      <div><span>Entradas</span><strong>{formatAmount(summary.incomeTotal)}</strong></div>
                      <div className="dashboard-flow__track" role="img" aria-label={`Entradas: ${formatAmount(summary.incomeTotal)}`}><span className="dashboard-flow__bar dashboard-flow__bar--income" style={{ width: `${scale ? incomeCents / scale * 100 : 0}%` }} /></div>
                    </div>
                    <div className="dashboard-flow__row">
                      <div><span>Saídas <small>(despesas + aportes)</small></span><strong>{formatAmount(outflow)}</strong></div>
                      <div className="dashboard-flow__track" role="img" aria-label={`Saídas: ${formatAmount(outflow)}`}><span className="dashboard-flow__bar dashboard-flow__bar--outflow" style={{ width: `${scale ? outflowCents / scale * 100 : 0}%` }} /></div>
                    </div>
                    <p className="dashboard-flow__note">Os aportes aparecem separados no resumo e também compõem as saídas para calcular o saldo disponível.</p>
                  </div>
                )}
              </section>

              <section className="dashboard-panel dashboard-categories" aria-labelledby="categories-title">
                <div className="dashboard-panel__heading">
                  <div><p className="dashboard-eyebrow">PARA ONDE VAI E DE ONDE VEM</p><h2 id="categories-title">Movimentações por categoria</h2></div>
                  <a href="/categories">Gerenciar categorias <span aria-hidden="true">→</span></a>
                </div>
                <div className="dashboard-categories__grid">
                  <CategoryBreakdown title="Entradas" items={summary.incomeByCategory ?? []} tone="income" />
                  <CategoryBreakdown title="Despesas" items={summary.expenseByCategory ?? []} tone="expense" />
                </div>
              </section>
            </>
          ) : null}

          {!isLoading && !loadError && (
            <section className="dashboard-panel dashboard-goals" aria-labelledby="goals-title">
              <div className="dashboard-panel__heading">
                <div><p className="dashboard-eyebrow">PLANOS PARA O FUTURO</p><h2 id="goals-title">Progresso das metas</h2></div>
                <a href="/goals">Gerenciar metas <span aria-hidden="true">→</span></a>
              </div>
              {visibleGoals.length === 0 ? (
                <div className="dashboard-empty">
                  <span className="dashboard-empty__icon" aria-hidden="true">◎</span>
                  <h3>Suas metas começam com um plano.</h3>
                  <p>Crie uma meta para acompanhar quanto já guardou e quanto falta para chegar ao seu objetivo.</p>
                  <a className="dashboard-primary-button" href="/goals">Criar primeira meta</a>
                </div>
              ) : (
                <ul className="dashboard-goal-list">
                  {visibleGoals.map((goal) => {
                    const progress = Math.min(100, Math.max(0, goal.progressPercentage))
                    return (
                      <li className={`dashboard-goal${goal.status === 'closed' ? ' dashboard-goal--closed' : ''}`} key={goal.id}>
                        <div className="dashboard-goal__header">
                          <div><h3>{goal.title}</h3>{goal.description && <p>{goal.description}</p>}</div>
                          <span className={`dashboard-goal__status${goal.status === 'closed' ? ' dashboard-goal__status--closed' : ''}`}>{goal.status === 'closed' ? 'Encerrada' : 'Em andamento'}</span>
                        </div>
                        <div className="dashboard-goal__meta"><span>{formatDate(goal.dueDate)}</span><span>Alvo: {formatAmount(goal.targetAmount)}</span></div>
                        <div className="dashboard-goal__progress-label"><span>{formatAmount(goal.contributedAmount)} guardados</span><strong>{new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 1 }).format(progress)}%</strong></div>
                        <div className="dashboard-goal__track" role="progressbar" aria-label={`Progresso da meta ${goal.title}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress}><span style={{ width: `${progress}%` }} /></div>
                      </li>
                    )
                  })}
                </ul>
              )}
            </section>
          )}
        </section>

        <footer className="dashboard-footer"><span>Saldo Certo · clareza para cada escolha</span><a href="/categories">Gerenciar categorias</a></footer>
      </div>
    </main>
  )
}
