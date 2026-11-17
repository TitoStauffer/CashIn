import Constants from 'expo-constants'

import { tokenStorage } from '../auth/tokenStorage'
import { resolveApiBaseUrl } from '../config/apiUrl'
import { createApiClient, type ApiClient } from './client'

/**
 * The app's API client, wired to the real configuration and the secure token storage. Built on first
 * use, so a missing API address surfaces as an error on the screen that needed it instead of a crash
 * while the bundle loads. The active wallet arrives with DEV-143; until then requests carry none, and
 * the API falls back to the personal wallet.
 */
let client: ApiClient | null = null

export function getApiClient(): ApiClient {
  client ??= createApiClient({
    baseUrl: resolveApiBaseUrl({
      envUrl: process.env.EXPO_PUBLIC_API_URL,
      devServerHostUri: Constants.expoConfig?.hostUri,
      isDevelopment: __DEV__,
    }),
    getToken: () => tokenStorage.read(),
    getActiveWalletId: () => null,
  })
  return client
}
