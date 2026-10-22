import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { categoriesApi } from '../categories/categoriesApi'
import { ExpensesPage } from './ExpensesPage'
import { expensesApi } from './expensesApi'
import { paymentMethodsApi } from '../paymentMethods/paymentMethodsApi'
import { WalletProvider } from '../wallets/WalletContext'
import { walletApi } from '../wallets/walletApi'
import { creditCardsApi } from '../creditCards/creditCardsApi'

const category = { id: 'expense-category', name: 'Moradia', nature: 'expense' as const, subcategories: [] }
const expense = {
  id: 'expense-1', amount: '1234.56', date: '2026-10-02', description: 'Aluguel',
  categoryId: category.id, categoryName: category.name, subcategoryId: null, subcategoryName: null,
  paymentMethodId: null, paymentMethodName: null, paymentMethodNature: null,
  createdAt: '2026-10-02T12:00:00.000Z', updatedAt: '2026-10-02T12:00:00.000Z',
}
const personalWallet = { id: 'wallet-personal', name: 'Pessoal', isPersonal: true, role: 'owner' as const }
async function renderPage() {
  const result = render(<WalletProvider userId="user-1"><ExpensesPage userEmail="tito@example.com" isLoggingOut={false} onLogout={vi.fn()} /></WalletProvider>)
  await screen.findByRole('combobox', { name: /Carteira ativa/ })
  return result
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise })
  return { promise, resolve }
}

