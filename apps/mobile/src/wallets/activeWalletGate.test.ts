import type { SessionState } from '../auth/SessionProvider'
import { activeWalletGate } from './activeWalletGate'
import type { Wallet } from './walletApi'
import type { WalletState } from './WalletProvider'

const SIGNED_IN: SessionState = { status: 'signedIn', user: { id: '1', email: 'pessoa@example.com' } }
const HOUSE: Wallet = { id: 'house', name: 'Casa', isPersonal: false, role: 'member' }
const READY: WalletState = { status: 'ready', wallets: [HOUSE], activeWalletId: 'house' }

describe('activeWalletGate', () => {
  it('sends a session that is not signed in away before looking at the wallets', () => {
    expect(activeWalletGate({ status: 'signedOut' }, READY, HOUSE)).toEqual({ kind: 'redirect', href: '/login' })
    expect(activeWalletGate({ status: 'restoring' }, READY, HOUSE)).toEqual({ kind: 'redirect', href: '/' })
  })

  it('shows the wallets error, so the person can retry', () => {
    expect(activeWalletGate(SIGNED_IN, { status: 'error', message: 'Falhou.' }, null)).toEqual({ kind: 'error', message: 'Falhou.' })
  })

  it('waits while the active wallet is not known yet', () => {
    expect(activeWalletGate(SIGNED_IN, { status: 'loading' }, null)).toEqual({ kind: 'loading' })
  })

  it('lets the screen run in the active wallet once it is known', () => {
    expect(activeWalletGate(SIGNED_IN, READY, HOUSE)).toEqual({ kind: 'ready', wallet: HOUSE })
  })
})
