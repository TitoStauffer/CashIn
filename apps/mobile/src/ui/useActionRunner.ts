import { useCallback, useEffect, useRef, useState } from 'react'

export type Feedback = { tone: 'error' | 'info'; message: string } | null

export const ACTION_FAILED = 'Não foi possível concluir a ação. Tente novamente.'

export const messageOf = (error: unknown, fallback = ACTION_FAILED) =>
  (error instanceof Error && error.message ? error.message : fallback)

/**
 * Runs a screen's actions one at a time: a second tap while one is in flight is ignored, the API's
 * message (or the success message the action returns) is shown, and `afterSuccess` reads the data again.
 * An action that ends after `scope` changed (another wallet or list) is not reported: its message would
 * describe data that is no longer on screen.
 */
export function useActionRunner(afterSuccess: () => void, scope = '') {
  const [busy, setBusy] = useState(false)
  const [feedback, setFeedback] = useState<Feedback>(null)
  const inFlight = useRef(false)
  const scopeRef = useRef(scope)
  useEffect(() => { scopeRef.current = scope }, [scope])

  const run = useCallback(async (action: () => Promise<string | void>) => {
    if (inFlight.current) return
    inFlight.current = true
    setBusy(true)
    setFeedback(null)
    const startedIn = scopeRef.current
    try {
      const message = await action()
      if (scopeRef.current !== startedIn) return
      if (message) setFeedback({ tone: 'info', message })
      afterSuccess()
    } catch (error) {
      if (scopeRef.current === startedIn) setFeedback({ tone: 'error', message: messageOf(error) })
    } finally {
      setBusy(false)
      inFlight.current = false
    }
  }, [afterSuccess])

  return { busy, feedback, setFeedback, run }
}
