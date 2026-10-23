import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DashboardPage } from './DashboardPage'
import { DashboardApiError, dashboardApi } from './dashboardApi'
import type { FinancialSummary } from './dashboardApi'
import type { InvestmentGoal } from '../goals/goalsApi'
import { WalletProvider } from '../wallets/WalletContext'
import { walletApi } from '../wallets/walletApi'

const personalWallet = { id: 'wallet-personal', name: 'Pessoal', isPersonal: true, role: 'owner' as const }
const otherWallet = { id: 'wallet-other', name: 'Família', isPersonal: false, role: 'member' as const }
const empty: FinancialSummary = {
  incomeTotal: '0.00', expenseTotal: '0.00', contributionTotal: '0.00', availableBalance: '0.00', cashBalance: '0.00',
  cashIncomeTotal: '0.00', cashExpenseTotal: '0.00', creditPurchaseTotal: '0.00', cardPaymentTotal: '0.00',
  benefitBalances: [], incomeByCategory: [], expenseByCategory: [], contributionsByGoal: [],
}
const populated: FinancialSummary = {
  ...empty, incomeTotal: '4500.00', expenseTotal: '1800.00', contributionTotal: '500.00', cashBalance: '2200.00', availableBalance: '2200.00',
  cashIncomeTotal: '4000.00', cashExpenseTotal: '1000.00', creditPurchaseTotal: '600.00', cardPaymentTotal: '300.00',
  benefitBalances: [{ balanceType: 'food_meal_benefit', amount: '300.00' }],
  incomeByCategory: [{ categoryId: 'salary', categoryName: 'Salário', amount: '4500.00' }],
  expenseByCategory: [{ categoryId: 'housing', categoryName: 'Moradia', amount: '1800.00' }],
  contributionsByGoal: [{ goalId: 'goal-1', amount: '500.00' }],
}
const goal: InvestmentGoal = { id: 'goal-1', title: 'Reserva', description: 'Reserva de emergência', targetAmount: '10000.00', contributedAmount: '2500.00', progressPercentage: 25, dueDate: '2027-06-30', status: 'active', categoryId: null, categoryName: null, subcategoryId: null, subcategoryName: null }
async function renderPage() {
  const result = render(<WalletProvider userId="user-1"><DashboardPage userEmail="demo@example.com" isLoggingOut={false} onLogout={vi.fn()} /></WalletProvider>)
  await screen.findByRole('combobox', { name: /Carteira ativa/ })
  return result
}
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => { resolve = resolvePromise; reject = rejectPromise })
  return { promise, resolve, reject }
}
function summaryCard(label: string) {
  return within(screen.getByText(label, { selector: '.dashboard-summary-card > span' }).closest('article')!)
}

