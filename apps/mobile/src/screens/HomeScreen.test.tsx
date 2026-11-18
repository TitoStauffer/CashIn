import { fireEvent, render, screen } from '@testing-library/react-native'

import { HomeScreen } from './HomeScreen'

const USER = { id: '1', email: 'pessoa@example.com' }

describe('HomeScreen', () => {
  it('names the account and the wallet in use, and opens the wallets', async () => {
    const onOpenWallets = jest.fn()
    await render(<HomeScreen user={USER} activeWallet={{ id: 'w', name: 'Casa', isPersonal: false, role: 'owner' }} onOpenWallets={onOpenWallets} onSignOut={jest.fn()} />)
    expect(screen.getByText('Você entrou como pessoa@example.com')).toBeTruthy()
    expect(screen.getByText('Carteira em uso: Casa')).toBeTruthy()
    await fireEvent.press(screen.getByRole('link', { name: 'Carteiras' }))
    expect(onOpenWallets).toHaveBeenCalledTimes(1)
  })

  it('signs out once', async () => {
    const onSignOut = jest.fn(() => new Promise<void>(() => undefined))
    await render(<HomeScreen user={USER} activeWallet={null} onOpenWallets={jest.fn()} onSignOut={onSignOut} />)
    expect(screen.getByText('Carregando carteiras…')).toBeTruthy()
    await fireEvent.press(screen.getByRole('button', { name: 'Sair' }))
    await fireEvent.press(screen.getByRole('button', { name: 'Sair' }))
    expect(onSignOut).toHaveBeenCalledTimes(1)
  })
})
