import { act, fireEvent, render, screen } from '@testing-library/react-native'

import { ApiError } from '../api/client'
import type { CatalogApi, Category, PaymentMethod } from '../catalog/catalogApi'
import type { ExpenseApi } from '../expenses/expenseApi'
import { QuickExpenseScreen } from './QuickExpenseScreen'

const NOW = new Date(2026, 10, 18)
const MARKET: Category = { id: 'c-market', name: 'Mercado', nature: 'expense', subcategories: [] }
const PIX: PaymentMethod = { id: 'p-pix', name: 'Pix', nature: 'immediate', isActive: true }

function fakeExpenseApi(overrides: Partial<ExpenseApi> = {}): ExpenseApi {
  return {
    create: jest.fn(async () => ({})),
    listCreditCards: jest.fn(async () => ({ items: [] })),
    ...overrides,
  } as unknown as ExpenseApi
}

function fakeCatalogApi(listCategories = jest.fn(async () => ({ items: [MARKET] }))): CatalogApi {
  return { listCategories, listPaymentMethods: jest.fn(async () => ({ items: [PIX] })) } as unknown as CatalogApi
}

async function mount(expenseApi = fakeExpenseApi(), catalogApi = fakeCatalogApi()) {
  const onOpenExpenses = jest.fn()
  const view = await render(
    <QuickExpenseScreen walletId="personal" walletName="Pessoal" expenseApi={expenseApi} catalogApi={catalogApi} onOpenExpenses={onOpenExpenses} now={NOW} />,
  )
  return { expenseApi, catalogApi, onOpenExpenses, view }
}

describe('QuickExpenseScreen', () => {
  it('launches a simple expense in a few taps: amount, category, payment, launch', async () => {
    const { expenseApi } = await mount()
    expect(await screen.findByText('Na carteira Pessoal, com a data de hoje.')).toBeTruthy()
    await fireEvent.changeText(screen.getByLabelText('Valor (R$)'), '12,30')
    await fireEvent.press(screen.getByRole('radio', { name: 'Mercado' }))
    await fireEvent.press(screen.getByRole('radio', { name: 'Pix' }))
    await fireEvent.press(screen.getByRole('button', { name: 'Lançar despesa' }))
    expect(await screen.findByText('Despesa registrada.')).toBeTruthy()
    expect(expenseApi.create).toHaveBeenCalledWith({
      amount: '12.30',
      date: '2026-11-18',
      description: null,
      categoryId: 'c-market',
      subcategoryId: null,
      paymentMethodId: 'p-pix',
      creditCardId: null,
    })
    // Ready for the next expense.
    expect(screen.getByLabelText('Valor (R$)').props.value).toBe('')
  })

  it('keeps what was typed when the API refuses, with its message', async () => {
    const create = jest.fn(async () => { throw new ApiError('A categoria informada é inválida.', 400) })
    await mount(fakeExpenseApi({ create }))
    await screen.findByText('Na carteira Pessoal, com a data de hoje.')
    await fireEvent.changeText(screen.getByLabelText('Valor (R$)'), '12,30')
    await fireEvent.press(screen.getByRole('radio', { name: 'Mercado' }))
    await fireEvent.press(screen.getByRole('button', { name: 'Lançar despesa' }))
    expect(await screen.findByText('A categoria informada é inválida.')).toBeTruthy()
    expect(screen.getByLabelText('Valor (R$)').props.value).toBe('12,30')
  })

  it('shows what the form refuses before calling the API', async () => {
    const { expenseApi } = await mount()
    await screen.findByText('Na carteira Pessoal, com a data de hoje.')
    await fireEvent.press(screen.getByRole('button', { name: 'Lançar despesa' }))
    expect(await screen.findByText('Informe o valor.')).toBeTruthy()
    expect(expenseApi.create).not.toHaveBeenCalled()
  })

  it('opens the full list of the month', async () => {
    const { onOpenExpenses } = await mount()
    await fireEvent.press(await screen.findByRole('link', { name: 'Ver despesas do mês' }))
    expect(onOpenExpenses).toHaveBeenCalledTimes(1)
  })

  it('reads the options of the new wallet and drops the old message', async () => {
    let resolveSecond: (value: { items: Category[] }) => void = () => undefined
    const listCategories = jest.fn()
      .mockResolvedValueOnce({ items: [MARKET] })
      .mockImplementationOnce(() => new Promise((resolve) => { resolveSecond = resolve }))
    const expenseApi = fakeExpenseApi()
    const catalogApi = fakeCatalogApi(listCategories)
    const { view, onOpenExpenses } = await mount(expenseApi, catalogApi)
    await screen.findByText('Na carteira Pessoal, com a data de hoje.')
    await fireEvent.press(screen.getByRole('button', { name: 'Lançar despesa' }))
    expect(await screen.findByText('Informe o valor.')).toBeTruthy()

    await view.rerender(
      <QuickExpenseScreen walletId="house" walletName="Casa" expenseApi={expenseApi} catalogApi={catalogApi} onOpenExpenses={onOpenExpenses} now={NOW} />,
    )
    expect(screen.getByText('Carregando…')).toBeTruthy()
    expect(listCategories).toHaveBeenCalledTimes(2)
    await act(async () => { resolveSecond({ items: [{ ...MARKET, id: 'c-home', name: 'Casa e reforma' }] }) })
    expect(screen.getByRole('radio', { name: 'Casa e reforma' })).toBeTruthy()
    expect(screen.queryByText('Informe o valor.')).toBeNull()
  })

  it('shows a retryable error when the options cannot be read', async () => {
    const listCategories = jest.fn()
      .mockRejectedValueOnce(new ApiError('Não foi possível conectar à API. Verifique sua conexão.', 0))
      .mockResolvedValue({ items: [MARKET] })
    await mount(fakeExpenseApi(), fakeCatalogApi(listCategories))
    expect(await screen.findByText('Não foi possível conectar à API. Verifique sua conexão.')).toBeTruthy()
    await fireEvent.press(screen.getByRole('button', { name: 'Tentar novamente' }))
    expect(await screen.findByRole('radio', { name: 'Mercado' })).toBeTruthy()
  })
})
