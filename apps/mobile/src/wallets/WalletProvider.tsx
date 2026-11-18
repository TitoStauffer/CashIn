import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'

import { useSession } from '../auth/SessionProvider'
import type { ActiveWalletStorage } from './activeWallet'
import type { Wallet, WalletApi } from './walletApi'

export const WALLET_UNAVAILABLE_NOTICE = 'A carteira escolhida não está mais disponível. Voltamos para a sua carteira pessoal.'
const LOAD_FAILED_MESSAGE = 'Não foi possível carregar suas carteiras. Tente novamente.'

export type WalletState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; wallets: Wallet[]; activeWalletId: string; notice?: string }

export type WalletContextValue = {
  state: WalletState
  activeWallet: Wallet | null
  selectWallet(walletId: string): void
  createWallet(name: string): Promise<void>
  reload(): void
  dismissNotice(): void
}

const WalletContext = createContext<WalletContextValue | null>(null)

/** The stored choice when it is still one of the wallets, then the personal wallet, then the first. */
function chooseWallet(wallets: Wallet[], storedId: string | null): { wallet: Wallet | undefined; lostStored: boolean } {
  const stored = wallets.find((wallet) => wallet.id === storedId)
  if (stored) return { wallet: stored, lostStored: false }
  return { wallet: wallets.find((wallet) => wallet.isPersonal) ?? wallets[0], lostStored: storedId !== null }
}

// What was loaded, and for which account and attempt: the screen state is derived from it, so a sign-out
// or a retry never shows the wallets of a previous load.
type Loaded = { userId: string; attempt: number; state: Extract<WalletState, { status: 'ready' | 'error' }> }

/**
 * The wallets of the signed-in account and the active one. The active wallet is what every scoped
 * request sends in `X-Wallet-Id` (through `setActiveWalletId`), and the choice is kept on the device
 * per account. A stored or active wallet that is no longer one of the account's — removed, or access
 * revoked — falls back to the personal wallet with a notice, the same way the Web does. The API answers
 * 404 for a wallet without access; that answer makes the provider check the list again.
 */
export function WalletProvider({
  walletApi,
  storage,
  setActiveWalletId,
  registerWalletNotFoundHandler,
  children,
}: {
  walletApi: WalletApi
  storage: ActiveWalletStorage
  setActiveWalletId(walletId: string | null): void
  /** Lets the HTTP client report a 404 for the wallet it sent; returns the unregister function. */
  registerWalletNotFoundHandler(handler: (walletId: string) => void): () => void
  children: ReactNode
}) {
  const { state: session } = useSession()
  const userId = session.status === 'signedIn' ? session.user.id : null
  const [attempt, setAttempt] = useState(0)
  const [loaded, setLoaded] = useState<Loaded | null>(null)

  const activate = useCallback((walletId: string) => {
    setActiveWalletId(walletId)
    if (userId) void storage.save(userId, walletId).catch(() => undefined)
  }, [setActiveWalletId, storage, userId])

  useEffect(() => {
    if (!userId) {
      setActiveWalletId(null)
      return
    }
    let current = true
    void Promise.all([walletApi.list(), storage.read(userId).catch(() => null)])
      .then(([{ items }, storedId]) => {
        if (!current) return
        const { wallet, lostStored } = chooseWallet(items, storedId)
        if (!wallet) {
          setLoaded({ userId, attempt, state: { status: 'error', message: LOAD_FAILED_MESSAGE } })
          return
        }
        activate(wallet.id)
        setLoaded({
          userId,
          attempt,
          state: { status: 'ready', wallets: items, activeWalletId: wallet.id, ...(lostStored ? { notice: WALLET_UNAVAILABLE_NOTICE } : {}) },
        })
      })
      .catch((error: unknown) => {
        if (current) setLoaded({ userId, attempt, state: { status: 'error', message: error instanceof Error && error.message ? error.message : LOAD_FAILED_MESSAGE } })
      })
    return () => { current = false }
  }, [userId, attempt, walletApi, storage, setActiveWalletId, activate])

  // A ready list of the same account stays on screen while it is refreshed; an error shows loading again.
  let state: WalletState
  if (!userId) state = { status: 'idle' }
  else if (!loaded || loaded.userId !== userId) state = { status: 'loading' }
  else if (loaded.state.status === 'error' && loaded.attempt !== attempt) state = { status: 'loading' }
  else state = loaded.state

  const reload = useCallback(() => setAttempt((value) => value + 1), [])

  // The 404 handler runs outside render, so it reads the active wallet from a ref kept in step by an effect.
  const activeWalletIdRef = useRef<string | null>(null)
  const activeWalletId = state.status === 'ready' ? state.activeWalletId : null
  useEffect(() => { activeWalletIdRef.current = activeWalletId }, [activeWalletId])

  useEffect(() => registerWalletNotFoundHandler((walletId) => {
    if (walletId === activeWalletIdRef.current) reload()
  }), [registerWalletNotFoundHandler, reload])

  const selectWallet = useCallback((walletId: string) => {
    if (!loaded || loaded.state.status !== 'ready' || !loaded.state.wallets.some((wallet) => wallet.id === walletId)) return
    activate(walletId)
    setLoaded({ ...loaded, state: { status: 'ready', wallets: loaded.state.wallets, activeWalletId: walletId } })
  }, [activate, loaded])

  const createWallet = useCallback(async (name: string) => {
    const wallet = await walletApi.create(name)
    activate(wallet.id)
    setLoaded((previous) => (previous && previous.state.status === 'ready'
      ? { ...previous, state: { status: 'ready', wallets: [...previous.state.wallets, wallet], activeWalletId: wallet.id } }
      : previous))
  }, [activate, walletApi])

  const dismissNotice = useCallback(() => {
    setLoaded((previous) => (previous && previous.state.status === 'ready'
      ? { ...previous, state: { status: 'ready', wallets: previous.state.wallets, activeWalletId: previous.state.activeWalletId } }
      : previous))
  }, [])

  const activeWallet = state.status === 'ready' ? state.wallets.find((wallet) => wallet.id === state.activeWalletId) ?? null : null
  const value = useMemo(
    () => ({ state, activeWallet, selectWallet, createWallet, reload, dismissNotice }),
    [state, activeWallet, selectWallet, createWallet, reload, dismissNotice],
  )
  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>
}

export function useWallets(): WalletContextValue {
  const value = useContext(WalletContext)
  if (!value) throw new Error('useWallets must be used inside WalletProvider')
  return value
}
