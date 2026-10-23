import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CreditCardApiError, creditCardsApi } from './creditCardsApi'
import type { CreditCard, CreditCardStatement } from './creditCardsApi'
import { CreditCardsPage } from './CreditCardsPage'

const walletContext = vi.hoisted(() => ({ activeWalletId: 'wallet-1' }))
vi.mock('../wallets/useWallet', () => ({ useWallet: () => walletContext }))
vi.mock('../layout/FinancialSidebar', () => ({ FinancialSidebar: () => <nav aria-label="Navegação principal" /> }))

const card: CreditCard = { id: 'card-1', nickname: 'Principal', closingDay: 10, dueDay: 17, isActive: true }
const statement: CreditCardStatement = {
  id: 'statement-1', creditCardId: 'card-1', creditCardName: 'Principal', closingDate: '2026-10-10', dueDate: '2026-10-17',
  paidDate: null, paidAmount: null, totalAmount: '123.45',
  purchases: [{ id: 'purchase-1', amount: '123.45', date: '2026-10-03', description: 'Mercado', categoryName: 'Casa', subcategoryName: 'Alimentação' }],
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise })
  return { promise, resolve }
}

describe('CreditCardsPage', () => {
  afterEach(() => { cleanup(); vi.restoreAllMocks(); walletContext.activeWalletId = 'wallet-1' })

  it('lists cards and statements and allows paying an unpaid statement in full', async () => {
    vi.spyOn(creditCardsApi, 'list').mockResolvedValue({ items: [card] })
    vi.spyOn(creditCardsApi, 'statements').mockResolvedValue({ items: [statement] })
    const paySpy = vi.spyOn(creditCardsApi, 'payStatement').mockResolvedValue({ ...statement, paidDate: '2026-10-18', paidAmount: '123.45' })
    render(<CreditCardsPage userEmail="user@example.com" isLoggingOut={false} onLogout={vi.fn()} />)

    expect(await screen.findByRole('heading', { name: 'Cartões e faturas' })).toBeVisible()
    expect(await screen.findByText('Mercado')).toBeVisible()
    expect(screen.getAllByText('R$ 123,45')).toHaveLength(2)
    await userEvent.setup().click(screen.getByRole('button', { name: 'Pagar fatura integral' }))
    await waitFor(() => expect(paySpy).toHaveBeenCalledWith('card-1', 'statement-1', expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/)))
    expect(await screen.findByText(/Paga em 18\/10\/2026/)).toBeVisible()
  })

  it('creates cards with nickname and closing/due days', async () => {
    vi.spyOn(creditCardsApi, 'list')
      .mockResolvedValueOnce({ items: [] })
      .mockResolvedValueOnce({ items: [card] })
    const createSpy = vi.spyOn(creditCardsApi, 'create').mockResolvedValue(card)
    vi.spyOn(creditCardsApi, 'statements').mockResolvedValue({ items: [] })
    const user = userEvent.setup()
    render(<CreditCardsPage userEmail="user@example.com" isLoggingOut={false} onLogout={vi.fn()} />)
    await screen.findByRole('heading', { name: 'Nenhum cartão cadastrado' })
    await user.click(screen.getByRole('button', { name: '＋ Novo cartão' }))
    const nicknameInput = screen.getByLabelText('Apelido')
    expect(nicknameInput).toHaveAttribute('maxLength', '100')
    await user.type(nicknameInput, 'Principal')
    fireEvent.change(screen.getByLabelText('Dia de fechamento'), { target: { value: '10' } })
    fireEvent.change(screen.getByLabelText('Dia de vencimento'), { target: { value: '17' } })
    await user.click(screen.getByRole('button', { name: 'Salvar cartão' }))
    await waitFor(() => expect(createSpy).toHaveBeenCalledWith({ nickname: 'Principal', closingDay: 10, dueDay: 17 }))
  })

  it('edits an existing card and persists its updated fields', async () => {
    const updatedCard = { ...card, nickname: 'Cartão atualizado', closingDay: 12, dueDay: 20 }
    vi.spyOn(creditCardsApi, 'list').mockResolvedValue({ items: [card] })
    vi.spyOn(creditCardsApi, 'statements').mockResolvedValue({ items: [] })
    const updateSpy = vi.spyOn(creditCardsApi, 'update').mockResolvedValue(updatedCard)
    const user = userEvent.setup()
    render(<CreditCardsPage userEmail="user@example.com" isLoggingOut={false} onLogout={vi.fn()} />)

    await user.click(await screen.findByRole('button', { name: 'Editar' }))
    await user.clear(screen.getByLabelText('Apelido'))
    await user.type(screen.getByLabelText('Apelido'), updatedCard.nickname)
    fireEvent.change(screen.getByLabelText('Dia de fechamento'), { target: { value: '12' } })
    fireEvent.change(screen.getByLabelText('Dia de vencimento'), { target: { value: '20' } })
    await user.click(screen.getByRole('button', { name: 'Salvar cartão' }))

    await waitFor(() => expect(updateSpy).toHaveBeenCalledWith('card-1', { nickname: updatedCard.nickname, closingDay: 12, dueDay: 20 }))
    expect(await screen.findByRole('status')).toHaveTextContent('Cartão atualizado.')
  })

  it('rejects blank names and out-of-range days before submitting', async () => {
    vi.spyOn(creditCardsApi, 'list').mockResolvedValue({ items: [card] })
    vi.spyOn(creditCardsApi, 'statements').mockResolvedValue({ items: [] })
    const updateSpy = vi.spyOn(creditCardsApi, 'update')
    const user = userEvent.setup()
    render(<CreditCardsPage userEmail="user@example.com" isLoggingOut={false} onLogout={vi.fn()} />)

    await user.click(await screen.findByRole('button', { name: 'Editar' }))
    await user.clear(screen.getByLabelText('Apelido'))
    fireEvent.submit(screen.getByRole('form', { name: 'Editar cartão' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Informe um apelido e dias')

    await user.type(screen.getByLabelText('Apelido'), 'Principal')
    fireEvent.change(screen.getByLabelText('Dia de fechamento'), { target: { value: '32' } })
    fireEvent.submit(screen.getByRole('form', { name: 'Editar cartão' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Informe um apelido e dias')
    expect(updateSpy).not.toHaveBeenCalled()
  })

  it('activates and deactivates cards and selects another active card', async () => {
    const secondCard: CreditCard = { ...card, id: 'card-2', nickname: 'Reserva' }
    vi.spyOn(creditCardsApi, 'list').mockResolvedValue({ items: [card, secondCard] })
    vi.spyOn(creditCardsApi, 'statements').mockResolvedValue({ items: [] })
    const updateSpy = vi.spyOn(creditCardsApi, 'update')
      .mockResolvedValueOnce({ ...card, isActive: false })
      .mockResolvedValueOnce(card)
    const user = userEvent.setup()
    render(<CreditCardsPage userEmail="user@example.com" isLoggingOut={false} onLogout={vi.fn()} />)

    await user.click((await screen.findAllByRole('button', { name: 'Desativar' }))[0])
    expect(await screen.findByRole('status')).toHaveTextContent('Cartão desativado.')
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Selecionar cartão para consultar faturas' })).toHaveValue('card-2'))
    const activateButtons = screen.getAllByRole('button', { name: 'Ativar' })
    await user.click(activateButtons[0])
    expect(await screen.findByRole('status')).toHaveTextContent('Cartão ativado.')
    expect(updateSpy).toHaveBeenNthCalledWith(1, 'card-1', { isActive: false })
    expect(updateSpy).toHaveBeenNthCalledWith(2, 'card-1', { isActive: true })
  })

  it('shows a recoverable load error and retries the card request', async () => {
    vi.spyOn(creditCardsApi, 'list')
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({ items: [] })
    const user = userEvent.setup()
    render(<CreditCardsPage userEmail="user@example.com" isLoggingOut={false} onLogout={vi.fn()} />)

    expect(await screen.findByRole('alert')).toHaveTextContent('Não foi possível carregar cartões e faturas')
    expect(screen.queryByRole('heading', { name: 'Nenhum cartão cadastrado' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Tentar novamente' }))
    expect(await screen.findByRole('heading', { name: 'Nenhum cartão cadastrado' })).toBeVisible()
  })

  it('uses the API fallback for an empty server error and retries a statement request', async () => {
    vi.spyOn(creditCardsApi, 'list').mockResolvedValue({ items: [card] })
    vi.spyOn(creditCardsApi, 'statements')
      .mockRejectedValueOnce(new CreditCardApiError('', 503))
      .mockResolvedValueOnce({ items: [] })
    const user = userEvent.setup()
    render(<CreditCardsPage userEmail="user@example.com" isLoggingOut={false} onLogout={vi.fn()} />)

    expect(await screen.findByRole('alert')).toHaveTextContent('Não foi possível carregar cartões e faturas')
    expect(screen.queryByText('Nenhuma fatura neste período')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Tentar novamente' }))
    expect(await screen.findByText('Faturas com fechamento em outubro de 2026.')).toBeVisible()
    expect(await screen.findByText('As faturas aparecerão aqui conforme houver compras no cartão.')).toBeVisible()
  })

  it('renders paid invoices without a payment action and supports missing paid amount', async () => {
    vi.spyOn(creditCardsApi, 'list').mockResolvedValue({ items: [card] })
    vi.spyOn(creditCardsApi, 'statements').mockResolvedValue({ items: [{
      ...statement, paidDate: '2026-10-18', paidAmount: null, purchases: [],
    }] })
    render(<CreditCardsPage userEmail="user@example.com" isLoggingOut={false} onLogout={vi.fn()} />)

    expect(await screen.findByText('Paga em 18/10/2026 · —')).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Pagar fatura integral' })).not.toBeInTheDocument()
  })

  it('uses the selected payment date when the server omits paidDate', async () => {
    vi.spyOn(creditCardsApi, 'list').mockResolvedValue({ items: [card] })
    vi.spyOn(creditCardsApi, 'statements').mockResolvedValue({ items: [statement] })
    const paySpy = vi.spyOn(creditCardsApi, 'payStatement').mockResolvedValue({ ...statement, paidDate: null, paidAmount: '123.45' })
    const user = userEvent.setup()
    render(<CreditCardsPage userEmail="user@example.com" isLoggingOut={false} onLogout={vi.fn()} />)
    await screen.findByText('Mercado')
    fireEvent.change(screen.getByLabelText('Data do pagamento'), { target: { value: '2026-10-21' } })
    await user.click(screen.getByRole('button', { name: 'Pagar fatura integral' }))

    await waitFor(() => expect(paySpy).toHaveBeenCalledWith('card-1', 'statement-1', '2026-10-21'))
    expect(await screen.findByRole('status')).toHaveTextContent('Fatura paga em 21/10/2026.')
  })

  it('shows statement loading without an empty state or purchases from the previous period', async () => {
    const firstLoad = deferred<{ items: CreditCardStatement[] }>()
    const nextLoad = deferred<{ items: CreditCardStatement[] }>()
    vi.spyOn(creditCardsApi, 'list').mockResolvedValue({ items: [card] })
    vi.spyOn(creditCardsApi, 'statements').mockReturnValueOnce(firstLoad.promise).mockReturnValueOnce(nextLoad.promise)
    const user = userEvent.setup()
    render(<CreditCardsPage userEmail="user@example.com" isLoggingOut={false} onLogout={vi.fn()} />)

    expect(await screen.findByText('Carregando faturas do cartão selecionado…')).toBeVisible()
    expect(screen.queryByText('Nenhuma fatura neste período')).not.toBeInTheDocument()
    firstLoad.resolve({ items: [statement] })
    await screen.findByText('Mercado')
    await user.click(screen.getByRole('button', { name: 'Próximo mês' }))
    expect(screen.getByRole('status')).toHaveTextContent('Carregando faturas')
    expect(screen.queryByText('Mercado')).not.toBeInTheDocument()
    nextLoad.resolve({ items: [] })
    expect(await screen.findByText('Nenhuma fatura neste período')).toBeVisible()
  })

  it('explains why a statement without purchases cannot be paid', async () => {
    vi.spyOn(creditCardsApi, 'list').mockResolvedValue({ items: [card] })
    vi.spyOn(creditCardsApi, 'statements').mockResolvedValue({ items: [{ ...statement, purchases: [], totalAmount: '0.00' }] })
    render(<CreditCardsPage userEmail="user@example.com" isLoggingOut={false} onLogout={vi.fn()} />)

    const paymentButton = await screen.findByRole('button', { name: 'Pagar fatura integral' })
    expect(paymentButton).toBeDisabled()
    expect(paymentButton).toHaveAccessibleDescription(/Esta fatura não possui compras para pagar/)
  })

  it('guides statement selection after deactivating the last active card', async () => {
    vi.spyOn(creditCardsApi, 'list').mockResolvedValue({ items: [card] })
    vi.spyOn(creditCardsApi, 'statements').mockResolvedValue({ items: [statement] })
    vi.spyOn(creditCardsApi, 'update').mockResolvedValue({ ...card, isActive: false })
    const user = userEvent.setup()
    render(<CreditCardsPage userEmail="user@example.com" isLoggingOut={false} onLogout={vi.fn()} />)
    await screen.findByText('Mercado')
    await user.click(screen.getByRole('button', { name: 'Desativar' }))
    expect(await screen.findByText('Selecione um cartão para consultar suas faturas, incluindo cartões inativos.')).toBeVisible()
    expect(screen.queryByText('Mercado')).not.toBeInTheDocument()
    await user.selectOptions(screen.getByRole('combobox', { name: 'Selecionar cartão para consultar faturas' }), card.id)
    expect(await screen.findByText('Mercado')).toBeVisible()
  })

  it('uses safe payment feedback instead of exposing server details', async () => {
    const request = deferred<CreditCardStatement>()
    vi.spyOn(creditCardsApi, 'list').mockResolvedValue({ items: [card] })
    vi.spyOn(creditCardsApi, 'statements').mockResolvedValue({ items: [statement] })
    vi.spyOn(creditCardsApi, 'payStatement')
      .mockRejectedValueOnce(new CreditCardApiError('server-only-detail', 409))
      .mockReturnValueOnce(request.promise)
    const user = userEvent.setup()
    render(<CreditCardsPage userEmail="user@example.com" isLoggingOut={false} onLogout={vi.fn()} />)
    await screen.findByText('Mercado')
    await user.click(screen.getByRole('button', { name: 'Pagar fatura integral' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Esta fatura mudou ou já foi paga.')
    expect(screen.queryByText('server-only-detail')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Pagar fatura integral' }))
    expect(screen.getByRole('note')).toHaveTextContent('Registrando o pagamento integral da fatura.')
    request.resolve({ ...statement, paidDate: '2026-10-18', paidAmount: statement.totalAmount })
    expect(await screen.findByRole('status')).toHaveTextContent('Fatura paga')
  })

  it('hides cards and the previous editor while loading another wallet', async () => {
    const nextWallet = deferred<{ items: CreditCard[] }>()
    vi.spyOn(creditCardsApi, 'list').mockResolvedValueOnce({ items: [card] }).mockReturnValueOnce(nextWallet.promise)
    vi.spyOn(creditCardsApi, 'statements').mockResolvedValue({ items: [statement] })
    const user = userEvent.setup()
    const view = render(<CreditCardsPage userEmail="user@example.com" isLoggingOut={false} onLogout={vi.fn()} />)
    await user.click(await screen.findByRole('button', { name: 'Editar' }))
    walletContext.activeWalletId = 'wallet-2'
    view.rerender(<CreditCardsPage userEmail="user@example.com" isLoggingOut={false} onLogout={vi.fn()} />)
    expect(screen.getByRole('status')).toHaveTextContent('Carregando cartões')
    expect(screen.queryByLabelText('Apelido')).not.toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Principal' })).not.toBeInTheDocument()
    nextWallet.resolve({ items: [] })
    expect(await screen.findByRole('heading', { name: 'Nenhum cartão cadastrado' })).toBeVisible()
    expect(screen.queryByLabelText('Apelido')).not.toBeInTheDocument()
  })
})
