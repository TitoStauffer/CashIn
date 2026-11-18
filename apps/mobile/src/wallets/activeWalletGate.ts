import type { SessionState } from '../auth/SessionProvider'
import { sessionRedirect } from '../auth/sessionRedirect'
import type { Wallet } from './walletApi'
import type { WalletState } from './WalletProvider'

export type ActiveWalletGate =
  | { kind: 'redirect'; href: '/login' | '/' }
  | { kind: 'error'; message: string }
  | { kind: 'loading' }
  | { kind: 'ready'; wallet: Wallet }

/**
 * What a route that works inside the active wallet shows: the session redirect first, then the wallets'
 * error with its retry, the wait while they load, and only then the screen, with the wallet it belongs to.
 * A screen never runs a scoped request before the active wallet is known.
 */
export function activeWalletGate(session: SessionState, wallets: WalletState, activeWallet: Wallet | null): ActiveWalletGate {
  const href = sessionRedirect(session)
  if (href) return { kind: 'redirect', href }
  if (wallets.status === 'error') return { kind: 'error', message: wallets.message }
  if (!activeWallet) return { kind: 'loading' }
  return { kind: 'ready', wallet: activeWallet }
}
