import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DashboardPage } from './DashboardPage'
import { dashboardApi } from './dashboardApi'

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
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('shows a negative available balance with its sign and negative styling', async () => {
    render(<DashboardPage userEmail="tito@example.com" isLoggingOut={false} onLogout={vi.fn()} />)

    expect(await screen.findByText('-R$ 1.234,56')).toBeVisible()
    await waitFor(() => expect(screen.getByText('Saldo disponível').closest('article')).toHaveClass('dashboard-summary-card--negative'))
  })
})
