import { fireEvent, render, screen } from '@testing-library/react-native'

import type { Category, PaymentMethod } from '../catalog/catalogApi'
import type { CreditCard, Expense } from './expenseApi'
import { ExpenseForm, loadExpenseOptions, MISSING_CARD, MISSING_CATEGORY, selectableOptions, type ExpenseOptions } from './ExpenseForm'

const MARKET: Category = { id: 'c-market', name: 'Mercado', nature: 'expense', subcategories: [{ id: 's-fruit', name: 'Hortifrúti', categoryId: 'c-market' }] }
const PIX: PaymentMethod = { id: 'p-pix', name: 'Pix', nature: 'immediate', isActive: true }
const CREDIT: PaymentMethod = { id: 'p-credit', name: 'Crédito', nature: 'credit_card', isActive: true }
const VR: PaymentMethod = { id: 'p-vr', name: 'VA/VR', nature: 'food_meal_benefit', isActive: true }
const AHO: PaymentMethod = { id: 'p-aho', name: 'AHO', nature: 'home_office_benefit', isActive: true }
const OLD_DEBIT: PaymentMethod = { id: 'p-old', name: 'Débito antigo', nature: 'immediate', isActive: false }
const GOLD: CreditCard = { id: 'card-gold', nickname: 'Gold', closingDay: 10, dueDay: 20, isActive: true }
const OLD_CARD: CreditCard = { id: 'card-old', nickname: 'Antigo', closingDay: 5, dueDay: 15, isActive: false }
const OPTIONS: ExpenseOptions = { categories: [MARKET], paymentMethods: [PIX, CREDIT, VR, AHO, OLD_DEBIT], creditCards: [GOLD, OLD_CARD] }

function mount(props: Partial<Parameters<typeof ExpenseForm>[0]> = {}) {
  const onSubmit = jest.fn()
  const onInvalid = jest.fn()
  const view = render(<ExpenseForm options={OPTIONS} today="2026-11-18" busy={false} submitLabel="Salvar despesa" onSubmit={onSubmit} onInvalid={onInvalid} {...props} />)
  return view.then(() => ({ onSubmit, onInvalid }))
}

async function fill(amount: string, method: string) {
  await fireEvent.changeText(screen.getByLabelText('Valor (R$)'), amount)
  await fireEvent.press(screen.getByRole('radio', { name: 'Mercado' }))
  await fireEvent.press(screen.getByRole('radio', { name: method }))
}

const submit = () => fireEvent.press(screen.getByRole('button', { name: 'Salvar despesa' }))

describe('ExpenseForm', () => {
  it.each([
    ['Pix', 'p-pix', 'Reduz o saldo em dinheiro.'],
    ['VA/VR', 'p-vr', 'Reduz o saldo do cartão de benefícios (VA/VR).'],
    ['AHO', 'p-aho', 'Reduz o saldo do auxílio home office (AHO).'],
  ])('sends a %s expense with the exact decimal and no card, and says which balance it reduces', async (method, paymentMethodId, balance) => {
    const { onSubmit } = await mount()
    await fill('0,10', method)
    expect(screen.getByText(balance)).toBeTruthy()
    await submit()
    expect(onSubmit).toHaveBeenCalledWith({
      amount: '0.10',
      date: '2026-11-18',
      description: null,
      categoryId: 'c-market',
      subcategoryId: null,
      paymentMethodId,
      creditCardId: null,
    })
  })

  it('requires the card of a credit purchase before calling the API, and sends it', async () => {
    const { onSubmit, onInvalid } = await mount()
    await fill('120', 'Crédito')
    expect(screen.getByText('Entra na fatura do cartão escolhido.')).toBeTruthy()
    await submit()
    expect(onInvalid).toHaveBeenCalledWith(MISSING_CARD)
    expect(onSubmit).not.toHaveBeenCalled()

    await fireEvent.press(screen.getByRole('radio', { name: 'Gold' }))
    await submit()
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ paymentMethodId: 'p-credit', creditCardId: 'card-gold' }))
  })

  it('drops a card chosen before switching away from credit, because the API refuses it', async () => {
    const { onSubmit } = await mount()
    await fill('120', 'Crédito')
    await fireEvent.press(screen.getByRole('radio', { name: 'Gold' }))
    await fireEvent.press(screen.getByRole('radio', { name: 'Pix' }))
    expect(screen.queryByRole('radio', { name: 'Gold' })).toBeNull()
    await submit()
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ paymentMethodId: 'p-pix', creditCardId: null }))
  })

  it('offers only active methods and cards to a new expense', async () => {
    await mount()
    expect(screen.queryByRole('radio', { name: 'Débito antigo (inativa)' })).toBeNull()
    await fireEvent.press(screen.getByRole('radio', { name: 'Crédito' }))
    expect(screen.queryByRole('radio', { name: 'Antigo (inativo)' })).toBeNull()
  })

  it('keeps the inactive method and card an edited expense already has', () => {
    const expense = { paymentMethodId: 'p-old', creditCardId: 'card-old' } as Expense
    const { paymentMethods, creditCards } = selectableOptions(OPTIONS, expense)
    expect(paymentMethods.map((method) => method.id)).toContain('p-old')
    expect(creditCards.map((card) => card.id)).toContain('card-old')
  })

  it('checks amount, date and category before calling the API', async () => {
    const { onSubmit, onInvalid } = await mount()
    await submit()
    expect(onInvalid).toHaveBeenLastCalledWith('Informe o valor.')
    await fireEvent.changeText(screen.getByLabelText('Valor (R$)'), '10')
    await fireEvent.changeText(screen.getByLabelText('Data (DD/MM/AAAA)'), '30/02/2026')
    await submit()
    expect(onInvalid).toHaveBeenLastCalledWith('Informe a data no formato DD/MM/AAAA.')
    await fireEvent.changeText(screen.getByLabelText('Data (DD/MM/AAAA)'), '17/11/2026')
    await submit()
    expect(onInvalid).toHaveBeenLastCalledWith(MISSING_CATEGORY)
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('hides date, description and subcategory in the quick entry, and dates it today', async () => {
    const { onSubmit } = await mount({ compact: true })
    expect(screen.queryByLabelText('Data (DD/MM/AAAA)')).toBeNull()
    expect(screen.queryByLabelText('Descrição (opcional)')).toBeNull()
    await fill('35', 'Pix')
    expect(screen.queryByRole('radio', { name: 'Hortifrúti' })).toBeNull()
    await submit()
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ amount: '35.00', date: '2026-11-18' }))
  })

  it('reads the categories of expenses, the payment methods and the cards', async () => {
    const catalogApi = {
      listCategories: jest.fn(async () => ({ items: [MARKET] })),
      listPaymentMethods: jest.fn(async () => ({ items: [PIX] })),
    }
    const expenseApi = { listCreditCards: jest.fn(async () => ({ items: [GOLD] })) }
    await expect(loadExpenseOptions(catalogApi, expenseApi)).resolves.toEqual({ categories: [MARKET], paymentMethods: [PIX], creditCards: [GOLD] })
    expect(catalogApi.listCategories).toHaveBeenCalledWith('expense')
  })
})