describe('DashboardPage', () => {
  beforeEach(() => {
    window.localStorage.clear()
    window.history.replaceState({}, '', '/dashboard?month=2026-10')
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })))
    vi.spyOn(dashboardApi, 'summary').mockResolvedValue(populated)
    vi.spyOn(dashboardApi, 'goals').mockResolvedValue({ items: [goal] })
    vi.spyOn(walletApi, 'list').mockResolvedValue({ items: [personalWallet, otherWallet] })
  })
  afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); window.history.replaceState({}, '', '/') })

  it('separates cash, benefits, credit purchases and paid invoices with an auditable formula', async () => {
    await renderPage()
    await screen.findByRole('heading', { name: 'Composição do fluxo em dinheiro' })
    expect(summaryCard('Entradas totais').getByText('R$ 4.500,00')).toBeVisible()
    expect(summaryCard('Despesas registradas').getByText('R$ 1.800,00')).toBeVisible()
    expect(summaryCard('Fluxo restante em dinheiro').getByText('R$ 2.200,00')).toBeVisible()
    expect(screen.getByText('R$ 4.000,00 − R$ 1.000,00 − R$ 300,00 − R$ 500,00 = R$ 2.200,00.')).toBeVisible()
    expect(screen.getByText('Cartão de benefícios (VA/VR)')).toBeVisible()
    expect(screen.getByText('Compras no crédito no mês').nextElementSibling).toHaveTextContent('R$ 600,00')
    expect(screen.getByText('Faturas pagas no mês').nextElementSibling).toHaveTextContent('R$ 300,00')
    expect(screen.getByText(/pela data do pagamento, uma única vez/)).toBeVisible()
    expect(screen.getByRole('link', { name: 'Ver entradas' })).toHaveAttribute('href', '/incomes?month=2026-10')
    expect(screen.getByRole('link', { name: 'Ver despesas' })).toHaveAttribute('href', '/expenses?month=2026-10')
    expect(screen.getByRole('link', { name: 'Ver aportes' })).toHaveAttribute('href', '/goals?month=2026-10')
    expect(screen.getByRole('link', { name: 'Consultar cartões e faturas' })).toHaveAttribute('href', '/credit-cards')
    expect(dashboardApi.summary).toHaveBeenCalledTimes(2)
    expect(dashboardApi.goals).toHaveBeenCalledTimes(1)
  })

  it('shows the sign of a negative cash result without mixing in benefits', async () => {
    vi.mocked(dashboardApi.summary).mockResolvedValue({ ...populated, cashBalance: '-1234.56', benefitBalances: [
      { balanceType: 'food_benefit', amount: '20.00' }, { balanceType: 'meal_benefit', amount: '-10.00' }, { balanceType: 'home_office_benefit', amount: '200.00' },
    ] })
    await renderPage()
    const label = await screen.findByText('Fluxo restante em dinheiro', { selector: '.dashboard-summary-card > span' })
    expect(label.closest('article')).toHaveClass('dashboard-summary-card--negative')
    expect(label.closest('article')).toHaveTextContent('-R$ 1.234,56')
    expect(screen.getByText('Vale-alimentação (VA)')).toBeVisible()
    expect(screen.getByText('Vale-refeição (VR)')).toBeVisible()
    expect(screen.getByText('Auxílio home office (AHO)')).toBeVisible()
  })

  it('sorts the top five categories by exact amounts and keeps category/month in their links', async () => {
    const categories = [
      { categoryId: 'lower', categoryName: 'Menor', amount: '1.00' },
      { categoryId: 'large-1', categoryName: 'Grande A', amount: '9007199254740993.01' },
      { categoryId: 'large-2', categoryName: 'Grande B', amount: '9007199254740993.02' },
      { categoryId: 'tie-b', categoryName: 'Beta', amount: '3.00' },
      { categoryId: 'tie-a', categoryName: 'Alfa', amount: '3.00' },
      { categoryId: 'middle', categoryName: 'Meio', amount: '2.00' },
    ]
    vi.mocked(dashboardApi.summary).mockResolvedValue({ ...populated, incomeByCategory: categories, expenseByCategory: [] })
    await renderPage()
    const section = await screen.findByRole('region', { name: 'Top 5 categorias de entradas' })
    expect(within(section).getAllByRole('listitem').map((item) => within(item).getByRole('link').textContent)).toEqual(['Grande B', 'Grande A', 'Alfa', 'Beta', 'Meio'])
    expect(within(section).getByText('R$ 9.007.199.254.740.993,02')).toBeVisible()
    expect(within(section).queryByText('Menor')).not.toBeInTheDocument()
    expect(within(section).getByRole('link', { name: 'Grande B' })).toHaveAttribute('href', '/incomes?month=2026-10&categoryId=large-2')
    expect(screen.getByText('Nenhuma despesa neste período.')).toBeVisible()
  })

  it('compares full calendar months including December across a year boundary and category context', async () => {
    window.history.replaceState({}, '', '/dashboard?month=2027-01')
    vi.mocked(dashboardApi.summary).mockResolvedValueOnce(populated).mockResolvedValueOnce({ ...populated, incomeTotal: '4000.00', expenseTotal: '2000.00', incomeByCategory: [{ categoryId: 'salary', categoryName: 'Salário', amount: '4000.00' }], expenseByCategory: [{ categoryId: 'housing', categoryName: 'Moradia', amount: '2000.00' }] })
    await renderPage()
    const comparison = await screen.findByRole('region', { name: 'Comparação com o mês anterior' })
    expect(dashboardApi.summary).toHaveBeenNthCalledWith(1, '2027-01-01', '2027-01-31', expect.any(AbortSignal))
    expect(dashboardApi.summary).toHaveBeenNthCalledWith(2, '2026-12-01', '2026-12-31', expect.any(AbortSignal))
    expect(comparison).toHaveTextContent('Dezembro de 2026 → Janeiro de 2027')
    expect(within(comparison).getByText('Salário: R$ 500,00 a mais')).toBeVisible()
    expect(within(comparison).getByText('Moradia: R$ 200,00 a menos')).toBeVisible()
    expect(within(comparison).getAllByText('Sem alteração')).toHaveLength(2)
    expect(within(comparison).getByRole('link', { name: 'Anterior: R$ 2.000,00' })).toHaveAttribute('href', '/expenses?month=2026-12&categoryId=housing')
    expect(within(comparison).getByRole('link', { name: 'Selecionado: R$ 1.800,00' })).toHaveAttribute('href', '/expenses?month=2027-01&categoryId=housing')
  })

  it('shows cumulative goal progress, remaining amount, deadline and monthly contributions including closed goals', async () => {
    vi.mocked(dashboardApi.goals).mockResolvedValue({ items: [goal, { ...goal, id: 'without', title: 'Viagem', dueDate: null, description: '' }, { ...goal, id: 'closed', title: 'Concluída', status: 'closed', targetAmount: '100.00', contributedAmount: '125.00', progressPercentage: 125 }, { ...goal, id: 'hidden', title: 'Histórica', status: 'closed' }] })
    vi.mocked(dashboardApi.summary).mockResolvedValue({ ...populated, contributionsByGoal: [...populated.contributionsByGoal, { goalId: 'closed', amount: '25.00' }] })
    await renderPage()
    const reserve = (await screen.findByRole('heading', { name: 'Reserva' })).closest('li')!
    expect(reserve).toHaveTextContent('Acumulado total: R$ 2.500,00')
    expect(reserve).toHaveTextContent('Alvo: R$ 10.000,00')
    expect(reserve).toHaveTextContent('Restante: R$ 7.500,00')
    expect(reserve).toHaveTextContent('Prazo cadastrado: 30/06/2027')
    expect(within(reserve).getByRole('progressbar')).toHaveAttribute('aria-valuenow', '25')
    expect(within(reserve).getByRole('link')).toHaveAttribute('href', '/goals?month=2026-10&goalId=goal-1')
    expect(within(reserve).getByRole('link')).toHaveTextContent('Aportes no período: R$ 500,00')
    const trip = screen.getByRole('heading', { name: 'Viagem' }).closest('li')!
    expect(trip).toHaveTextContent('Prazo não definido')
    expect(trip).toHaveTextContent('Aportes no período: R$ 0,00')
    const closed = screen.getByRole('heading', { name: 'Concluída' }).closest('li')!
    expect(closed).toHaveTextContent('Restante: R$ 0,00')
    expect(closed).toHaveTextContent('125%')
    expect(within(closed).getByRole('progressbar')).toHaveAttribute('aria-valuenow', '100')
    expect(screen.queryByRole('heading', { name: 'Histórica' })).not.toBeInTheDocument()
  })

  it('shows clear empty states and avoids comparison without movement', async () => {
    vi.mocked(dashboardApi.summary).mockResolvedValue(empty)
    vi.mocked(dashboardApi.goals).mockResolvedValue({ items: [] })
    await renderPage()
    expect(await screen.findByText('Nenhuma entrada, despesa, aporte ou fatura paga neste mês.')).toBeVisible()
    expect(screen.getByText(/Comparação indisponível/)).toBeVisible()
    expect(screen.getByText('Nenhuma entrada neste período.')).toBeVisible()
    expect(screen.getByRole('link', { name: 'Criar primeira meta' })).toBeVisible()
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
  })

  it('waits for all requests, replaces data while changing month, and retries a failed previous month', async () => {
    const user = userEvent.setup()
    const pending = deferred<FinancialSummary>()
    vi.mocked(dashboardApi.summary).mockReturnValueOnce(pending.promise)
    await renderPage()
    expect(screen.getByRole('status')).toHaveTextContent('Carregando sua visão financeira')
    await act(async () => pending.resolve(populated))
    await screen.findByRole('heading', { name: 'Progresso das metas' })
    vi.mocked(dashboardApi.summary).mockResolvedValueOnce(empty).mockRejectedValueOnce(new Error('offline'))
    await user.click(screen.getByRole('button', { name: 'Mês anterior' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Não foi possível carregar a visão geral.')
    expect(screen.queryByRole('heading', { name: 'Progresso das metas' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Tentar novamente' }))
    expect(await screen.findByRole('heading', { name: 'Progresso das metas' })).toBeVisible()
    expect(screen.getByLabelText('Selecionar mês e ano')).toHaveValue('2026-09')
  })

  it('displays API errors and recovers from a failed goals request', async () => {
    vi.mocked(dashboardApi.goals).mockRejectedValueOnce(new DashboardApiError('Serviço temporariamente indisponível.', 503))
    await renderPage()
    expect(await screen.findByRole('alert')).toHaveTextContent('Serviço temporariamente indisponível.')
    vi.mocked(dashboardApi.goals).mockRejectedValueOnce(new DashboardApiError('', 500))
    await userEvent.setup().click(screen.getByRole('button', { name: 'Tentar novamente' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Não foi possível carregar a visão geral.')
  })

  it('hides old wallet data immediately and ignores a late success from an aborted wallet request', async () => {
    const user = userEvent.setup()
    await renderPage()
    await screen.findByRole('heading', { name: 'Reserva' })
    const stale = deferred<FinancialSummary>()
    const fresh = deferred<FinancialSummary>()
    vi.mocked(dashboardApi.summary).mockReturnValueOnce(stale.promise).mockResolvedValueOnce(empty).mockReturnValueOnce(fresh.promise).mockResolvedValueOnce(empty)
    await user.selectOptions(screen.getByRole('combobox', { name: /Carteira ativa/ }), otherWallet.id)
    expect(screen.queryByRole('heading', { name: 'Reserva' })).not.toBeInTheDocument()
    expect(screen.getByRole('status')).toBeVisible()
    await user.selectOptions(screen.getByRole('combobox', { name: /Carteira ativa/ }), personalWallet.id)
    await act(async () => fresh.resolve(empty))
    await screen.findByText('Nenhuma entrada, despesa, aporte ou fatura paga neste mês.')
    await act(async () => stale.resolve({ ...populated, incomeTotal: '999999.00' }))
    expect(summaryCard('Entradas totais').getByText('R$ 0,00')).toBeVisible()
    expect(screen.queryByText('R$ 999.999,00')).not.toBeInTheDocument()
  })

  it('ignores a late error when a newer month has already loaded', async () => {
    const stale = deferred<FinancialSummary>()
    vi.mocked(dashboardApi.summary).mockReturnValueOnce(stale.promise)
    await renderPage()
    const firstSignal = vi.mocked(dashboardApi.summary).mock.calls[0][2]!
    fireEvent.change(screen.getByLabelText('Selecionar mês e ano'), { target: { value: '2024-02' } })
    await screen.findByRole('heading', { name: 'Progresso das metas' })
    expect(firstSignal.aborted).toBe(true)
    expect(dashboardApi.summary).toHaveBeenCalledWith('2024-02-01', '2024-02-29', expect.any(AbortSignal))
    await act(async () => stale.reject(new DashboardApiError('Resposta antiga', 500)))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('aborts requests when unmounted and does not apply their result', async () => {
    const pending = deferred<FinancialSummary>()
    vi.mocked(dashboardApi.summary).mockReturnValueOnce(pending.promise)
    const page = await renderPage()
    const signal = vi.mocked(dashboardApi.summary).mock.calls[0][2]!
    page.unmount()
    expect(signal.aborted).toBe(true)
    await act(async () => pending.resolve(populated))
    expect(screen.queryByRole('heading', { name: 'Visão geral' })).not.toBeInTheDocument()
  })
})
