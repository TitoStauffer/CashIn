import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { categoriesApi } from '../categories/categoriesApi'
import { IncomesPage } from './IncomesPage'
import { incomesApi } from './incomesApi'
import { WalletProvider } from '../wallets/WalletContext'
import { walletApi } from '../wallets/walletApi'

const category = { id: 'income-category', name: 'Salário', nature: 'income' as const, subcategories: [] }
const income = {
  id: 'income-1', amount: '1234.56', date: '2026-10-01', description: 'Salário mensal',
  categoryId: category.id, categoryName: category.name, subcategoryId: null, subcategoryName: null,
  createdAt: '2026-10-01T12:00:00.000Z', updatedAt: '2026-10-01T12:00:00.000Z',
}
const personalWallet = { id: 'wallet-personal', name: 'Pessoal', isPersonal: true, role: 'owner' as const }
async function renderPage() {
  const result = render(<WalletProvider userId="user-1"><IncomesPage userEmail="tito@example.com" isLoggingOut={false} onLogout={vi.fn()} /></WalletProvider>)
  await screen.findByRole('combobox', { name: /Carteira ativa/ })
  return result
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise })
  return { promise, resolve }
}

describe('IncomesPage currency input', () => {
  beforeEach(() => {
    window.localStorage.clear()
    vi.stubGlobal('matchMedia', vi.fn(() => ({
      matches: false, media: '(max-width: 760px)', onchange: null,
      addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn(),
    })))
    vi.spyOn(categoriesApi, 'list').mockResolvedValue({ items: [category] })
    vi.spyOn(walletApi, 'list').mockResolvedValue({ items: [
      personalWallet,
      { id: 'wallet-shared', name: 'Família', isPersonal: false, role: 'member' },
    ] })
    vi.spyOn(incomesApi, 'list').mockResolvedValue({ items: [income] })
    vi.spyOn(incomesApi, 'create').mockResolvedValue(income)
    vi.spyOn(incomesApi, 'update').mockResolvedValue(income)
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('formats saved values, rejects invalid pasted values, and sends a canonical decimal on create', async () => {
    const user = userEvent.setup()
    await renderPage()
    await user.click(await screen.findByRole('button', { name: /Nova entrada/ }))

    const amount = screen.getByLabelText('Valor *')
    fireEvent.change(amount, { target: { value: '1,239' } })
    expect(amount).toHaveAttribute('aria-invalid', 'true')
    expect(screen.getByRole('alert')).toHaveTextContent('duas casas decimais')
    await user.click(screen.getByRole('button', { name: 'Registrar entrada' }))
    expect(incomesApi.create).not.toHaveBeenCalled()
    expect(screen.getAllByRole('alert')).toHaveLength(1)

    fireEvent.change(amount, { target: { value: '1234,56' } })
    expect(amount).toHaveValue('1.234,56')
    await user.click(screen.getByRole('button', { name: 'Registrar entrada' }))
    await waitFor(() => expect(incomesApi.create).toHaveBeenCalledWith(expect.objectContaining({ amount: '1234.56' })))
    expect(incomesApi.create).toHaveBeenCalledWith(expect.objectContaining({ balanceType: 'cash' }))
  })

  it('lets the user classify an income as a benefit and shows that destination in the list', async () => {
    const user = userEvent.setup()
    const benefitIncome = { ...income, balanceType: 'food_meal_benefit' as const }
    vi.mocked(incomesApi.create).mockResolvedValueOnce(benefitIncome)
    vi.mocked(incomesApi.list)
      .mockResolvedValueOnce({ items: [income] })
      .mockResolvedValueOnce({ items: [benefitIncome] })
    await renderPage()
    await user.click(await screen.findByRole('button', { name: /Nova entrada/ }))
    await user.selectOptions(screen.getByLabelText('Destino do valor *'), 'food_meal_benefit')
    expect(screen.getByLabelText('Destino do valor *')).toHaveAccessibleDescription(/VA e VR usam um único saldo/)
    fireEvent.change(screen.getByLabelText('Valor *'), { target: { value: '500,00' } })
    await user.click(screen.getByRole('button', { name: 'Registrar entrada' }))

    await waitFor(() => expect(incomesApi.create).toHaveBeenCalledWith(expect.objectContaining({ balanceType: 'food_meal_benefit' })))
    expect(await screen.findByText(/Cartão de benefícios \(VA\/VR\)/)).toBeVisible()
  })

  it('loads an existing amount into the edit field and updates it without losing cents', async () => {
    const user = userEvent.setup()
    await renderPage()
    await user.click(await screen.findByRole('button', { name: 'Editar entrada Salário mensal' }))

    const amount = screen.getByLabelText('Valor *')
    expect(amount).toHaveValue('1.234,56')
    await user.click(screen.getByRole('button', { name: 'Cancelar' }))
    await user.click(screen.getByRole('button', { name: 'Editar entrada Salário mensal' }))
    await user.click(screen.getByRole('button', { name: 'Salvar alterações' }))
    await waitFor(() => expect(incomesApi.update).toHaveBeenCalledWith('income-1', expect.objectContaining({ amount: '1234.56' })))
    expect(incomesApi.update).toHaveBeenCalledWith('income-1', expect.objectContaining({ balanceType: 'cash' }))
  })

  it('explains the historical destination without changing a legacy benefit income', async () => {
    vi.mocked(incomesApi.list).mockResolvedValueOnce({ items: [{ ...income, balanceType: 'meal_benefit' }] })
    const user = userEvent.setup()
    await renderPage()
    await user.click(await screen.findByRole('button', { name: 'Editar entrada Salário mensal' }))
    expect(screen.getByLabelText('Destino do valor *')).toHaveValue('meal_benefit')
    expect(screen.getByLabelText('Destino do valor *')).toHaveAccessibleDescription(/Este registro mantém seu destino histórico/)
  })

  it('shows a recoverable error when incomes cannot be loaded', async () => {
    const user = userEvent.setup()
    vi.mocked(incomesApi.list).mockRejectedValueOnce(new Error('offline'))
    await renderPage()

    expect(await screen.findByRole('alert')).toHaveTextContent('Não foi possível carregar as entradas.')
    await user.click(screen.getByRole('button', { name: 'Tentar novamente' }))

    expect(await screen.findByText('Salário mensal')).toBeVisible()
  })

  it('shows loading and mutation success states when creating an income', async () => {
    const user = userEvent.setup()
    const initialLoad = deferred<{ items: Array<typeof income> }>()
    const createRequest = deferred<typeof income>()
    vi.mocked(incomesApi.list)
      .mockReturnValueOnce(initialLoad.promise)
      .mockResolvedValueOnce({ items: [income] })
    vi.mocked(incomesApi.create).mockReturnValueOnce(createRequest.promise)
    await renderPage()

    expect(screen.getByRole('status')).toHaveTextContent('Carregando entradas')
    initialLoad.resolve({ items: [income] })
    await screen.findByText('Salário mensal')
    await user.click(screen.getByRole('button', { name: /Nova entrada/ }))
    fireEvent.change(screen.getByLabelText('Valor *'), { target: { value: '500,00' } })
    await user.click(screen.getByRole('button', { name: 'Registrar entrada' }))

    expect(screen.getByRole('button', { name: 'Salvando…' })).toBeVisible()
    createRequest.resolve(income)
    expect(await screen.findByRole('status')).toHaveTextContent('Entrada registrada.')
  })

  it('explains the income-category prerequisite even when the month already has records', async () => {
    vi.mocked(categoriesApi.list).mockResolvedValueOnce({ items: [] })
    await renderPage()

    const prerequisite = await screen.findByRole('note')
    expect(prerequisite).toHaveTextContent('Para registrar uma entrada, primeiro')
    expect(prerequisite.querySelector('a')).toHaveAttribute('href', '/categories')
    expect(screen.getByRole('button', { name: /Nova entrada/ })).toBeDisabled()
    expect(screen.getByRole('button', { name: /Nova entrada/ })).toHaveAccessibleDescription(/cadastre uma categoria de entrada/)
    expect(await screen.findByText('Salário mensal')).toBeVisible()
  })

  it('shows safe load feedback without a premature category prerequisite', async () => {
    const request = deferred<{ items: typeof income[] }>()
    vi.mocked(incomesApi.list).mockReturnValueOnce(request.promise)
    vi.mocked(categoriesApi.list).mockResolvedValueOnce({ items: [] })
    await renderPage()
    expect(screen.getByRole('status')).toHaveTextContent('Carregando entradas')
    expect(screen.queryByRole('note')).not.toBeInTheDocument()
    request.resolve({ items: [] })
    expect(await screen.findByRole('note')).toHaveTextContent('cadastre uma categoria de entrada')
    expect(screen.getByRole('button', { name: 'Registrar primeira entrada' })).toHaveAccessibleDescription(/cadastre uma categoria de entrada/)
  })

  it('does not display a server payload when saving fails', async () => {
    vi.mocked(incomesApi.create).mockRejectedValueOnce(Object.assign(new Error('server-only-detail'), { status: 500 }))
    const user = userEvent.setup()
    await renderPage()
    await user.click(await screen.findByRole('button', { name: /Nova entrada/ }))
    fireEvent.change(screen.getByLabelText('Valor *'), { target: { value: '100,00' } })
    await user.click(screen.getByRole('button', { name: 'Registrar entrada' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Não foi possível salvar a entrada.')
    expect(screen.queryByText('server-only-detail')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Registrar entrada' })).toBeEnabled()
  })

  it('identifies deletion and keeps its success when the edited income is removed', async () => {
    const request = deferred<void>()
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    vi.spyOn(incomesApi, 'remove').mockReturnValueOnce(request.promise)
    vi.mocked(incomesApi.list).mockResolvedValueOnce({ items: [income] }).mockResolvedValueOnce({ items: [] })
    const user = userEvent.setup()
    await renderPage()
    await user.click(await screen.findByRole('button', { name: 'Editar entrada Salário mensal' }))
    await user.click(screen.getByRole('button', { name: 'Excluir entrada Salário mensal' }))
    expect(screen.getByRole('note')).toHaveTextContent('Excluindo a entrada.')
    request.resolve()
    expect(await screen.findByRole('status')).toHaveTextContent('Entrada excluída.')
    expect(screen.queryByRole('heading', { name: 'Editar entrada' })).not.toBeInTheDocument()
    expect(await screen.findByRole('heading', { name: 'Nenhuma entrada neste mês' })).toBeVisible()
  })

  it('reloads records for the selected wallet without showing the previous wallet data', async () => {
    const user = userEvent.setup()
    const nextWalletLoad = deferred<{ items: typeof income[] }>()
    vi.mocked(incomesApi.list)
      .mockResolvedValueOnce({ items: [income] })
      .mockReturnValueOnce(nextWalletLoad.promise)
    await renderPage()
    expect(await screen.findByText('Salário mensal')).toBeVisible()

    await user.selectOptions(screen.getByRole('combobox', { name: /Carteira ativa/ }), 'wallet-shared')
    expect(screen.getByRole('status')).toHaveTextContent('Carregando entradas')
    expect(screen.queryByText('Salário mensal')).not.toBeInTheDocument()
    await waitFor(() => expect(incomesApi.list).toHaveBeenCalledTimes(2))
    nextWalletLoad.resolve({ items: [] })
    await screen.findByText('Nenhuma entrada neste mês')
  })
})
