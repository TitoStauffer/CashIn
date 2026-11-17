/**
 * The single HTTP client every screen of the app uses to reach the API.
 *
 * It sends the session token in `Authorization: Bearer` (DEV-140) and, for routes scoped to a wallet,
 * the active wallet in `X-Wallet-Id`. It turns every failure of the request or of its response into an
 * `ApiError` whose message can be shown to the person as is: the API's own message, already in
 * Portuguese, when there is one, and a fixed Portuguese message by status otherwise. An unsafe path is
 * the one exception: it throws a plain `Error` before any request, because it is a programming error.
 * Nothing here logs: a request carries the token, and a log line on a phone is one more place for it
 * to leak.
 */
export class ApiError extends Error {
  constructor(
    message: string,
    /** The HTTP status, or 0 when no response arrived (no connection, timeout). */
    readonly status: number,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

export const DEFAULT_TIMEOUT_MS = 15_000

const STATUS_MESSAGES: Record<number, string> = {
  401: 'Sua sessão expirou. Entre novamente.',
  403: 'Você não tem permissão para esta ação.',
  404: 'Não encontramos o que você procurava.',
  429: 'Muitas tentativas. Aguarde alguns minutos e tente novamente.',
}
const SERVER_ERROR_MESSAGE = 'O servidor não conseguiu concluir a solicitação. Tente novamente.'
const GENERIC_ERROR_MESSAGE = 'Não foi possível concluir a solicitação.'
const NETWORK_ERROR_MESSAGE = 'Não foi possível conectar à API. Verifique sua conexão.'
const TIMEOUT_MESSAGE = 'A API demorou para responder. Tente novamente.'
const UNEXPECTED_RESPONSE_MESSAGE = 'A API respondeu de forma inesperada. Tente novamente.'

export type ApiClientOptions = {
  baseUrl: string
  getToken: () => Promise<string | null>
  getActiveWalletId: () => string | null
  /** Called when the API refuses the session (401), with the token that was refused. */
  onUnauthorized?: (rejectedToken: string) => void
  fetchImpl?: typeof fetch
  timeoutMs?: number
}

export type ApiRequestOptions = {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  body?: unknown
  /**
   * Whether the request carries the active wallet. True for every financial route; false for the
   * auth routes and the wallet routes themselves, which cannot be scoped by the wallet being chosen.
   */
  scopeToActiveWallet?: boolean
  /** Whether a 401 on this request ends the app session through `onUnauthorized`. True by default. */
  reportUnauthorized?: boolean
}

export type ApiClient = <T>(path: string, options?: ApiRequestOptions) => Promise<T>

export function createApiClient({
  baseUrl,
  getToken,
  getActiveWalletId,
  onUnauthorized,
  fetchImpl = fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}: ApiClientOptions): ApiClient {
  return async function request<T>(path: string, { method = 'GET', body, scopeToActiveWallet = true, reportUnauthorized = true }: ApiRequestOptions = {}): Promise<T> {
    const headers: Record<string, string> = { Accept: 'application/json' }
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    const token = await getToken()
    if (token) headers.Authorization = `Bearer ${token}`
    const walletId = scopeToActiveWallet ? getActiveWalletId() : null
    if (walletId) headers['X-Wallet-Id'] = walletId

    // Checked before the request, outside the `try` below: an unsafe path is a programming error, and
    // inside it the refusal would surface as a connection failure.
    const url = `${baseUrl}${assertSafeApiPath(path)}`
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    let response: Response
    try {
      response = await fetchImpl(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      })
    } catch {
      throw new ApiError(controller.signal.aborted ? TIMEOUT_MESSAGE : NETWORK_ERROR_MESSAGE, 0)
    } finally {
      clearTimeout(timer)
    }

    if (!response.ok) {
      // A 401 ends the session only when the request carried one: a wrong password on the login is a
      // 401 too, and is not an expired session. The logout opts out, since ending the session is what
      // it was already doing.
      if (response.status === 401 && token && reportUnauthorized) onUnauthorized?.(token)
      throw new ApiError(await errorMessage(response), response.status)
    }
    if (response.status === 204) return undefined as T
    try {
      return (await response.json()) as T
    } catch {
      // A success without a JSON body is not what any route answers; it is reported like any other
      // failure, in Portuguese, instead of as a parser error.
      throw new ApiError(UNEXPECTED_RESPONSE_MESSAGE, response.status)
    }
  }
}

async function errorMessage(response: Response): Promise<string> {
  const body = (await response.json().catch(() => null)) as { message?: unknown } | null
  if (typeof body?.message === 'string' && body.message.trim()) return body.message
  if (STATUS_MESSAGES[response.status]) return STATUS_MESSAGES[response.status] as string
  return response.status >= 500 ? SERVER_ERROR_MESSAGE : GENERIC_ERROR_MESSAGE
}

/**
 * A path is appended to the configured API address, so it must stay under it: absolute, not
 * protocol-relative, without a scheme of its own and without a `.` or `..` segment in any spelling —
 * the percent-encoded forms (`%2e%2e`, `.%2E`) included, since the server decodes them. A path whose
 * escapes do not decode is refused too. Same rule as the Web's `requestPath.ts`.
 */
export function assertSafeApiPath(path: string): string {
  const pathname = path.split('?')[0] ?? ''
  let decoded: string
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    throw new Error(`Unsafe API path: ${path}`)
  }
  const unsafe = !path.startsWith('/')
    || path.startsWith('//')
    || decoded.includes('\\')
    || decoded.startsWith('//')
    || /(^|\/)\.\.?(\/|$)/.test(decoded)
    || /^\/[a-z][a-z0-9+.-]*:/i.test(decoded)
  if (unsafe) throw new Error(`Unsafe API path: ${path}`)
  return path
}
