/**
 * The active wallet that every request carries, kept here rather than in `wallets/walletApi.ts`.
 *
 * The shared HTTP client needs this, and `walletApi` needs the client — which made the two modules
 * import each other. The cycle was harmless, because only function declarations were reached while the
 * modules evaluated, but it breaks the moment either file does anything at module top level. Holding
 * the state in its own module removes the cycle instead of relying on that.
 *
 * `wallets/walletApi.ts` re-exports both functions, so the existing callers — `WalletContext` and the
 * tests — keep importing from where they always did.
 */
let activeWalletId: string | null = null

export function setRequestWalletId(walletId: string | null) {
  activeWalletId = walletId
}

export function withActiveWallet(init: RequestInit = {}): RequestInit {
  if (!activeWalletId) return init

  const headers = new Headers(init.headers)
  headers.set('X-Wallet-Id', activeWalletId)
  return {
    ...init,
    headers,
  }
}
