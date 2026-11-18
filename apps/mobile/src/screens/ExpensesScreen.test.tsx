import { act, fireEvent, render, screen } from '@testing-library/react-native'
import { Alert } from 'react-native'

import { ApiError } from '../api/client'
import type { CatalogApi, Category, PaymentMethod } from '../catalog/catalogApi'
import type { CreditCard, Expense, ExpenseApi } from '../expenses/expenseApi'
import { ExpensesScreen } from './ExpensesScreen'

const NOW = new Date(2026, 10, 18)
const MARKET: Category = { id: 'c-market', name: 'Mercado', nature: 'expense', subcategories: [] }
const PIX: PaymentMethod = { id: 'p-pix', name: 'Pix', nature: 'immediate', isActive: true }
const CREDIT: PaymentMethod = { id: 'p-credit', name: 'Crédito', nature: 'credit_card', isActive: true }
const GOLD: CreditCard = { id: 'card-gold', nickname: 'Gold', closingDay: 10, dueDay: 20, isActive: true }
const GROCERIES: Expense = {
  id: 'e-1',
  amount: '89.90',
  date: '2026-11-10',
  description: 'Feira',
  categoryId: 'c-market',
  categoryName: 'Mercado',
  subcategoryId: null,
  subcategoryName: null,
  paymentMethodId: 'p-credit',
  paymentMethodName: 'Crédito',
  paymentMethodNature: 'credit_card',
  creditCardId: 'card-gold',
  creditCardName: 'Gold',
}
const COFFEE: Expense = { ...GROCERIES, id: 'e-2', amount: '7.50', date: '2026-11-10', description: null, paymentMethodId: 'p-pix', paymentMethodName: 'Pix', paymentMethodNature: 'immediate', creditCardId: null, creditCardName: null }

function fakeExpenseApi(overrides: Partial<ExpenseApi> = {}): ExpenseApi {
  return {
    list: jest.fn(async () => ({ items: [GROCERIES, COFFEE] })),
    create: jest.fn(async () => COFFEE),
    update: jest.fn(async () => COFFEE),
    remove: jest.fn(async () => undefined),
    listCreditCards: jest.fn(async () => ({ items: [GOLD] })),
    ...overrides,
  } as unknown as ExpenseApi
}

function fakeCatalogApi(): CatalogApi {
  return {
    listCategories: jest.fn(async () => ({ items: [MARKET] })),
    listPaymentMethods: jest.fn(async () => ({ items: [PIX, CREDIT] })),
  } as unknown as CatalogApi
}

async function mount(expenseApi = fakeExpenseApi(), walletId = 'personal', catalogApi = fakeCatalogApi()) {
  const view = await render(<ExpensesScreen walletId={walletId} expenseApi={expenseApi} catalogApi={catalogApi} now={NOW} />)
  return { expenseApi, view, catalogApi }
}

const confirmAlert = async (alert: jest.SpyInstance) => {
  const buttons = (alert.mock.calls.at(-1)?.[2] ?? []) as { text: string; onPress?: () => void }[]
  await act(async () => { buttons.find((button) => button.text === 'Excluir')?.onPress?.() })
}

