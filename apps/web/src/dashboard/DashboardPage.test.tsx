import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DashboardPage } from './DashboardPage'
import { dashboardApi } from './dashboardApi'
import { WalletProvider } from '../wallets/WalletContext'
import { walletApi } from '../wallets/walletApi'

const personalWallet = { id: 'wallet-personal', name: 'Pessoal', isPersonal: true, role: 'owner' as const }
async function renderPage() {
  const result = render(<WalletProvider userId="user-1"><DashboardPage userEmail="tito@example.com" isLoggingOut={false} onLogout={vi.fn()} /></WalletProvider>)
  await screen.findByRole('combobox', { name: /Carteira ativa/ })
  return result
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise })
  return { promise, resolve }
}

describe('DashboardPage', () => {
  beforeEach(() => {
    vi.stubGlobal('matchMedia', vi.fn(() => ({
      matches: false,
      media: '(max-width: 760px)',
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })))
    vi.spyOn(dashboardApi, 'summary').mockResolvedValue({
      incomeTotal: '1200.00',
      expenseTotal: '2000.00',
      contributionTotal: '434.56',
      availableBalance: '-1234.56',
      incomeByCategory: [],
      expenseByCategory: [],
    })
    vi.spyOn(dashboardApi, 'goals').mockResolvedValue({ items: [] })
    vi.spyOn(walletApi, 'list').mockResolvedValue({ items: [personalWallet] })
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('shows a negative cash balance with its sign and negative styling', async () => {
    await renderPage()

    expect(await screen.findByText('-R$ 1.234,56')).toBeVisible()
    await waitFor(() => expect(screen.getByText('Saldo em dinheiro').closest('article')).toHaveClass('dashboard-summary-card--negative'))
  })

  it('keeps a positive available balance without negative styling', async () => {
    vi.mocked(dashboardApi.summary).mockResolvedValueOnce({
      incomeTotal: '3000.00',
      expenseTotal: '1000.00',
      contributionTotal: '500.00',
      availableBalance: '1500.00',
      incomeByCategory: [],
      expenseByCategory: [],
    })
    await renderPage()

    const balanceCard = (await screen.findByText('Saldo em dinheiro')).closest('article')
    expect(balanceCard).toHaveTextContent('R$ 1.500,00')
    expect(balanceCard).not.toHaveClass('dashboard-summary-card--negative')
  })

  it('shows a recoverable error when the overview cannot be loaded', async () => {
    const user = userEvent.setup()
    vi.mocked(dashboardApi.summary).mockRejectedValueOnce(new Error('offline'))
    await renderPage()

    expect(await screen.findByRole('alert')).toHaveTextContent('Não foi possível carregar a visão geral.')
    await user.click(screen.getByRole('button', { name: 'Tentar novamente' }))

    expect(await screen.findByText('Saldo em dinheiro')).toBeVisible()
  })

  it('shows a visible loading state until both dashboard requests finish', async () => {
    const summaryRequest = deferred<Awaited<ReturnType<typeof dashboardApi.summary>>>()
    vi.mocked(dashboardApi.summary).mockReturnValueOnce(summaryRequest.promise)
    await renderPage()

    expect(screen.getByRole('status')).toHaveTextContent('Carregando sua visão financeira')
    summaryRequest.resolve({
      incomeTotal: '1200.00',
      expenseTotal: '2000.00',
      contributionTotal: '434.56',
      availableBalance: '-1234.56',
      incomeByCategory: [],
      expenseByCategory: [],
    })
    expect(await screen.findByText('Saldo em dinheiro')).toBeVisible()
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('shows separate balances for cash and each benefit type returned by the API', async () => {
    vi.mocked(dashboardApi.summary).mockResolvedValueOnce({
      incomeTotal: '4000.00',
      expenseTotal: '1000.00',
      contributionTotal: '0.00',
      availableBalance: '2000.00',
      cashBalance: '2000.00',
      benefitBalances: [
        { balanceType: 'food_meal_benefit', amount: '800.00' },
        { balanceType: 'home_office_benefit', amount: '200.00' },
      ],
      incomeByCategory: [],
      expenseByCategory: [],
    })
    await renderPage()

    expect(await screen.findByText('Saldo em dinheiro')).toBeVisible()
    expect(screen.getByText('Cartão de benefícios (VA/VR)')).toBeVisible()
    expect(screen.getByText('Auxílio home office (AHO)')).toBeVisible()
    expect(screen.getByText('R$ 800,00')).toBeVisible()
    expect(screen.getByText('R$ 200,00')).toBeVisible()
  })
})
