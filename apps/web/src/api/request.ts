import { withActiveWallet } from '../wallets/walletApi'
import { assertSafeApiPath } from './requestPath'

/**
 * The single HTTP client every feature module uses.
 *
 * The nine domain modules each carried a private `request` that differed only in the error class it
 * threw — same path concatenation, same credentials, same conditional JSON header, same 204 handling.
 * DEV-105 added one line to each of them and SonarCloud reported the result as duplication above the
 * gate's limit, which was fair: the duplication predated the change, and nine copies of a rule about
 * reaching the API is nine places to forget it. Collapsing them here also puts the behaviour under one
 * set of tests, instead of spreading it across modules whose own tests mock the API wholesale and never
 * execute `request` at all.
 */
type ApiErrorConstructor = new (message: string, status: number) => Error

type ErrorResponse = { message?: string }

export type ApiRequestOptions = {
  /**
   * Whether the request carries the active wallet. True for every domain, and false for the wallet
   * routes themselves: picking or listing wallets cannot be scoped by the wallet already chosen.
   */
  scopeToActiveWallet?: boolean
}

export function createApiRequest(ApiError: ApiErrorConstructor, { scopeToActiveWallet = true }: ApiRequestOptions = {}) {
  return async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const requestInit: RequestInit = {
      ...init,
      credentials: 'include',
      headers: {
        // The condition is `typeof init.body === 'string'`, not a truthy check, because that is what
        // `importsApi` had before this helper existed: it posts `FormData` for uploads, which must keep
        // the boundary-carrying content type the browser sets. A truthy check works today only because
        // those callers pass a content type of their own — close enough to be a trap later.
        ...(typeof init.body === 'string' ? { 'Content-Type': 'application/json' } : {}),
        ...init.headers,
      },
    }
    // `assertSafeApiPath` is what keeps a path from leaving the `/api` root; see its own file for why a
    // convention among callers was not enough.
    const response = await fetch(`/api${assertSafeApiPath(path)}`, scopeToActiveWallet ? withActiveWallet(requestInit) : requestInit)

    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as ErrorResponse | null
      throw new ApiError(body?.message ?? '', response.status)
    }

    // A 204 carries no body, so parsing it would throw on an empty response.
    if (response.status === 204) return undefined as T
    return (await response.json()) as T
  }
}
