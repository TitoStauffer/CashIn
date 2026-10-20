import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WalletProvider } from './WalletContext'
import { useWallet } from './useWallet'
import { setRequestWalletId, storeWalletId, walletApi } from './walletApi'

function WalletName() {
  const { activeWallet } = useWallet()
  return <p>{activeWallet?.name}</p>
}

describe('wallet provider preferred selection', () => {
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    window.localStorage.clear()
    setRequestWalletId(null)
  })

  it('selects a requested wallet only when it belongs to the current user', async () => {
    vi.spyOn(walletApi, 'list').mockResolvedValue({ items: [
      { id: 'wallet-personal', name: 'Pessoal', isPersonal: true, role: 'owner' },
      { id: 'wallet-shared', name: 'Família', isPersonal: false, role: 'owner' },
    ] })
    storeWalletId('user-1', 'wallet-personal')

    render(<WalletProvider userId="user-1" preferredWalletId="wallet-shared"><WalletName /></WalletProvider>)

    expect(await screen.findByText('Família')).toBeVisible()
  })

  it('keeps the existing stored-wallet fallback when the requested wallet is unavailable', async () => {
    vi.spyOn(walletApi, 'list').mockResolvedValue({ items: [
      { id: 'wallet-personal', name: 'Pessoal', isPersonal: true, role: 'owner' },
      { id: 'wallet-shared', name: 'Família', isPersonal: false, role: 'owner' },
    ] })
    storeWalletId('user-1', 'wallet-personal')

    render(<WalletProvider userId="user-1" preferredWalletId="wallet-not-accessible"><WalletName /></WalletProvider>)

    expect(await screen.findByText('Pessoal')).toBeVisible()
  })
})
