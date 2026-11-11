import { withActiveWallet } from './activeWallet'
import { assertSafeApiPath } from './requestPath'

/**
 * The single HTTP client every feature module uses.
 *
 * Seven of the nine domain modules carried a private `request` that differed only in the error class it
 * threw — same path concatenation, same credentials, same conditional JSON header, same 204 handling.
 * The other two diverged, and they are why this helper takes options: `dashboardApi` had a different
 * signature, took a bare `AbortSignal`, and handled neither 204 nor the conditional header, while
 * `walletApi` never attached the active wallet, because the wallet routes cannot be scoped by the
 * wallet already chosen.
 *
 * DEV-105 added one line to each of them and SonarCloud reported the result as duplication above the
 * gate's limit, which was fair: the duplication predated the change, and nine copies of a rule about
 * reaching the API is nine places to forget it. Collapsing them here also puts the behaviour under one
 * set of tests, instead of spreading it across modules whose own tests mock the API wholesale and never
 * execute `request` at all.
 *
 * `authApi` was the tenth client and stayed out of DEV-105, because it built relative paths the path guard
 * refuses. DEV-123 moved it here with absolute paths, so every HTTP client of the Web now uses this helper
 * and every path goes through `assertSafeApiPath`.
 */
type ApiErrorConstructor = new (message: string, status: number) => Error

type ErrorResponse = { message?: string }

export type ApiRequestOptions = {
  /**
   * Whether the request carries the active wallet. True for every domain, and false for two kinds of route:
   * the wallet routes themselves, since picking or listing wallets cannot be scoped by the wallet already
   * chosen, and the auth routes, which run before or regardless of any wallet and never read the header.
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
        // `importsApi` had before this helper existed: it posts a `File` for uploads, with its own
        // `Content-Type: application/octet-stream`. A truthy check happens to work for that caller,
        // since an explicit header wins the spread below — but it would impose JSON on the next
        // non-string body whose sender does not set one, which is close enough to be a trap.
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
