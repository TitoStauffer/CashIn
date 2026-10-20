import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CreditCardApiError, creditCardsApi } from './creditCardsApi'
import type { CreditCard, CreditCardStatement } from './creditCardsApi'
import { CreditCardsPage } from './CreditCardsPage'

vi.mock('../wallets/useWallet', () => ({ useWallet: () => ({ activeWalletId: 'wallet-1' }) }))
vi.mock('../layout/FinancialSidebar', () => ({ FinancialSidebar: () => <nav aria-label="Navegação principal" /> }))

const card: CreditCard = { id: 'card-1', nickname: 'Principal', closingDay: 10, dueDay: 17, isActive: true }
const statement: CreditCardStatement = {
  id: 'statement-1', creditCardId: 'card-1', creditCardName: 'Principal', closingDate: '2026-10-10', dueDate: '2026-10-17',
  paidDate: null, paidAmount: null, totalAmount: '123.45',
  purchases: [{ id: 'purchase-1', amount: '123.45', date: '2026-10-03', description: 'Mercado', categoryName: 'Casa', subcategoryName: 'Alimentação' }],
}

describe('CreditCardsPage', () => {
  afterEach(() => { cleanup(); vi.restoreAllMocks() })

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

    expect(await screen.findByRole('alert')).toHaveTextContent('Não foi possível conectar ao serviço')
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
})
