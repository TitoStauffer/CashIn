import { useCallback, useEffect, useState } from 'react'
import { Alert, ScrollView, StyleSheet, Text, View } from 'react-native'

import type { CatalogApi } from '../catalog/catalogApi'
import type { Expense, ExpenseApi } from '../expenses/expenseApi'
import { ExpenseForm, loadExpenseOptions, type ExpenseOptions } from '../expenses/ExpenseForm'
import { formatAmount } from '../money/amount'
import { formatDate, monthOf, monthRange, todayIso } from '../period/period'
import { FormMessage, formStyles, LinkButton, PrimaryButton } from '../ui/Form'
import { MonthSelector } from '../ui/MonthSelector'
import { ErrorState, LoadingState } from '../ui/StateViews'
import { colors, spacing, typography } from '../ui/theme'
import { messageOf, useActionRunner } from '../ui/useActionRunner'

const LOAD_FAILED = 'Não foi possível carregar as despesas. Tente novamente.'

type Loaded = { key: string; expenses: Expense[]; options: ExpenseOptions }
/** `null` closes the form; `{ expense: null }` is a new expense. */
type Editing = { expense: Expense | null } | null

/** How an expense is named in its actions: amount, date and category, so two expenses of one day differ. */
export function expenseName(expense: Expense): string {
  return `despesa de ${formatAmount(expense.amount)} em ${formatDate(expense.date)} (${expense.categoryName})`
}

function paymentLine(expense: Expense): string {
  if (!expense.paymentMethodName) return 'Sem forma de pagamento'
  return expense.creditCardName ? `${expense.paymentMethodName} · ${expense.creditCardName}` : expense.paymentMethodName
}

/**
 * The expenses of the active wallet in one month. The list and what the form offers belong to a wallet
 * and a month: when either changes, the old list leaves the screen before the new one is read, and the
 * open form is dropped. Every refusal of the API (a paid statement, a card on a non-credit purchase) is
 * shown as its message.
 */
export function ExpensesScreen({
  walletId,
  expenseApi,
  catalogApi,
  now = new Date(),
}: {
  walletId: string
  expenseApi: ExpenseApi
  catalogApi: CatalogApi
  now?: Date
}) {
  const [month, setMonth] = useState(() => monthOf(now))
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [editing, setEditing] = useState<Editing>(null)
  const key = `${walletId}:${month}`

  useEffect(() => {
    let current = true
    const { from, to } = monthRange(month)
    void Promise.all([expenseApi.list(from, to), loadExpenseOptions(catalogApi, expenseApi)])
      .then(([expenses, options]) => {
        if (!current) return
        setLoaded({ key, expenses: expenses.items, options })
        setLoadError(null)
      })
      .catch((error: unknown) => { if (current) setLoadError(messageOf(error, LOAD_FAILED)) })
    return () => { current = false }
  }, [expenseApi, catalogApi, key, month, attempt])

  const refresh = useCallback(() => setAttempt((value) => value + 1), [])
  const { busy, feedback, setFeedback, run } = useActionRunner(refresh, key)
  const data = loaded?.key === key ? loaded : null

  // Another wallet or month starts clean (adjusted while rendering, the way React recommends).
  const [formKey, setFormKey] = useState(key)
  if (formKey !== key) {
    setFormKey(key)
    setEditing(null)
    setFeedback(null)
    setLoadError(null) // the previous wallet's or month's read error is not this one's
  }

  if (loadError && !data) return <ErrorState message={loadError} onRetry={() => { setLoadError(null); refresh() }} />

  const confirmRemoval = (expense: Expense) => {
    Alert.alert('Excluir despesa', `${formatAmount(expense.amount)} de ${formatDate(expense.date)} será excluída.`, [
      { text: 'Cancelar', style: 'cancel' },
      {
        text: 'Excluir',
        style: 'destructive',
        onPress: () => void run(async () => {
          await expenseApi.remove(expense.id)
          return 'Despesa excluída.'
        }, () => setEditing((open) => (open?.expense?.id === expense.id ? null : open))),
      },
    ])
  }

  return (
    <ScrollView contentContainerStyle={styles.screen} keyboardShouldPersistTaps="handled">
      <Text style={formStyles.title} accessibilityRole="header">Despesas</Text>
      <MonthSelector month={month} onChange={setMonth} />
      {feedback ? <FormMessage tone={feedback.tone} message={feedback.message} /> : null}
      {loadError ? (
        <View style={styles.card}>
          <FormMessage tone="error" message={loadError} />
          <LinkButton label="Tentar novamente" onPress={refresh} />
        </View>
      ) : null}

      {data && editing ? (
        <View style={styles.card}>
          <Text style={styles.primary} accessibilityRole="header">{editing.expense ? 'Editar despesa' : 'Nova despesa'}</Text>
          <ExpenseForm
            key={editing.expense?.id ?? 'new'}
            options={data.options}
            expense={editing.expense}
            today={todayIso(now)}
            busy={busy}
            submitLabel="Salvar despesa"
            onInvalid={(message) => setFeedback({ tone: 'error', message })}
            onCancel={() => setEditing(null)}
            onSubmit={(input) => {
              const original = editing.expense
              void run(async () => {
                if (original) await expenseApi.update(original.id, input)
                else await expenseApi.create(input)
                return original ? 'Despesa atualizada.' : 'Despesa registrada.'
              }, () => setEditing(null))
            }}
          />
        </View>
      ) : (
        <PrimaryButton label="Nova despesa" onPress={() => setEditing({ expense: null })} />
      )}

      {!data ? <LoadingState label="Carregando despesas…" /> : null}
      {data && data.expenses.length === 0 ? <Text style={formStyles.body}>Nenhuma despesa neste mês.</Text> : null}
      {data?.expenses.map((expense) => (
        <View key={expense.id} style={styles.card}>
          <Text style={styles.primary}>{formatAmount(expense.amount)}</Text>
          <Text style={styles.detail}>
            {formatDate(expense.date)} · {expense.categoryName}{expense.subcategoryName ? ` / ${expense.subcategoryName}` : ''} · {paymentLine(expense)}
          </Text>
          {expense.description ? <Text style={formStyles.body}>{expense.description}</Text> : null}
          <View style={styles.actions}>
            <LinkButton label={`Editar ${expenseName(expense)}`} onPress={() => setEditing({ expense })} />
            <LinkButton label={`Excluir ${expenseName(expense)}`} onPress={() => confirmRemoval(expense)} />
          </View>
        </View>
      ))}
    </ScrollView>
  )
}

const styles = StyleSheet.create({
  screen: { gap: spacing.md, padding: spacing.lg, backgroundColor: colors.background },
  card: { borderWidth: 1, borderColor: colors.border, borderRadius: 8, backgroundColor: colors.surface, padding: spacing.md, gap: spacing.xs },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.md },
  primary: { fontSize: typography.body, fontWeight: '600', color: colors.text },
  detail: { fontSize: typography.caption, color: colors.textMuted },
})
