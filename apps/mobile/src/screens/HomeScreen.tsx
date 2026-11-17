import { useEffect, useState } from 'react'
import { StyleSheet, Text, View } from 'react-native'

import { getApiClient } from '../api/appClient'
import type { ApiClient } from '../api/client'
import { fetchHealth } from '../api/health'
import { ErrorState, LoadingState } from '../ui/StateViews'
import { colors, spacing, typography } from '../ui/theme'

type HealthState = { kind: 'loading' } | { kind: 'ready' } | { kind: 'error'; message: string }

const FALLBACK_MESSAGE = 'Não foi possível verificar a API.'

/**
 * The first screen: checks that the app reaches the API. It is the proof of the foundation (DEV-141)
 * and is replaced by the login and the dashboard in the next stories.
 */
export function HomeScreen({ resolveClient = getApiClient }: { resolveClient?: () => ApiClient }) {
  // Each attempt is one run of the effect. The result is applied from the promise callbacks, and only
  // while that run is current, so a slow answer never overwrites a newer attempt or an unmounted screen.
  const [state, setState] = useState<HealthState>({ kind: 'loading' })
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let current = true
    Promise.resolve()
      .then(() => fetchHealth(resolveClient()))
      .then(
        () => { if (current) setState({ kind: 'ready' }) },
        (error: unknown) => {
          if (current) setState({ kind: 'error', message: error instanceof Error && error.message ? error.message : FALLBACK_MESSAGE })
        },
      )
    return () => { current = false }
  }, [resolveClient, attempt])

  const retry = () => {
    setState({ kind: 'loading' })
    setAttempt((value) => value + 1)
  }

  if (state.kind === 'loading') return <LoadingState label="Conectando à API…" />
  if (state.kind === 'error') return <ErrorState message={state.message} onRetry={retry} />
  return (
    <View style={styles.container}>
      <Text style={styles.title}>Saldo Certo</Text>
      <Text style={styles.status}>API conectada</Text>
    </View>
  )
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    backgroundColor: colors.background,
  },
  title: {
    fontSize: typography.title,
    fontWeight: '700',
    color: colors.text,
  },
  status: {
    fontSize: typography.body,
    color: colors.success,
  },
})
