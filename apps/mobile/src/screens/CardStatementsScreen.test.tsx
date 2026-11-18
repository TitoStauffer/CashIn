import { act, fireEvent, render, screen } from '@testing-library/react-native'

import { ApiError } from '../api/client'
import type { CreditCardApi, CreditCardStatement } from '../cards/creditCardApi'
import { CardStatementsScreen } from './CardStatementsScreen'

const NOW = new Date(2026, 10, 18)
const CARD = { id: 'k-gold', nickname: 'Gold' }

// A statement in the API's shape. The amounts are deliberately inconsistent with each other (total
// is not purchases minus credits): the screen must show them as sent.
const OPEN: CreditCardStatement = {
  id: 's-nov',
  creditCardId: 'k-gold',
  creditCardName: 'Gold',
  closingDate: '2026-11-10',
  dueDate: '2026-11-20',
  paidDate: null,
  paidAmount: null,
  purchasesAmount: '500.00',
  creditsAmount: '40.00',
  totalAmount: '455.55',
  paymentsAmount: '100.00',
  outstandingAmount: '355.55',
  purchases: [{ id: 'p1', amount: '500.00', date: '2026-11-02', description: 'Mercado do mês', categoryName: 'Mercado', subcategoryName: null }],
  credits: [
    { id: 'c1', amount: '30.00', date: '2026-11-05', description: 'Estorno da loja', originalExpenseId: 'p1' },
    { id: 'c2', amount: '10.00', date: '2026-11-06', description: null, originalExpenseId: null },
  ],
  payments: [{ id: 'y1', amount: '100.00', date: '2026-11-08', source: 'bank_statement' }],
}
const PAID: CreditCardStatement = { ...OPEN, id: 's-oct', closingDate: '2026-10-10', dueDate: '2026-10-20', paidDate: '2026-10-19', outstandingAmount: '0.00', payments: [] }

function fakeCardApi(overrides: Partial<CreditCardApi> = {}): CreditCardApi {
  return {
    listStatements: jest.fn(async (_id: string, from: string) => ({ items: from.startsWith('2026-10') ? [PAID] : [OPEN] })),
    payStatement: jest.fn(async () => OPEN),
    ...overrides,
  } as unknown as CreditCardApi
}

async function mount(cardApi = fakeCardApi()) {
  const view = await render(<CardStatementsScreen card={CARD} cardApi={cardApi} now={NOW} />)
  return { cardApi, view }
}

const openPayment = () => fireEvent.press(screen.getByRole('link', { name: 'Pagar fatura que vence em 20/11/2026' }))

