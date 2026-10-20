import { createContext, useContext } from 'react'
import type { Wallet } from './walletApi'

export type WalletContextValue = {
  wallets: Wallet[]
  activeWalletId: string | null
  activeWallet: Wallet | null
  isLoading: boolean
  error: string
  isCreating: boolean
  selectWallet: (walletId: string) => void
  createWallet: (name: string) => Promise<void>
  reloadWallets: () => void
}

export const WalletContext = createContext<WalletContextValue | null>(null)

export function useWallet() {
  const context = useContext(WalletContext)
  if (!context) throw new Error('useWallet must be used within WalletProvider')
  return context
}
