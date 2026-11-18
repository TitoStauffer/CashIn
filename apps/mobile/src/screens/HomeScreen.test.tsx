import { fireEvent, render, screen } from '@testing-library/react-native'

import { HomeScreen } from './HomeScreen'

const USER = { id: '1', email: 'pessoa@example.com' }

describe('HomeScreen', () => {
  it('names the account and the wallet in use, and opens the wallets', async () => {
    const onOpenWallets = jest.fn()
    await render(<HomeScreen user={USER} activeWallet={{ id: 'w', name: 'Casa', isPersonal: false, role: 'owner' }} onOpenWallets={onOpenWallets} onQuickExpense={jest.fn()} onOpenExpenses={jest.fn()} onOpenCards={jest.fn()} onOpenIncomes={jest.fn()} onOpenCategories={jest.fn()} onOpenPaymentMethods={jest.fn()} onSignOut={jest.fn()} />)
    expect(screen.getByText('Você entrou como pessoa@example.com')).toBeTruthy()
    expect(screen.getByText('Carteira em uso: Casa')).toBeTruthy()
    await fireEvent.press(screen.getByRole('link', { name: 'Carteiras' }))
    expect(onOpenWallets).toHaveBeenCalledTimes(1)
  })

  it('offers the quick expense and opens the expenses, the incomes, the categories and the payment methods', async () => {
    const onQuickExpense = jest.fn()
    const onOpenExpenses = jest.fn()
    const onOpenIncomes = jest.fn()
    const onOpenCards = jest.fn()
    const onOpenCategories = jest.fn()
    const onOpenPaymentMethods = jest.fn()
    await render(<HomeScreen user={USER} activeWallet={null} onOpenWallets={jest.fn()} onQuickExpense={onQuickExpense} onOpenExpenses={onOpenExpenses} onOpenCards={onOpenCards} onOpenIncomes={onOpenIncomes} onOpenCategories={onOpenCategories} onOpenPaymentMethods={onOpenPaymentMethods} onSignOut={jest.fn()} />)
    await fireEvent.press(screen.getByRole('button', { name: 'Lançar despesa' }))
    await fireEvent.press(screen.getByRole('link', { name: 'Despesas' }))
    await fireEvent.press(screen.getByRole('link', { name: 'Entradas' }))
    await fireEvent.press(screen.getByRole('link', { name: 'Cartões' }))
    await fireEvent.press(screen.getByRole('link', { name: 'Categorias' }))
    await fireEvent.press(screen.getByRole('link', { name: 'Formas de pagamento' }))
    expect(onQuickExpense).toHaveBeenCalledTimes(1)
    expect(onOpenExpenses).toHaveBeenCalledTimes(1)
    expect(onOpenIncomes).toHaveBeenCalledTimes(1)
    expect(onOpenCards).toHaveBeenCalledTimes(1)
    expect(onOpenCategories).toHaveBeenCalledTimes(1)
    expect(onOpenPaymentMethods).toHaveBeenCalledTimes(1)
  })

  // Code Review of PR #122 (round 2): a failed load used to keep saying the wallets were loading.
  it('says the wallets could not be loaded instead of claiming they are still loading', async () => {
    await render(<HomeScreen user={USER} activeWallet={null} walletError="Não foi possível carregar suas carteiras. Tente novamente." onOpenWallets={jest.fn()} onQuickExpense={jest.fn()} onOpenExpenses={jest.fn()} onOpenCards={jest.fn()} onOpenIncomes={jest.fn()} onOpenCategories={jest.fn()} onOpenPaymentMethods={jest.fn()} onSignOut={jest.fn()} />)
    expect(screen.getByText('Não foi possível carregar suas carteiras. Tente novamente.')).toBeTruthy()
    expect(screen.queryByText('Carregando carteiras…')).toBeNull()
  })

  it('signs out once', async () => {
    const onSignOut = jest.fn(() => new Promise<void>(() => undefined))
    await render(<HomeScreen user={USER} activeWallet={null} onOpenWallets={jest.fn()} onQuickExpense={jest.fn()} onOpenExpenses={jest.fn()} onOpenCards={jest.fn()} onOpenIncomes={jest.fn()} onOpenCategories={jest.fn()} onOpenPaymentMethods={jest.fn()} onSignOut={onSignOut} />)
    expect(screen.getByText('Carregando carteiras…')).toBeTruthy()
    await fireEvent.press(screen.getByRole('button', { name: 'Sair' }))
    await fireEvent.press(screen.getByRole('button', { name: 'Sair' }))
    expect(onSignOut).toHaveBeenCalledTimes(1)
  })
})