describe('CardStatementsScreen', () => {
  it('shows the statements of the month exactly as the API computed them', async () => {
    const { cardApi } = await mount()
    expect(await screen.findByText('Fecha em 10/11/2026 · vence em 20/11/2026')).toBeTruthy()
    expect(cardApi.listStatements).toHaveBeenCalledWith('k-gold', '2026-11-01', '2026-11-30')
    expect(screen.getByText('Em aberto')).toBeTruthy()
    // 500 - 40 would be 460; the screen shows the API's 455,55.
    expect(screen.getByText('R$ 455,55')).toBeTruthy()
    expect(screen.getByText('R$ 355,55')).toBeTruthy()
    expect(screen.getByText('02/11/2026 · Mercado do mês · R$ 500,00')).toBeTruthy()
    expect(screen.getByText('05/11/2026 · Estorno da loja · R$ 30,00')).toBeTruthy()
    expect(screen.getByText('06/11/2026 · Estorno (sem compra identificada) · R$ 10,00')).toBeTruthy()
    expect(screen.getByText('08/11/2026 · conciliado do extrato · R$ 100,00')).toBeTruthy()
  })

  it('pays what is owed when no amount is typed, leaving the amount out', async () => {
    const { cardApi } = await mount()
    await screen.findByText('Em aberto')
    await openPayment()
    expect(screen.getByLabelText('Data do pagamento (DD/MM/AAAA)').props.value).toBe('18/11/2026')
    await fireEvent.press(screen.getByRole('button', { name: 'Registrar pagamento' }))
    expect(await screen.findByText('Fatura paga.')).toBeTruthy()
    expect(cardApi.payStatement).toHaveBeenCalledWith('k-gold', 's-nov', { date: '2026-11-18' })
    expect(cardApi.listStatements).toHaveBeenCalledTimes(2)
  })

  it('makes a partial payment with the exact decimal typed', async () => {
    const { cardApi } = await mount()
    await screen.findByText('Em aberto')
    await openPayment()
    await fireEvent.changeText(screen.getByLabelText('Valor pago (R$)'), '300,10')
    await fireEvent.press(screen.getByRole('button', { name: 'Registrar pagamento' }))
    expect(await screen.findByText('Pagamento parcial registrado.')).toBeTruthy()
    expect(cardApi.payStatement).toHaveBeenCalledWith('k-gold', 's-nov', { date: '2026-11-18', amount: '300.10' })
  })

  it('shows the API refusal in Portuguese and keeps the payment form', async () => {
    const payStatement = jest.fn(async () => { throw new ApiError('Não é possível pagar uma fatura sem saldo devedor: os créditos cobrem as compras.', 409) })
    await mount(fakeCardApi({ payStatement }))
    await screen.findByText('Em aberto')
    await openPayment()
    await fireEvent.press(screen.getByRole('button', { name: 'Registrar pagamento' }))
    expect(await screen.findByText('Não é possível pagar uma fatura sem saldo devedor: os créditos cobrem as compras.')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Registrar pagamento' })).toBeTruthy()
  })

  it('checks date and amount before calling the API', async () => {
    const { cardApi } = await mount()
    await screen.findByText('Em aberto')
    await openPayment()
    await fireEvent.changeText(screen.getByLabelText('Data do pagamento (DD/MM/AAAA)'), '31/11/2026')
    await fireEvent.press(screen.getByRole('button', { name: 'Registrar pagamento' }))
    expect(await screen.findByText('Informe a data no formato DD/MM/AAAA.')).toBeTruthy()
    await fireEvent.changeText(screen.getByLabelText('Data do pagamento (DD/MM/AAAA)'), '18/11/2026')
    await fireEvent.changeText(screen.getByLabelText('Valor pago (R$)'), '-5')
    await fireEvent.press(screen.getByRole('button', { name: 'Registrar pagamento' }))
    expect(await screen.findByText('O valor deve ser maior que zero.')).toBeTruthy()
    expect(cardApi.payStatement).not.toHaveBeenCalled()
  })

  it('offers no payment on a settled statement', async () => {
    await mount()
    await screen.findByText('Em aberto')
    await fireEvent.press(screen.getByRole('link', { name: 'Mês anterior' }))
    expect(await screen.findByText('Liquidada em 19/10/2026')).toBeTruthy()
    expect(screen.queryByRole('link', { name: /Pagar fatura/ })).toBeNull()
  })

  it('says when no statement closes in the month, and drops an open payment form on month change', async () => {
    let release: (value: { items: CreditCardStatement[] }) => void = () => undefined
    const listStatements = jest.fn()
      .mockResolvedValueOnce({ items: [OPEN] })
      .mockImplementationOnce(() => new Promise((resolve) => { release = resolve }))
    await mount(fakeCardApi({ listStatements }))
    await screen.findByText('Em aberto')
    await openPayment()
    await fireEvent.press(screen.getByRole('link', { name: 'Próximo mês' }))
    expect(screen.getByText('Carregando faturas…')).toBeTruthy()
    expect(screen.queryByLabelText('Valor pago (R$)')).toBeNull()
    await act(async () => { release({ items: [] }) })
    expect(screen.getByText('Nenhuma fatura fecha neste mês.')).toBeTruthy()
  })

  it('shows a retryable error when the statements cannot be read', async () => {
    const listStatements = jest.fn()
      .mockRejectedValueOnce(new ApiError('Cartão não encontrado.', 404))
      .mockResolvedValue({ items: [OPEN] })
    await mount(fakeCardApi({ listStatements }))
    expect(await screen.findByText('Cartão não encontrado.')).toBeTruthy()
    await fireEvent.press(screen.getByRole('button', { name: 'Tentar novamente' }))
    expect(await screen.findByText('Em aberto')).toBeTruthy()
  })
})
