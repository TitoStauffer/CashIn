import * as SecureStore from 'expo-secure-store'

/**
 * The active wallet, in two places:
 * - in memory, read by the HTTP client on every scoped request to send `X-Wallet-Id`;
 * - on the device, per account, so the choice survives closing the app. It is an identifier, not a
 *   secret, but the app has no plain storage on purpose (see `tokenStorage.ts`), so it uses the same
 *   secure store, under a key of its own.
 */
let currentWalletId: string | null = null

export function getActiveWalletId(): string | null {
  return currentWalletId
}

export function setActiveWalletId(walletId: string | null): void {
  currentWalletId = walletId
}

// Secure store keys accept letters, digits, `.`, `-` and `_`; a user id is a UUID.
const keyFor = (userId: string) => `saldocerto.active-wallet.${userId.replace(/[^A-Za-z0-9._-]/g, '_')}`

export const activeWalletStorage = {
  read(userId: string): Promise<string | null> {
    return SecureStore.getItemAsync(keyFor(userId))
  },
  save(userId: string, walletId: string): Promise<void> {
    return SecureStore.setItemAsync(keyFor(userId), walletId)
  },
}

export type ActiveWalletStorage = typeof activeWalletStorage
