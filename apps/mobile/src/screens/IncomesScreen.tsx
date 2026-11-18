import { useCallback, useEffect, useState } from 'react'
import { Alert, ScrollView, StyleSheet, Text, View } from 'react-native'

import type { CatalogApi, Category } from '../catalog/catalogApi'
import {
  balanceTypeLabel,
  INCOME_BALANCE_TYPES,
  isLegacyBalanceType,
  type Income,
  type IncomeApi,
  type IncomeBalanceType,
} from '../incomes/incomeApi'
import { amountToInput, formatAmount, parseAmountInput } from '../money/amount'
import { DATE_INVALID, formatDate, monthOf, monthRange, parseDateInput, todayIso } from '../period/period'
import { ChoiceChips } from '../ui/ChoiceChips'
import { FormMessage, formStyles, LinkButton, PrimaryButton, TextField } from '../ui/Form'
import { MonthSelector } from '../ui/MonthSelector'
import { ErrorState, LoadingState } from '../ui/StateViews'
import { colors, spacing, typography } from '../ui/theme'
import { messageOf, useActionRunner } from '../ui/useActionRunner'

const LOAD_FAILED = 'Não foi possível carregar as entradas. Tente novamente.'
const MISSING_CATEGORY = 'Escolha a categoria da entrada.'
const NO_CATEGORIES = 'Cadastre uma categoria de entrada em Categorias antes de lançar.'
export const LEGACY_BALANCE_NOTICE =
  'Esta entrada usa um saldo antigo de VA ou VR. Ao salvar, ela passa para o Cartão de benefícios (VA/VR), que reúne os dois.'

type Loaded = { key: string; incomes: Income[]; categories: Category[] }
type Editor = {
  original: Income | null
  amount: string
  date: string
  description: string
  categoryId: string
  subcategoryId: string
  balanceType: IncomeBalanceType
}

function editorFor(income: Income | null, today: string): Editor {
  if (!income) return { original: null, amount: '', date: formatDate(today), description: '', categoryId: '', subcategoryId: '', balanceType: 'cash' }
  return {
    original: income,
    amount: amountToInput(income.amount),
    date: formatDate(income.date),
    description: income.description ?? '',
    categoryId: income.categoryId,
    subcategoryId: income.subcategoryId ?? '',
    // The API moves an old VA or VR balance into the unified one on any write; the form says so instead
    // of offering a choice the save would not keep.
    balanceType: isLegacyBalanceType(income.balanceType) ? 'food_meal_benefit' : income.balanceType ?? 'cash',
  }
}

/**
 * The incomes of the active wallet in one month. The list belongs to a wallet and a month: when either
 * changes, the old list leaves the screen before the new one is read. The amount goes to the API as the
 * exact decimal typed; the form checks what it can (amount, date, category) and every other refusal is
 * the API's message.
 */
