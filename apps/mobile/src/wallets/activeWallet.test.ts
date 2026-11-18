import * as SecureStore from 'expo-secure-store'

import { activeWalletStorage, getActiveWalletId, setActiveWalletId } from './activeWallet'

jest.mock('expo-secure-store', () => {
  const store = new Map<string, string>()
  return {
    setItemAsync: jest.fn(async (key: string, value: string) => { store.set(key, value) }),
    getItemAsync: jest.fn(async (key: string) => store.get(key) ?? null),
  }
})

describe('active wallet', () => {
  it('holds the wallet the HTTP client sends in X-Wallet-Id', () => {
    setActiveWalletId('wallet-1')
    expect(getActiveWalletId()).toBe('wallet-1')
    setActiveWalletId(null)
    expect(getActiveWalletId()).toBeNull()
  })

  it('remembers the choice per account in the secure store', async () => {
    await activeWalletStorage.save('6f1e2c3d-0000-4000-8000-000000000001', 'wallet-a')
    await activeWalletStorage.save('6f1e2c3d-0000-4000-8000-000000000002', 'wallet-b')
    await expect(activeWalletStorage.read('6f1e2c3d-0000-4000-8000-000000000001')).resolves.toBe('wallet-a')
    await expect(activeWalletStorage.read('6f1e2c3d-0000-4000-8000-000000000002')).resolves.toBe('wallet-b')
    expect(SecureStore.setItemAsync).toHaveBeenCalledWith('saldocerto.active-wallet.6f1e2c3d-0000-4000-8000-000000000001', 'wallet-a')
  })

  it('keeps the storage key within the characters the secure store accepts', async () => {
    await activeWalletStorage.save('user/with:odd chars', 'wallet-c')
    expect(SecureStore.setItemAsync).toHaveBeenCalledWith('saldocerto.active-wallet.user_with_odd_chars', 'wallet-c')
  })
})
