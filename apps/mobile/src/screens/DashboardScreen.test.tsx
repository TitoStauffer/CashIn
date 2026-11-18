import { act, fireEvent, render, screen } from '@testing-library/react-native'
import { Text } from 'react-native'

import { ApiError } from '../api/client'
import type { DashboardApi, FinancialSummary, InvestmentGoal } from '../dashboard/dashboardApi'
import { DashboardScreen } from './DashboardScreen'

const NOW = new Date(2026, 10, 18)

// A fixed response in the shape of `docs/dashboard-summary-contract.md`. The amounts are deliberately
// inconsistent with the contract's formulas (cash balance, totals): the screen must show them as sent,
// so any recomputation in the app would show a different number and fail.
const NOVEMBER: FinancialSummary = {
  incomeTotal: '100.00',
  expenseTotal: '11.00',
  contributionTotal: '20.00',
  cashIncomeTotal: '100.00',
  cashExpenseTotal: '5.00',
  creditPurchaseTotal: '6.00',
  cardCreditTotal: '4.00',
  unlinkedCardCreditTotal: '1.50',
  cardPaymentTotal: '6.00',
  transferOutTotal: '30.00',
  transferInTotal: '50.00',
  contributionsByGoal: [{ goalId: 'g-trip', amount: '20.00' }],
  cashBalance: '12.34',
  availableBalance: '12.34',
  benefitBalances: [{ balanceType: 'food_meal_benefit', amount: '320.00' }, { balanceType: 'home_office_benefit', amount: '-15.00' }],
  incomeByCategory: [{ categoryId: 'c-salary', categoryName: 'Salário', amount: '100.00' }],
  expenseByCategory: [
    { categoryId: 'c1', categoryName: 'Mercado', amount: '7.00' },
    { categoryId: 'c2', categoryName: 'Farmácia', amount: '2.00' },
    { categoryId: 'c3', categoryName: 'Lazer', amount: '9.50' },
    { categoryId: 'c4', categoryName: 'Casa', amount: '1.00' },
    { categoryId: 'c5', categoryName: 'Saúde', amount: '3.00' },
    { categoryId: 'c6', categoryName: 'Transporte', amount: '0.50' },
  ],
}
const OCTOBER: FinancialSummary = { ...NOVEMBER, incomeTotal: '80.00', expenseTotal: '40.00', contributionTotal: '0.00', cashBalance: '-7.00', contributionsByGoal: [] }
const EMPTY: FinancialSummary = {
  ...NOVEMBER,
  incomeTotal: '0.00',
  expenseTotal: '0.00',
  contributionTotal: '0.00',
  cashIncomeTotal: '0.00',
  cashExpenseTotal: '0.00',
  creditPurchaseTotal: '0.00',
  cardCreditTotal: '0.00',
  unlinkedCardCreditTotal: '0.00',
  cardPaymentTotal: '0.00',
  transferOutTotal: '0.00',
  transferInTotal: '0.00',
  contributionsByGoal: [],
  cashBalance: '0.00',
  availableBalance: '0.00',
  benefitBalances: [],
  incomeByCategory: [],
  expenseByCategory: [],
}
const TRIP: InvestmentGoal = { id: 'g-trip', title: 'Viagem', targetAmount: '5000.00', dueDate: null, status: 'active', contributedAmount: '1250.00', progressPercentage: 25 }
const RESERVE: InvestmentGoal = { id: 'g-reserve', title: 'Reserva', targetAmount: '10000.00', dueDate: null, status: 'closed', contributedAmount: '10000.00', progressPercentage: 100 }

function fakeDashboardApi(overrides: Partial<DashboardApi> = {}): DashboardApi {
  return {
    summary: jest.fn(async (from: string) => (from.startsWith('2026-10') ? OCTOBER : NOVEMBER)),
    goals: jest.fn(async () => ({ items: [TRIP, RESERVE] })),
    ...overrides,
  } as unknown as DashboardApi
}

async function mount(dashboardApi = fakeDashboardApi(), walletId = 'personal') {
  const view = await render(<DashboardScreen walletId={walletId} dashboardApi={dashboardApi} header={<Text>Cabeçalho da Home</Text>} now={NOW} />)
  return { dashboardApi, view }
}