describe('ExpensesPage currency input', () => {
  beforeEach(() => {
    vi.stubGlobal('matchMedia', vi.fn(() => ({
      matches: false, media: '(max-width: 760px)', onchange: null,
      addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn(),
    })))
    vi.spyOn(categoriesApi, 'list').mockResolvedValue({ items: [category] })
    vi.spyOn(walletApi, 'list').mockResolvedValue({ items: [personalWallet] })
    vi.spyOn(expensesApi, 'list').mockResolvedValue({ items: [expense] })
    vi.spyOn(paymentMethodsApi, 'list').mockResolvedValue({ items: [] })
    vi.spyOn(creditCardsApi, 'list').mockResolvedValue({ items: [] })
    vi.spyOn(expensesApi, 'create').mockResolvedValue(expense)
    vi.spyOn(expensesApi, 'update').mockResolvedValue(expense)
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('formats saved values, rejects invalid pasted values, and sends a canonical decimal on create', async () => {
    const user = userEvent.setup()
    await renderPage()
    await user.click(await screen.findByRole('button', { name: /Nova despesa/ }))

    const amount = screen.getByLabelText('Valor *')
    fireEvent.change(amount, { target: { value: '1,239' } })
    expect(amount).toHaveAttribute('aria-invalid', 'true')
    expect(screen.getByRole('alert')).toHaveTextContent('duas casas decimais')
    await user.click(screen.getByRole('button', { name: 'Registrar despesa' }))
    expect(expensesApi.create).not.toHaveBeenCalled()

    fireEvent.change(amount, { target: { value: '1234,56' } })
    expect(amount).toHaveValue('1.234,56')
    await user.click(screen.getByRole('button', { name: 'Registrar despesa' }))
    await waitFor(() => expect(expensesApi.create).toHaveBeenCalledWith(expect.objectContaining({ amount: '1234.56' })))
  })

  it('loads an existing amount into the edit field and updates it without losing cents', async () => {
    const user = userEvent.setup()
    await renderPage()
    await user.click(await screen.findByRole('button', { name: 'Editar despesa Aluguel' }))

    const amount = screen.getByLabelText('Valor *')
    expect(amount).toHaveValue('1.234,56')
    await user.click(screen.getByRole('button', { name: 'Cancelar' }))
    await user.click(screen.getByRole('button', { name: 'Editar despesa Aluguel' }))
    await user.click(screen.getByRole('button', { name: 'Salvar alterações' }))
    await waitFor(() => expect(expensesApi.update).toHaveBeenCalledWith('expense-1', expect.objectContaining({ amount: '1234.56' })))
  })

  it('shows a recoverable error when expenses cannot be loaded', async () => {
    const user = userEvent.setup()
    vi.mocked(expensesApi.list).mockRejectedValueOnce(new Error('offline'))
    await renderPage()

    expect(await screen.findByRole('alert')).toHaveTextContent('Não foi possível conectar ao serviço.')
    await user.click(screen.getByRole('button', { name: 'Tentar novamente' }))

    expect(await screen.findByText('Aluguel')).toBeVisible()
  })

  it('shows loading and mutation success states when creating an expense', async () => {
    const user = userEvent.setup()
    const initialLoad = deferred<{ items: Array<typeof expense> }>()
    const createRequest = deferred<typeof expense>()
    vi.mocked(expensesApi.list)
      .mockReturnValueOnce(initialLoad.promise)
      .mockResolvedValueOnce({ items: [expense] })
    vi.mocked(expensesApi.create).mockReturnValueOnce(createRequest.promise)
    await renderPage()

    expect(screen.getByRole('status')).toHaveTextContent('Carregando despesas')
    initialLoad.resolve({ items: [expense] })
    await screen.findByText('Aluguel')
    await user.click(screen.getByRole('button', { name: /Nova despesa/ }))
    fireEvent.change(screen.getByLabelText('Valor *'), { target: { value: '250,00' } })
    await user.click(screen.getByRole('button', { name: 'Registrar despesa' }))

    expect(screen.getByRole('button', { name: 'Salvando…' })).toBeVisible()
    createRequest.resolve(expense)
    expect(await screen.findByRole('status')).toHaveTextContent('Despesa registrada.')
  })

  it('explains the expense-category prerequisite even when the month already has records', async () => {
    vi.mocked(categoriesApi.list).mockResolvedValueOnce({ items: [] })
    await renderPage()

    const prerequisite = await screen.findByRole('note')
    expect(prerequisite).toHaveTextContent('Para registrar uma despesa, primeiro')
    expect(prerequisite.querySelector('a')).toHaveAttribute('href', '/categories')
    expect(screen.getByRole('button', { name: /Nova despesa/ })).toBeDisabled()
    expect(await screen.findByText('Aluguel')).toBeVisible()
  })

  it('associates an optional payment method when creating an expense and shows its historical label', async () => {
    const user = userEvent.setup()
    const paymentMethod = { id: 'pix', name: 'Pix', nature: 'immediate' as const, isActive: true }
    vi.mocked(paymentMethodsApi.list).mockResolvedValue({ items: [paymentMethod] })
    const savedExpense = { ...expense, paymentMethodId: 'pix', paymentMethodName: 'Pix', paymentMethodNature: 'immediate' as const }
    vi.mocked(expensesApi.list).mockResolvedValue({ items: [savedExpense] })
    vi.mocked(expensesApi.create).mockResolvedValue(savedExpense)
    await renderPage()

    expect(await screen.findByText(/Pix \(Imediata/)).toBeVisible()
    await user.click(screen.getByRole('button', { name: /Nova despesa/ }))
    await user.type(screen.getByLabelText('Valor *'), '250,00')
    await user.selectOptions(screen.getByLabelText(/Forma de pagamento/), 'pix')
    await user.click(screen.getByRole('button', { name: 'Registrar despesa' }))

    await waitFor(() => expect(expensesApi.create).toHaveBeenCalledWith(expect.objectContaining({ paymentMethodId: 'pix' })))
  })

  it('keeps an inactive payment method visible in history and while editing the expense', async () => {
    const user = userEvent.setup()
    const historicalExpense = { ...expense, paymentMethodId: 'old-card', paymentMethodName: 'Cartão antigo', paymentMethodNature: 'credit_card' as const }
    vi.mocked(expensesApi.list).mockResolvedValue({ items: [historicalExpense] })
    vi.mocked(paymentMethodsApi.list).mockResolvedValue({ items: [] })
    await renderPage()

    expect(await screen.findByText(/Cartão antigo \(Cartão de crédito\)/)).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Editar despesa Aluguel' }))
    expect(screen.getByRole('option', { name: 'Cartão antigo (inativa)' })).toBeVisible()
    expect(screen.getByLabelText(/Forma de pagamento/)).toHaveValue('old-card')
  })

  it('requires an active credit card when the selected payment method is credit', async () => {
    const user = userEvent.setup()
    vi.mocked(paymentMethodsApi.list).mockResolvedValue({ items: [{ id: 'credit', name: 'Crédito', nature: 'credit_card', isActive: true }] })
    vi.mocked(creditCardsApi.list).mockResolvedValue({ items: [{ id: 'card-1', nickname: 'Principal', closingDay: 10, dueDay: 17, isActive: true }] })
    await renderPage()
    await user.click(await screen.findByRole('button', { name: /Nova despesa/ }))
    await user.type(screen.getByLabelText('Valor *'), '250,00')
    await user.selectOptions(screen.getByLabelText(/Forma de pagamento/), 'credit')
    expect(screen.getByLabelText('Cartão de crédito *')).toBeRequired()
    await user.selectOptions(screen.getByLabelText('Cartão de crédito *'), 'card-1')
    await user.click(screen.getByRole('button', { name: 'Registrar despesa' }))
    await waitFor(() => expect(expensesApi.create).toHaveBeenCalledWith(expect.objectContaining({ paymentMethodId: 'credit', creditCardId: 'card-1' })))
  })
})
