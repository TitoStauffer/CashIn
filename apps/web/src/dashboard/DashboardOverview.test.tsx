import { cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { DashboardOverview } from './DashboardOverview'
import type { FinancialSummary } from './dashboardApi'

// The arithmetic of the cash flow has its own tests in dashboardMetrics.test.ts. What this file
// covers is the composition of the panel: the two bars, the detail rows and the formula line. Until
// now that was only ever verified by reading the JSX.
const base: FinancialSummary = {
  incomeTotal: '0.00', expenseTotal: '0.00', contributionTotal: '0.00',
  cashIncomeTotal: '0.00', cashExpenseTotal: '0.00', creditPurchaseTotal: '0.00', cardPaymentTotal: '0.00',
  transferOutTotal: '0.00', transferInTotal: '0.00',
  contributionsByGoal: [], availableBalance: '0.00', cashBalance: '0.00',
  benefitBalances: [], incomeByCategory: [], expenseByCategory: [],
}

function detail(label: string) {
  return screen.getByText(label, { selector: '.dashboard-cash-details dt' }).nextElementSibling
}

function flowRow(label: string) {
  return screen.getByText(label, { selector: '.dashboard-flow__row span' }).closest('.dashboard-flow__row') as HTMLElement
}

describe('DashboardOverview', () => {
  afterEach(() => cleanup())

  // 1.000 de entrada em dinheiro + 200 recebidos = 1.200 de entrada.
  // 300 de despesa + 150 de fatura + 100 de aporte + 500 enviados = 1.050 de saída.
  // 1.000 − 300 − 150 − 100 − 500 + 200 = 150.
  const withTransfers: FinancialSummary = {
    ...base,
    incomeTotal: '1000.00', expenseTotal: '300.00', contributionTotal: '100.00',
    cashIncomeTotal: '1000.00', cashExpenseTotal: '300.00', cardPaymentTotal: '150.00',
    transferOutTotal: '500.00', transferInTotal: '200.00',
    cashBalance: '150.00', availableBalance: '150.00',
  }

  it('shows the two sides of the cash flow with the totals each bar represents', () => {
    render(<DashboardOverview summary={withTransfers} month="2026-10" />)

    // The inflow bar carries the received transfer, which is cash that arrived without being income.
    expect(within(flowRow('Entradas em dinheiro')).getByText('R$ 1.200,00')).toBeVisible()
    expect(within(flowRow('Saídas em dinheiro')).getByText('R$ 1.050,00')).toBeVisible()
    // The larger side fills the track, and the smaller one is drawn in proportion to it.
    expect(flowRow('Entradas em dinheiro').querySelector('.dashboard-flow__bar')).toHaveStyle({ width: '100%' })
    expect(flowRow('Saídas em dinheiro').querySelector('.dashboard-flow__bar')).toHaveStyle({ width: '87.5%' })
  })

  it('details each component of the flow, including both directions of a transfer', () => {
    render(<DashboardOverview summary={withTransfers} month="2026-10" />)

    expect(detail('Despesas em dinheiro')).toHaveTextContent('R$ 300,00')
    expect(detail('Faturas pagas no mês')).toHaveTextContent('R$ 150,00')
    expect(detail('Aportes do mês')).toHaveTextContent('R$ 100,00')
    expect(detail('Transferências enviadas')).toHaveTextContent('R$ 500,00')
    expect(detail('Transferências recebidas')).toHaveTextContent('R$ 200,00')
  })

  // The formula is the panel's promise that the number in the card can be audited by hand. If it
  // stops closing on the reported balance, this assertion is what says so.
  it('closes the formula on the reported cash balance', () => {
    render(<DashboardOverview summary={withTransfers} month="2026-10" />)

    expect(screen.getByText(
      'R$ 1.200,00 − R$ 300,00 − R$ 150,00 − R$ 100,00 − R$ 500,00 = R$ 150,00.',
    )).toBeVisible()
    expect(screen.getByText(/Fluxo restante = entradas em dinheiro/)).toHaveTextContent('− transferências enviadas')
  })

  it('does not mention a received amount when the month only sent transfers', () => {
    render(<DashboardOverview summary={{
      ...withTransfers, transferInTotal: '0.00', cashIncomeTotal: '1000.00', cashBalance: '-50.00', availableBalance: '-50.00',
    }} month="2026-10" />)

    // The sent transfer still deserves its explanation; the received one has nothing to report.
    expect(screen.queryByText(/recebidos de outra carteira/)).toBeNull()
    expect(screen.getByText(/Transferências entre carteiras mudam o dinheiro de lugar/)).toBeVisible()
    expect(detail('Transferências recebidas')).toHaveTextContent('R$ 0,00')
  })

  it('omits the transfer rows and note when the month has no transfer at all', () => {
    render(<DashboardOverview summary={{ ...base, cashIncomeTotal: '10.00', cashBalance: '10.00', availableBalance: '10.00', incomeTotal: '10.00' }} month="2026-10" />)

    expect(screen.queryByText('Transferências enviadas')).toBeNull()
    expect(screen.queryByText('Transferências recebidas')).toBeNull()
    expect(screen.queryByText(/Transferências entre carteiras mudam o dinheiro de lugar/)).toBeNull()
    expect(screen.getByText('R$ 10,00 − R$ 0,00 − R$ 0,00 − R$ 0,00 = R$ 10,00.')).toBeVisible()
  })

  it('states the empty month instead of drawing a flow that does not exist', () => {
    render(<DashboardOverview summary={base} month="2026-10" />)

    expect(screen.getByText(/Nenhuma entrada, despesa, aporte ou fatura paga neste mês/)).toBeVisible()
  })
})
