import Constants from 'expo-constants'

import { createAuthApi, type AuthApi } from '../auth/authApi'
import { tokenStorage } from '../auth/tokenStorage'
import { resolveApiBaseUrl } from '../config/apiUrl'
import { createApiClient, type ApiClient, type ApiRequestOptions } from './client'

/**
 * The app's API client, wired to the real configuration and the secure token storage. Built on first
 * use, so a missing API address surfaces as an error on the screen that needed it instead of a crash
 * while the bundle loads. The active wallet arrives with DEV-143; until then requests carry none, and
 * the API falls back to the personal wallet.
 */
let client: ApiClient | null = null
let unauthorizedHandler: (() => void) | null = null

export function getApiClient(): ApiClient {
  client ??= createApiClient({
    baseUrl: resolveApiBaseUrl({
      envUrl: process.env.EXPO_PUBLIC_API_URL,
      devServerHostUri: Constants.expoConfig?.hostUri,
      isDevelopment: __DEV__,
    }),
    getToken: () => tokenStorage.read(),
    getActiveWalletId: () => null,
    onUnauthorized: () => unauthorizedHandler?.(),
  })
  return client
}

/** The session registers here to hear about a `401`; the returned function unregisters it. */
export function registerUnauthorizedHandler(handler: () => void): () => void {
  unauthorizedHandler = handler
  return () => {
    if (unauthorizedHandler === handler) unauthorizedHandler = null
  }
}

// The client is resolved on each call, not at import, for the reason above.
const lazyClient: ApiClient = <T,>(path: string, options?: ApiRequestOptions) => getApiClient()<T>(path, options)

export const appAuthApi: AuthApi = createAuthApi(lazyClient)
