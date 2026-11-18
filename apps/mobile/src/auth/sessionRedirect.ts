import type { SessionState } from './SessionProvider'

/**
 * Where a signed-in route sends the person when the session is not signed in: the login after a
 * sign-out, and the start route while the session is restoring or the API is unavailable, since
 * that route shows the wait and the retry. Without it, a wallet route would wait forever.
 */
export function sessionRedirect(session: SessionState): '/login' | '/' | null {
  if (session.status === 'signedIn') return null
  return session.status === 'signedOut' ? '/login' : '/'
}
