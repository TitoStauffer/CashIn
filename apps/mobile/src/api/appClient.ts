import Constants from 'expo-constants'

import { createAuthApi, type AuthApi } from '../auth/authApi'
import { createCatalogApi, type CatalogApi } from '../catalog/catalogApi'
import { tokenStorage } from '../auth/tokenStorage'
import { resolveApiBaseUrl } from '../config/apiUrl'
import { getActiveWalletId } from '../wallets/activeWallet'
import { createWalletApi, type WalletApi } from '../wallets/walletApi'
import { createApiClient, type ApiClient, type ApiRequestOptions } from './client'

/**
 * The app's API client, wired to the real configuration, the secure token storage and the active
 * wallet. Built on first use, so a missing API address surfaces as an error on the screen that needed
 * it instead of a crash while the bundle loads.
 */
let client: ApiClient | null = null
let unauthorizedHandler: ((rejectedToken: string) => void) | null = null
let walletNotFoundHandler: ((walletId: string) => void) | null = null

export function getApiClient(): ApiClient {
  client ??= createApiClient({
    baseUrl: resolveApiBaseUrl({
      envUrl: process.env.EXPO_PUBLIC_API_URL,
      devServerHostUri: Constants.expoConfig?.hostUri,
      isDevelopment: __DEV__,
    }),
    getToken: () => tokenStorage.read(),
    getActiveWalletId,
    onUnauthorized: (rejectedToken) => unauthorizedHandler?.(rejectedToken),
    onWalletNotFound: (walletId) => walletNotFoundHandler?.(walletId),
  })
  return client
}

function register<T>(set: (handler: T | null) => void, get: () => T | null, handler: T): () => void {
  set(handler)
  return () => {
    if (get() === handler) set(null)
  }
}

/** The session registers here to hear about a `401`; the returned function unregisters it. */
export function registerUnauthorizedHandler(handler: (rejectedToken: string) => void): () => void {
  return register((value) => { unauthorizedHandler = value }, () => unauthorizedHandler, handler)
}

/** The wallets register here to hear about a 404 for the wallet a request was scoped to. */
export function registerWalletNotFoundHandler(handler: (walletId: string) => void): () => void {
  return register((value) => { walletNotFoundHandler = value }, () => walletNotFoundHandler, handler)
}

// The client is resolved on each call, not at import, for the reason above.
const lazyClient: ApiClient = <T,>(path: string, options?: ApiRequestOptions) => getApiClient()<T>(path, options)

export const appAuthApi: AuthApi = createAuthApi(lazyClient)
export const appWalletApi: WalletApi = createWalletApi(lazyClient)
export const appCatalogApi: CatalogApi = createCatalogApi(lazyClient)
