import { fireEvent, render, screen } from '@testing-library/react-native'

import { HomeScreen } from './HomeScreen'

const USER = { id: '1', email: 'pessoa@example.com' }

describe('HomeScreen', () => {
  it('names the account and the wallet in use, and opens the wallets', async () => {
    const onOpenWallets = jest.fn()
    await render(<HomeScreen user={USER} activeWallet={{ id: 'w', name: 'Casa', isPersonal: false, role: 'owner' }} onOpenWallets={onOpenWallets} onOpenCategories={jest.fn()} onOpenPaymentMethods={jest.fn()} onSignOut={jest.fn()} />)
    expect(screen.getByText('Você entrou como pessoa@example.com')).toBeTruthy()
    expect(screen.getByText('Carteira em uso: Casa')).toBeTruthy()
    await fireEvent.press(screen.getByRole('link', { name: 'Carteiras' }))
    expect(onOpenWallets).toHaveBeenCalledTimes(1)
  })

  it('opens the categories and the payment methods', async () => {
    const onOpenCategories = jest.fn()
    const onOpenPaymentMethods = jest.fn()
    await render(<HomeScreen user={USER} activeWallet={null} onOpenWallets={jest.fn()} onOpenCategories={onOpenCategories} onOpenPaymentMethods={onOpenPaymentMethods} onSignOut={jest.fn()} />)
    await fireEvent.press(screen.getByRole('link', { name: 'Categorias' }))
    await fireEvent.press(screen.getByRole('link', { name: 'Formas de pagamento' }))
    expect(onOpenCategories).toHaveBeenCalledTimes(1)
    expect(onOpenPaymentMethods).toHaveBeenCalledTimes(1)
  })

  // Code Review of PR #122 (round 2): a failed load used to keep saying the wallets were loading.
  it('says the wallets could not be loaded instead of claiming they are still loading', async () => {
    await render(<HomeScreen user={USER} activeWallet={null} walletError="Não foi possível carregar suas carteiras. Tente novamente." onOpenWallets={jest.fn()} onOpenCategories={jest.fn()} onOpenPaymentMethods={jest.fn()} onSignOut={jest.fn()} />)
    expect(screen.getByText('Não foi possível carregar suas carteiras. Tente novamente.')).toBeTruthy()
    expect(screen.queryByText('Carregando carteiras…')).toBeNull()
  })

  it('signs out once', async () => {
    const onSignOut = jest.fn(() => new Promise<void>(() => undefined))
    await render(<HomeScreen user={USER} activeWallet={null} onOpenWallets={jest.fn()} onOpenCategories={jest.fn()} onOpenPaymentMethods={jest.fn()} onSignOut={onSignOut} />)
    expect(screen.getByText('Carregando carteiras…')).toBeTruthy()
    await fireEvent.press(screen.getByRole('button', { name: 'Sair' }))
    await fireEvent.press(screen.getByRole('button', { name: 'Sair' }))
    expect(onSignOut).toHaveBeenCalledTimes(1)
  })
})