describe('ExpensesScreen', () => {
  it('lists the expenses of the month with payment method and card', async () => {
    const { expenseApi } = await mount()
    expect(await screen.findByText('R$ 89,90')).toBeTruthy()
    expect(screen.getByText('10/11/2026 · Mercado · Crédito · Gold')).toBeTruthy()
    expect(screen.getByText('10/11/2026 · Mercado · Pix')).toBeTruthy()
    expect(expenseApi.list).toHaveBeenCalledWith('2026-11-01', '2026-11-30')
  })

  it('reads the chosen month', async () => {
    const { expenseApi } = await mount()
    await screen.findByText('R$ 89,90')
    await fireEvent.press(screen.getByRole('link', { name: 'Mês anterior' }))
    expect(await screen.findByText('Outubro de 2026')).toBeTruthy()
    expect(expenseApi.list).toHaveBeenLastCalledWith('2026-10-01', '2026-10-31')
  })

  it('creates an expense and reads the list again', async () => {
    const { expenseApi } = await mount()
    await screen.findByText('R$ 89,90')
    await fireEvent.press(screen.getByRole('button', { name: 'Nova despesa' }))
    await fireEvent.changeText(screen.getByLabelText('Valor (R$)'), '0,10')
    await fireEvent.press(screen.getByRole('radio', { name: 'Mercado' }))
    await fireEvent.press(screen.getByRole('radio', { name: 'Pix' }))
    await fireEvent.press(screen.getByRole('button', { name: 'Salvar despesa' }))
    expect(await screen.findByText('Despesa registrada.')).toBeTruthy()
    expect(expenseApi.create).toHaveBeenCalledWith(expect.objectContaining({ amount: '0.10', paymentMethodId: 'p-pix', creditCardId: null }))
    expect(expenseApi.list).toHaveBeenCalledTimes(2)
    expect(screen.queryByLabelText('Valor (R$)')).toBeNull()
  })

  it('shows the message of the form and of the API, keeping the form open', async () => {
    const update = jest.fn(async () => { throw new ApiError('Não é possível alterar uma compra de fatura já paga.', 409) })
    await mount(fakeExpenseApi({ update }))
    await screen.findByText('R$ 89,90')
    await fireEvent.press(screen.getByRole('link', { name: 'Editar despesa de R$ 89,90 em 10/11/2026 (Mercado)' }))
    await fireEvent.changeText(screen.getByLabelText('Valor (R$)'), '')
    await fireEvent.press(screen.getByRole('button', { name: 'Salvar despesa' }))
    expect(await screen.findByText('Informe o valor.')).toBeTruthy()

    await fireEvent.changeText(screen.getByLabelText('Valor (R$)'), '95')
    await fireEvent.press(screen.getByRole('button', { name: 'Salvar despesa' }))
    expect(await screen.findByText('Não é possível alterar uma compra de fatura já paga.')).toBeTruthy()
    expect(update).toHaveBeenCalledWith('e-1', expect.objectContaining({ amount: '95.00', paymentMethodId: 'p-credit', creditCardId: 'card-gold' }))
    expect(screen.getByLabelText('Valor (R$)')).toBeTruthy()
  })

  it('removes after confirmation and closes the editor of the removed expense only', async () => {
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined)
    const { expenseApi } = await mount()
    await screen.findByText('R$ 89,90')
    await fireEvent.press(screen.getByRole('link', { name: 'Editar despesa de R$ 7,50 em 10/11/2026 (Mercado)' }))
    await fireEvent.press(screen.getByRole('link', { name: 'Excluir despesa de R$ 89,90 em 10/11/2026 (Mercado)' }))
    expect(expenseApi.remove).not.toHaveBeenCalled()
    await confirmAlert(alert)
    expect(expenseApi.remove).toHaveBeenCalledWith('e-1')
    expect(await screen.findByText('Despesa excluída.')).toBeTruthy()
    expect(screen.getByLabelText('Valor (R$)').props.value).toBe('7,50')

    await fireEvent.press(screen.getByRole('link', { name: 'Excluir despesa de R$ 7,50 em 10/11/2026 (Mercado)' }))
    await confirmAlert(alert)
    expect(screen.queryByLabelText('Valor (R$)')).toBeNull()
    alert.mockRestore()
  })

  it('reads the new wallet without showing the old list, and drops the open form', async () => {
    let resolveSecond: (value: { items: Expense[] }) => void = () => undefined
    const list = jest.fn()
      .mockResolvedValueOnce({ items: [GROCERIES] })
      .mockImplementationOnce(() => new Promise((resolve) => { resolveSecond = resolve }))
    const expenseApi = fakeExpenseApi({ list })
    const catalogApi = fakeCatalogApi()
    const { view } = await mount(expenseApi, 'personal', catalogApi)
    await screen.findByText('R$ 89,90')
    await fireEvent.press(screen.getByRole('button', { name: 'Nova despesa' }))

    // The same API instances: only the wallet changes, so only the wallet can trigger the new read.
    await view.rerender(<ExpensesScreen walletId="house" expenseApi={expenseApi} catalogApi={catalogApi} now={NOW} />)
    expect(screen.queryByText('R$ 89,90')).toBeNull()
    expect(screen.getByText('Carregando despesas…')).toBeTruthy()
    expect(list).toHaveBeenCalledTimes(2)

    await act(async () => { resolveSecond({ items: [{ ...COFFEE, id: 'e-9', amount: '12.00' }] }) })
    expect(screen.getByText('R$ 12,00')).toBeTruthy()
    expect(screen.queryByLabelText('Valor (R$)')).toBeNull()
  })

  it('shows a retryable error when the expenses cannot be read', async () => {
    const list = jest.fn()
      .mockRejectedValueOnce(new ApiError('Não foi possível conectar à API. Verifique sua conexão.', 0))
      .mockResolvedValue({ items: [GROCERIES] })
    await mount(fakeExpenseApi({ list }))
    expect(await screen.findByText('Não foi possível conectar à API. Verifique sua conexão.')).toBeTruthy()
    await fireEvent.press(screen.getByRole('button', { name: 'Tentar novamente' }))
    expect(await screen.findByText('R$ 89,90')).toBeTruthy()
  })
})
