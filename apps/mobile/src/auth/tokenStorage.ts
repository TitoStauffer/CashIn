import * as SecureStore from 'expo-secure-store'

/**
 * Where the session token lives on the device: the Keychain on iOS and the Keystore-backed storage on
 * Android, through `expo-secure-store` — never `AsyncStorage`, which is plain storage any backup or
 * rooted device can read. On iOS the item is readable only while the device is unlocked and is never
 * migrated to another device by a backup.
 *
 * The token is never logged, and nothing here writes it anywhere else.
 */
export const SESSION_TOKEN_KEY = 'saldocerto.session-token'

const STORE_OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
}

export const tokenStorage = {
  read(): Promise<string | null> {
    return SecureStore.getItemAsync(SESSION_TOKEN_KEY, STORE_OPTIONS)
  },
  save(token: string): Promise<void> {
    return SecureStore.setItemAsync(SESSION_TOKEN_KEY, token, STORE_OPTIONS)
  },
  clear(): Promise<void> {
    return SecureStore.deleteItemAsync(SESSION_TOKEN_KEY, STORE_OPTIONS)
  },
}
