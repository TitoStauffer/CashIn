import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'

import { ApiError } from '../api/client'
import { ApiConfigurationError } from '../config/apiUrl'
import type { AuthApi, User } from './authApi'

export type SessionState =
  | { status: 'restoring' }
  | { status: 'unavailable'; message: string }
  | { status: 'signedOut'; notice?: string }
  | { status: 'signedIn'; user: User }

type TokenStore = {
  read(): Promise<string | null>
  save(token: string): Promise<void>
  clear(): Promise<void>
}

export type SessionContextValue = {
  state: SessionState
  signIn(email: string, password: string): Promise<void>
  signOut(): Promise<void>
  retryRestore(): void
}

export const SESSION_EXPIRED_NOTICE = 'Sua sessão expirou. Entre novamente.'
const RESTORE_FAILED_MESSAGE = 'Não foi possível verificar sua sessão.'

const SessionContext = createContext<SessionContextValue | null>(null)

/**
 * The session of the app, in one place:
 * - on launch, a stored token is checked against `GET /auth/me`, so reopening the app keeps the person
 *   signed in, and a token the API refuses (expired, ended elsewhere) is dropped and leads to the login;
 * - a failure that is not a refusal (no connection) keeps the token and offers a retry, instead of
 *   signing the person out because the phone was offline;
 * - signing in stores the token only in the secure store; signing out ends the session on the server
 *   and always drops the token from the device, even when the server cannot be reached;
 * - any later `401` from the API (`onUnauthorized`) ends the session the same way.
 */
export function SessionProvider({
  authApi,
  tokenStore,
  registerUnauthorizedHandler,
  children,
}: {
  authApi: AuthApi
  tokenStore: TokenStore
  /** Lets the HTTP client report a `401`, with the token it was sent with; returns the unregister function. */
  registerUnauthorizedHandler(handler: (rejectedToken: string) => void): () => void
  children: ReactNode
}) {
  const [state, setState] = useState<SessionState>({ status: 'restoring' })
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let current = true
    // Never rejects: every failure becomes a state before the last step, so the chain is ignored on purpose.
    void tokenStore.read()
      .then(async (token) => {
        if (!token) return { status: 'signedOut' } as const
        try {
          const { user } = await authApi.me()
          return { status: 'signedIn', user } as const
        } catch (error) {
          if (error instanceof ApiError && error.status === 401) {
            await tokenStore.clear()
            return { status: 'signedOut', notice: SESSION_EXPIRED_NOTICE } as const
          }
          // Both are written for the person, in Portuguese: a request failure and a build without the API address.
          return { status: 'unavailable', message: error instanceof ApiError || error instanceof ApiConfigurationError ? error.message : RESTORE_FAILED_MESSAGE } as const
        }
      })
      .catch(() => ({ status: 'unavailable', message: RESTORE_FAILED_MESSAGE }) as const)
      .then((next: SessionState) => { if (current) setState(next) })
    return () => { current = false }
  }, [authApi, tokenStore, attempt])

  useEffect(() => registerUnauthorizedHandler((rejectedToken) => {
    void (async () => {
      // A 401 names the token it was sent with. One that is no longer the stored token is a late answer
      // to a request made before the person signed in again, and must not end the new session. When the
      // store cannot be read, the session ends anyway: failing closed beats keeping a refused token.
      const stored = await tokenStore.read().catch(() => rejectedToken)
      if (stored !== rejectedToken) return
      await tokenStore.clear().catch(() => undefined)
      setState({ status: 'signedOut', notice: SESSION_EXPIRED_NOTICE })
    })()
  }), [registerUnauthorizedHandler, tokenStore])

  const signIn = useCallback(async (email: string, password: string) => {
    const session = await authApi.login(email, password)
    await tokenStore.save(session.token)
    setState({ status: 'signedIn', user: session.user })
  }, [authApi, tokenStore])

  const signOut = useCallback(async () => {
    try {
      await authApi.logout()
    } catch {
      // The server session may stay open until it expires, but the device never keeps the token.
    } finally {
      // A secure store that refuses the delete must not leave the person stuck on a busy button: the
      // app still signs out, and the next launch checks whatever token remains against the API.
      await tokenStore.clear().catch(() => { /* still signs out */ })
      setState({ status: 'signedOut' })
    }
  }, [authApi, tokenStore])

  const retryRestore = useCallback(() => {
    setState({ status: 'restoring' })
    setAttempt((value) => value + 1)
  }, [])

  const value = useMemo(() => ({ state, signIn, signOut, retryRestore }), [state, signIn, signOut, retryRestore])
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>
}

export function useSession(): SessionContextValue {
  const value = useContext(SessionContext)
  if (!value) throw new Error('useSession must be used inside SessionProvider')
  return value
}
