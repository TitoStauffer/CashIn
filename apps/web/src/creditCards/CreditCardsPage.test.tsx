import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { creditCardsApi } from './creditCardsApi'
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
})
