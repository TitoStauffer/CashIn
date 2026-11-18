import { useCallback, useEffect, useState } from 'react'
import { ScrollView, StyleSheet, Text } from 'react-native'

import type { CatalogApi } from '../catalog/catalogApi'
import type { ExpenseApi } from '../expenses/expenseApi'
import { ExpenseForm, loadExpenseOptions, type ExpenseOptions } from '../expenses/ExpenseForm'
import { todayIso } from '../period/period'
import { FormMessage, formStyles, LinkButton } from '../ui/Form'
import { ErrorState, LoadingState } from '../ui/StateViews'
import { colors, spacing, typography } from '../ui/theme'
import { messageOf, useActionRunner } from '../ui/useActionRunner'

const LOAD_FAILED = 'Não foi possível carregar categorias e formas de pagamento. Tente novamente.'

type Loaded = { walletId: string; options: ExpenseOptions }

/**
 * The short path from the home screen: amount, category and payment method, dated today, in the active
 * wallet. After a save the form starts empty again, ready for the next expense; the full list, with
 * date, description and subcategory, is one tap away.
 */
export function QuickExpenseScreen({
  walletId,
  walletName,
  expenseApi,
  catalogApi,
  onOpenExpenses,
  now = new Date(),
}: {
  walletId: string
  walletName: string
  expenseApi: ExpenseApi
  catalogApi: CatalogApi
  onOpenExpenses(): void
  now?: Date
}) {
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  // A new version of the form after each save starts it empty.
  const [formVersion, setFormVersion] = useState(0)

  useEffect(() => {
    let current = true
    void loadExpenseOptions(catalogApi, expenseApi)
      .then((options) => {
        if (!current) return
        setLoaded({ walletId, options })
        setLoadError(null)
      })
      .catch((error: unknown) => { if (current) setLoadError(messageOf(error, LOAD_FAILED)) })
    return () => { current = false }
  }, [catalogApi, expenseApi, walletId, attempt])

  const retry = useCallback(() => { setLoadError(null); setAttempt((value) => value + 1) }, [])
  const noReload = useCallback(() => undefined, [])
  const { busy, feedback, setFeedback, run } = useActionRunner(noReload, walletId)
  const options = loaded?.walletId === walletId ? loaded.options : null

  // Another wallet starts clean (adjusted while rendering, the way React recommends).
  const [formWalletId, setFormWalletId] = useState(walletId)
  if (formWalletId !== walletId) {
    setFormWalletId(walletId)
    setFeedback(null)
    setLoadError(null) // the previous wallet's read error is not this one's
  }

  if (loadError && !options) return <ErrorState message={loadError} onRetry={retry} />
  if (!options) return <LoadingState label="Carregando…" />

  return (
    <ScrollView contentContainerStyle={styles.screen} keyboardShouldPersistTaps="handled">
      <Text style={formStyles.title} accessibilityRole="header">Lançar despesa</Text>
      <Text style={styles.detail}>Na carteira {walletName}, com a data de hoje.</Text>
      {feedback ? <FormMessage tone={feedback.tone} message={feedback.message} /> : null}
      <ExpenseForm
        key={`${walletId}:${formVersion}`}
        compact
        options={options}
        today={todayIso(now)}
        busy={busy}
        submitLabel="Lançar despesa"
        onInvalid={(message) => setFeedback({ tone: 'error', message })}
        onSubmit={(input) => void run(async () => {
          await expenseApi.create(input)
          return 'Despesa registrada.'
        }, () => setFormVersion((value) => value + 1))}
      />
      <LinkButton label="Ver despesas do mês" onPress={onOpenExpenses} />
    </ScrollView>
  )
}

const styles = StyleSheet.create({
  screen: { gap: spacing.md, padding: spacing.lg, backgroundColor: colors.background },
  detail: { fontSize: typography.caption, color: colors.textMuted },
})