export function IncomesScreen({
  walletId,
  incomeApi,
  catalogApi,
  now = new Date(),
}: {
  walletId: string
  incomeApi: IncomeApi
  catalogApi: CatalogApi
  now?: Date
}) {
  const [month, setMonth] = useState(() => monthOf(now))
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [editor, setEditor] = useState<Editor | null>(null)
  const key = `${walletId}:${month}`

  useEffect(() => {
    let current = true
    const { from, to } = monthRange(month)
    void Promise.all([incomeApi.list(from, to), catalogApi.listCategories('income')])
      .then(([incomes, categories]) => {
        if (!current) return
        setLoaded({ key, incomes: incomes.items, categories: categories.items })
        setLoadError(null)
      })
      .catch((error: unknown) => { if (current) setLoadError(messageOf(error, LOAD_FAILED)) })
    return () => { current = false }
  }, [incomeApi, catalogApi, key, month, attempt])

  const refresh = useCallback(() => setAttempt((value) => value + 1), [])
  const { busy, feedback, setFeedback, run } = useActionRunner(refresh, key)
  const data = loaded?.key === key ? loaded : null

  // Another wallet or month starts clean (adjusted while rendering, the way React recommends).
  const [formKey, setFormKey] = useState(key)
  if (formKey !== key) {
    setFormKey(key)
    setEditor(null)
    setFeedback(null)
    setLoadError(null) // the previous wallet's or month's read error is not this one's
  }

  if (loadError && !data) return <ErrorState message={loadError} onRetry={() => { setLoadError(null); refresh() }} />

  const save = () => {
    if (!editor) return
    const amount = parseAmountInput(editor.amount)
    if (!amount.ok) return setFeedback({ tone: 'error', message: amount.message })
    const date = parseDateInput(editor.date)
    if (!date) return setFeedback({ tone: 'error', message: DATE_INVALID })
    if (!editor.categoryId) return setFeedback({ tone: 'error', message: MISSING_CATEGORY })
    const input = {
      amount: amount.amount,
      date,
      description: editor.description.trim() || null,
      categoryId: editor.categoryId,
      subcategoryId: editor.subcategoryId || null,
      balanceType: editor.balanceType,
    }
    const { original } = editor
    void run(async () => {
      if (original) await incomeApi.update(original.id, input)
      else await incomeApi.create(input)
      return original ? 'Entrada atualizada.' : 'Entrada registrada.'
    }, () => setEditor(null))
  }

  const confirmRemoval = (income: Income) => {
    Alert.alert('Excluir entrada', `${formatAmount(income.amount)} de ${formatDate(income.date)} será excluída.`, [
      { text: 'Cancelar', style: 'cancel' },
      {
        text: 'Excluir',
        style: 'destructive',
        onPress: () => void run(async () => {
          await incomeApi.remove(income.id)
          return 'Entrada excluída.'
        }),
      },
    ])
  }

  const category = data?.categories.find((candidate) => candidate.id === editor?.categoryId)

  return (
    <ScrollView contentContainerStyle={styles.screen} keyboardShouldPersistTaps="handled">
      <Text style={formStyles.title} accessibilityRole="header">Entradas</Text>
      <MonthSelector month={month} onChange={setMonth} />
      {feedback ? <FormMessage tone={feedback.tone} message={feedback.message} /> : null}
      {loadError ? (
        <View style={styles.card}>
          <FormMessage tone="error" message={loadError} />
          <LinkButton label="Tentar novamente" onPress={refresh} />
        </View>
      ) : null}

      {data && editor ? (
        <View style={styles.card}>
          <Text style={styles.primary} accessibilityRole="header">{editor.original ? 'Editar entrada' : 'Nova entrada'}</Text>
          <TextField label="Valor (R$)" value={editor.amount} onChangeText={(amount) => setEditor({ ...editor, amount })} keyboardType="decimal-pad" placeholder="0,00" />
          <TextField label="Data (DD/MM/AAAA)" value={editor.date} onChangeText={(date) => setEditor({ ...editor, date })} keyboardType="numbers-and-punctuation" />
          <TextField label="Descrição (opcional)" value={editor.description} onChangeText={(description) => setEditor({ ...editor, description })} />
          <Text style={styles.detail}>Categoria</Text>
          {data.categories.length === 0 ? <Text style={formStyles.body}>{NO_CATEGORIES}</Text> : (
            <ChoiceChips
              options={data.categories.map((item) => ({ value: item.id, label: item.name }))}
              value={editor.categoryId}
              onChange={(categoryId) => setEditor({ ...editor, categoryId, subcategoryId: '' })}
            />
          )}
          {category && category.subcategories.length > 0 ? (
            <>
              <Text style={styles.detail}>Subcategoria</Text>
              <ChoiceChips
                options={[{ value: '', label: 'Sem subcategoria' }, ...category.subcategories.map((item) => ({ value: item.id, label: item.name }))]}
                value={editor.subcategoryId}
                onChange={(subcategoryId) => setEditor({ ...editor, subcategoryId })}
              />
            </>
          ) : null}
          <Text style={styles.detail}>Destino do valor</Text>
          <ChoiceChips<IncomeBalanceType>
            options={INCOME_BALANCE_TYPES}
            value={editor.balanceType}
            onChange={(balanceType) => setEditor({ ...editor, balanceType })}
          />
          {editor.original && isLegacyBalanceType(editor.original.balanceType) ? <Text style={styles.detail}>{LEGACY_BALANCE_NOTICE}</Text> : null}
          <PrimaryButton label="Salvar entrada" onPress={save} busy={busy} />
          <LinkButton label="Cancelar edição" onPress={() => setEditor(null)} />
        </View>
      ) : (
        <PrimaryButton label="Nova entrada" onPress={() => setEditor(editorFor(null, todayIso(now)))} />
      )}

      {!data ? <LoadingState label="Carregando entradas…" /> : null}
      {data && data.incomes.length === 0 ? <Text style={formStyles.body}>Nenhuma entrada neste mês.</Text> : null}
      {data?.incomes.map((income) => (
        <View key={income.id} style={styles.card}>
          <Text style={styles.primary}>{formatAmount(income.amount)}</Text>
          <Text style={styles.detail}>
            {formatDate(income.date)} · {income.categoryName}{income.subcategoryName ? ` / ${income.subcategoryName}` : ''} · {balanceTypeLabel(income.balanceType)}
          </Text>
          {income.description ? <Text style={formStyles.body}>{income.description}</Text> : null}
          <View style={styles.actions}>
            <LinkButton label={`Editar entrada de ${formatDate(income.date)}`} onPress={() => setEditor(editorFor(income, todayIso(now)))} />
            <LinkButton label={`Excluir entrada de ${formatDate(income.date)}`} onPress={() => confirmRemoval(income)} />
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
