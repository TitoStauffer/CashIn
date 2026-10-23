import { useEffect, useState } from 'react'
import { DashboardApiError, dashboardApi } from './dashboardApi'
import type { FinancialSummary } from './dashboardApi'
import type { InvestmentGoal } from '../goals/goalsApi'
import { FinancialSidebar } from '../layout/FinancialSidebar'
import { useWallet } from '../wallets/useWallet'
import { MonthYearSelector } from '../period/MonthYearSelector'
import { getMonthRange, shiftMonth } from '../period/month'
import { getInitialMonth, recordLink } from '../period/recordLinks'
import { DashboardOverview } from './DashboardOverview'
import { DashboardCategories } from './DashboardCategories'
import { DashboardComparison } from './DashboardComparison'
import { DashboardGoals } from './DashboardGoals'
import './DashboardPage.css'

type DashboardPageProps = { userEmail: string; isLoggingOut: boolean; onLogout: () => void }
type DashboardData = { summary: FinancialSummary; previous: FinancialSummary; goals: InvestmentGoal[] }
type LoadState = { key: string; data?: DashboardData; error?: string }

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
  const { activeWalletId } = useWallet()
  const [month, setMonth] = useState(getInitialMonth)
  const [reloadKey, setReloadKey] = useState(0)
  const [loaded, setLoaded] = useState<LoadState | null>(null)
  const requestKey = `${activeWalletId}/${month}/${reloadKey}`

  useEffect(() => {
    const controller = new AbortController()
    const range = getMonthRange(month)
    const previousRange = getMonthRange(shiftMonth(month, -1))
    Promise.all([
      dashboardApi.summary(range.from, range.to, controller.signal),
      dashboardApi.summary(previousRange.from, previousRange.to, controller.signal),
      dashboardApi.goals(controller.signal),
    ]).then(([summary, previous, goals]) => {
      if (!controller.signal.aborted) setLoaded({ key: requestKey, data: { summary, previous, goals: goals.items } })
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) setLoaded({ key: requestKey, error: getErrorMessage(error) })
    })
    return () => controller.abort()
  }, [month, requestKey])

  const current = loaded?.key === requestKey ? loaded : null
  const data = current?.data

  return <>
    <FinancialSidebar activePage="dashboard" userEmail={userEmail} isLoggingOut={isLoggingOut} onLogout={onLogout} />
    <main className="dashboard-page"><div className="dashboard-shell">
      <section className="dashboard-content" aria-labelledby="dashboard-title">
        <div className="dashboard-heading"><div><p className="dashboard-eyebrow">SUA VIDA FINANCEIRA EM UM SÓ LUGAR</p><h1 id="dashboard-title">Visão geral</h1><p>Acompanhe o movimento do mês e o caminho até suas metas.</p></div><MonthYearSelector month={month} onMonthChange={setMonth} /></div>
        {!current && <div className="dashboard-loading" role="status" aria-live="polite"><span className="dashboard-spinner" />Carregando sua visão financeira…</div>}
        {current?.error && <div className="dashboard-alert" role="alert"><span>{current.error}</span><button type="button" onClick={() => setReloadKey((key) => key + 1)}>Tentar novamente</button></div>}
        {data && <>
          <DashboardOverview summary={data.summary} month={month} />
          <nav className="dashboard-quick-actions" aria-label="Ações rápidas"><a className="dashboard-primary-button" href={recordLink('/incomes', month)}>＋ Registrar entrada</a><a className="dashboard-secondary-button" href={recordLink('/expenses', month)}>＋ Registrar despesa</a><a className="dashboard-secondary-button" href={recordLink('/goals', month)}>＋ Registrar aporte</a></nav>
          <section className="dashboard-panel dashboard-categories" aria-labelledby="categories-title"><div className="dashboard-panel__heading"><div><p className="dashboard-eyebrow">PARA ONDE VAI E DE ONDE VEM</p><h2 id="categories-title">Movimentações por categoria</h2></div><a href="/categories">Gerenciar categorias →</a></div><p className="dashboard-section-note">Categorias ordenadas pelo total registrado no mês, incluindo benefícios e compras no crédito. Pagamentos de faturas não são somados novamente às despesas.</p><div className="dashboard-categories__grid"><DashboardCategories items={data.summary.incomeByCategory} tone="income" month={month} /><DashboardCategories items={data.summary.expenseByCategory} tone="expense" month={month} /></div></section>
          <DashboardComparison current={data.summary} previous={data.previous} month={month} />
          <DashboardGoals goals={data.goals} contributions={data.summary.contributionsByGoal} month={month} />
        </>}
      </section>
      <footer className="dashboard-footer"><span>Saldo Certo · clareza para cada escolha</span><a href="/categories">Gerenciar categorias</a></footer>
    </div></main>
  </>
}
