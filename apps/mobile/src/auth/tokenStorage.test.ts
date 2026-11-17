import * as SecureStore from 'expo-secure-store'

import packageJson from '../../package.json'
import { SESSION_TOKEN_KEY, tokenStorage } from './tokenStorage'

jest.mock('expo-secure-store', () => {
  const store = new Map<string, string>()
  return {
    WHEN_UNLOCKED_THIS_DEVICE_ONLY: 6,
    setItemAsync: jest.fn(async (key: string, value: string) => { store.set(key, value) }),
    getItemAsync: jest.fn(async (key: string) => store.get(key) ?? null),
    deleteItemAsync: jest.fn(async (key: string) => { store.delete(key) }),
  }
})

const TOKEN = 'tokenDeSessaoMovel'.padEnd(43, 'x')
const OPTIONS = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY }

describe('tokenStorage', () => {
  it('keeps the token in the secure store, readable only while the device is unlocked', async () => {
    await tokenStorage.save(TOKEN)
    expect(SecureStore.setItemAsync).toHaveBeenCalledWith(SESSION_TOKEN_KEY, TOKEN, OPTIONS)
    await expect(tokenStorage.read()).resolves.toBe(TOKEN)
    expect(SecureStore.getItemAsync).toHaveBeenCalledWith(SESSION_TOKEN_KEY, OPTIONS)

    await tokenStorage.clear()
    expect(SecureStore.deleteItemAsync).toHaveBeenCalledWith(SESSION_TOKEN_KEY, OPTIONS)
    await expect(tokenStorage.read()).resolves.toBeNull()
  })

  it('never writes the token to the console', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((method) => jest.spyOn(console, method).mockImplementation(() => undefined))
    try {
      await tokenStorage.save(TOKEN)
      await tokenStorage.read()
      await tokenStorage.clear()
      for (const spy of spies) expect(spy).not.toHaveBeenCalled()
    } finally {
      for (const spy of spies) spy.mockRestore()
    }
  })

  // AsyncStorage is plain storage: a token there is readable from a backup or a rooted device. The app
  // does not even depend on it, so no code path can reach it by accident.
  it('has no dependency on AsyncStorage', () => {
    const dependencies = { ...packageJson.dependencies, ...packageJson.devDependencies }
    expect(Object.keys(dependencies).filter((name) => /async-storage/i.test(name))).toEqual([])
  })
})