describe('DashboardScreen', () => {
  it('shows the numbers the API sent, without recomputing any of them', async () => {
    await mount()
    expect(await screen.findByText('Resumo do mês')).toBeTruthy()
    expect(screen.getByText('Cabeçalho da Home')).toBeTruthy()
    expect(screen.getAllByText('R$ 100,00').length).toBeGreaterThan(0)
    expect(screen.getByText('R$ 11,00')).toBeTruthy()
    // The contract's formula would give another cash balance; the screen shows the API's.
    expect(screen.getAllByText('R$ 12,34').length).toBeGreaterThan(0)
    expect(screen.getByText('R$ 4,00')).toBeTruthy()
    expect(screen.getByText('R$ 1,50')).toBeTruthy()
    expect(screen.getByText('R$ 320,00')).toBeTruthy()
    expect(screen.getByText('-R$ 15,00')).toBeTruthy()
  })

  it('keeps transfers between wallets out of income and expense, as their own lines', async () => {
    await mount()
    expect(await screen.findByText('Transferências entre carteiras')).toBeTruthy()
    expect(screen.getByText('Não são entrada nem despesa: só mudam o dinheiro de carteira.')).toBeTruthy()
    expect(screen.getByText('R$ 30,00')).toBeTruthy()
    expect(screen.getByText('R$ 50,00')).toBeTruthy()
    // Income stays the API's 100,00: the 50,00 received is not added to it.
    expect(screen.queryByText('R$ 150,00')).toBeNull()
  })

  it('puts the previous month beside this one, reading both from the API', async () => {
    const { dashboardApi } = await mount()
    await screen.findByText('Comparação com o mês anterior')
    expect(dashboardApi.summary).toHaveBeenCalledWith('2026-11-01', '2026-11-30')
    expect(dashboardApi.summary).toHaveBeenCalledWith('2026-10-01', '2026-10-31')
    expect(screen.getByText('Mês anterior: R$ 80,00 · Este mês: R$ 100,00')).toBeTruthy()
    expect(screen.getByText('Mês anterior: -R$ 7,00 · Este mês: R$ 12,34')).toBeTruthy()
  })

  it('ranks the five largest expense categories', async () => {
    await mount()
    await screen.findByText('Maiores despesas por categoria')
    const ranked = ['Lazer', 'Mercado', 'Saúde', 'Farmácia', 'Casa'].map((name) => screen.getByText(name))
    expect(ranked).toHaveLength(5)
    expect(screen.queryByText('Transporte')).toBeNull()
  })

  it('shows each goal with the API progress and the contribution of the month', async () => {
    await mount()
    await screen.findByText('Metas')
    expect(screen.getByText('Acumulado R$ 1.250,00 de R$ 5.000,00 (25%)')).toBeTruthy()
    expect(screen.getByText('Aportes neste mês: R$ 20,00')).toBeTruthy()
    expect(screen.getByText('Reserva · encerrada')).toBeTruthy()
    expect(screen.getByText('Aportes neste mês: R$ 0,00')).toBeTruthy()
  })

  it('says when the month has no movement', async () => {
    await mount(fakeDashboardApi({ summary: jest.fn(async () => EMPTY), goals: jest.fn(async () => ({ items: [] })) }))
    expect(await screen.findByText('Nenhum lançamento em Novembro de 2026.')).toBeTruthy()
    expect(screen.queryByText('Resumo do mês')).toBeNull()
    expect(screen.queryByText('Transferências entre carteiras')).toBeNull()
  })

  it('shows the wait while the summary is read', async () => {
    await mount(fakeDashboardApi({ summary: jest.fn(() => new Promise<FinancialSummary>(() => undefined)) }))
    expect(screen.getByText('Carregando resumo…')).toBeTruthy()
  })

  it('shows the API error with a retry', async () => {
    const summary = jest.fn()
      .mockRejectedValueOnce(new ApiError('Não foi possível conectar à API. Verifique sua conexão.', 0))
      .mockImplementation(async (from: string) => (from.startsWith('2026-10') ? OCTOBER : NOVEMBER))
    await mount(fakeDashboardApi({ summary }))
    expect(await screen.findByText('Não foi possível conectar à API. Verifique sua conexão.')).toBeTruthy()
    await fireEvent.press(screen.getByRole('link', { name: 'Tentar novamente' }))
    expect(await screen.findByText('Resumo do mês')).toBeTruthy()
    expect(screen.queryByText('Não foi possível conectar à API. Verifique sua conexão.')).toBeNull()
  })

  it('reads another month when the period changes', async () => {
    const { dashboardApi } = await mount()
    await screen.findByText('Resumo do mês')
    await fireEvent.press(screen.getByRole('link', { name: 'Mês anterior' }))
    expect(await screen.findByText('Outubro de 2026')).toBeTruthy()
    expect(dashboardApi.summary).toHaveBeenCalledWith('2026-09-01', '2026-09-30')
  })

  it('reads the new wallet without showing the old summary meanwhile', async () => {
    let release: () => void = () => undefined
    const summary = jest.fn()
      .mockImplementationOnce(async () => NOVEMBER)
      .mockImplementationOnce(async () => OCTOBER)
      .mockImplementation(() => new Promise<FinancialSummary>((resolve) => { release = () => resolve(EMPTY) }))
    const dashboardApi = fakeDashboardApi({ summary })
    const { view } = await mount(dashboardApi, 'personal')
    await screen.findByText('Resumo do mês')

    // The same API instance: only the wallet changes, so only the wallet can trigger the new read.
    await view.rerender(<DashboardScreen walletId="house" dashboardApi={dashboardApi} header={null} now={NOW} />)
    expect(screen.queryByText('Resumo do mês')).toBeNull()
    expect(screen.getByText('Carregando resumo…')).toBeTruthy()
    expect(summary).toHaveBeenCalledTimes(4)
    await act(async () => { release() })
  })

  it('reads again when pulled down, keeping the summary on screen meanwhile', async () => {
    const { dashboardApi } = await mount()
    await screen.findByText('Resumo do mês')
    const refreshControl = screen.getByTestId('dashboard').props.refreshControl
    await act(async () => { refreshControl.props.onRefresh() })
    expect(dashboardApi.summary).toHaveBeenCalledTimes(4)
    expect(dashboardApi.goals).toHaveBeenCalledTimes(2)
    expect(screen.getByText('Resumo do mês')).toBeTruthy()
    expect(screen.getByTestId('dashboard').props.refreshControl.props.refreshing).toBe(false)
  })
})

describe('DashboardScreen pull to refresh', () => {
  it('shows the refresh indicator while the new read is pending', async () => {
    let release: () => void = () => undefined
    const summary = jest.fn()
      .mockImplementationOnce(async () => NOVEMBER)
      .mockImplementationOnce(async () => OCTOBER)
      .mockImplementation(() => new Promise<FinancialSummary>((resolve) => { release = () => resolve(NOVEMBER) }))
    await mount(fakeDashboardApi({ summary }))
    await screen.findByText('Resumo do mês')
    await act(async () => { screen.getByTestId('dashboard').props.refreshControl.props.onRefresh() })
    expect(screen.getByTestId('dashboard').props.refreshControl.props.refreshing).toBe(true)
    await act(async () => { release() })
  })
})
