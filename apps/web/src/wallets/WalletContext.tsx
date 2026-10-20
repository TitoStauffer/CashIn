import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { getStoredWalletId, setRequestWalletId, storeWalletId, walletApi } from './walletApi'
import type { Wallet } from './walletApi'
import { WalletContext } from './useWallet'
import type { WalletContextValue } from './useWallet'

function getWalletErrorMessage(error: unknown) {
  if (error instanceof Error && error.message.trim()) return error.message
  return 'Não foi possível carregar suas carteiras. Tente novamente.'
}

export function WalletProvider({ userId, preferredWalletId, children }: { userId: string; preferredWalletId?: string | null; children: ReactNode }) {
  const [wallets, setWallets] = useState<Wallet[]>([])
  const [activeWalletId, setActiveWalletId] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState('')
  const [isCreating, setIsCreating] = useState(false)
  const [reloadKey, setReloadKey] = useState(0)

  useEffect(() => {
    const controller = new AbortController()
    walletApi.list(controller.signal)
      .then(({ items }) => {
        setWallets(items)
        const storedWalletId = getStoredWalletId(userId)
        const nextWallet = items.find((wallet) => wallet.id === preferredWalletId)
          ?? items.find((wallet) => wallet.id === storedWalletId)
          ?? items.find((wallet) => wallet.isPersonal)
          ?? items[0]
        const nextWalletId = nextWallet?.id ?? null
        setActiveWalletId(nextWalletId)
        setRequestWalletId(nextWalletId)
        if (nextWalletId) storeWalletId(userId, nextWalletId)
      })
      .catch((cause: unknown) => {
        if (cause instanceof Error && cause.name === 'AbortError') return
        setError(getWalletErrorMessage(cause))
      })
      .finally(() => {
        if (!controller.signal.aborted) setIsLoading(false)
      })
    return () => controller.abort()
  }, [preferredWalletId, reloadKey, userId])

  const selectWallet = useCallback((walletId: string) => {
    if (!wallets.some((wallet) => wallet.id === walletId)) return
    setActiveWalletId(walletId)
    setRequestWalletId(walletId)
    storeWalletId(userId, walletId)
  }, [userId, wallets])

  const createWallet = useCallback(async (name: string) => {
    setIsCreating(true)
    try {
      const wallet = await walletApi.create(name)
      setWallets((current) => [...current, wallet])
      setActiveWalletId(wallet.id)
      setRequestWalletId(wallet.id)
      storeWalletId(userId, wallet.id)
    } finally {
      setIsCreating(false)
    }
  }, [userId])

  const reloadWallets = useCallback(() => {
    setIsLoading(true)
    setError('')
    setReloadKey((current) => current + 1)
  }, [])

  const value = useMemo<WalletContextValue>(() => ({
    wallets,
    activeWalletId,
    activeWallet: wallets.find((wallet) => wallet.id === activeWalletId) ?? null,
    isLoading,
    error,
    isCreating,
    selectWallet,
    createWallet,
    reloadWallets,
  }), [activeWalletId, createWallet, error, isCreating, isLoading, reloadWallets, selectWallet, wallets])

  if (isLoading || error || !activeWalletId) {
    return (
      <main className="wallet-provider-state" aria-live="polite">
        {isLoading ? (
          <p role="status">Carregando suas carteiras…</p>
        ) : (
          <section role="alert">
            <p>{error || 'Nenhuma carteira está disponível para esta conta.'}</p>
            <button type="button" onClick={reloadWallets}>
              Tentar novamente
            </button>
          </section>
        )}
      </main>
    )
  }

  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>
}
