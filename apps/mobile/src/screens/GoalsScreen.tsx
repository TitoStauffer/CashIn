import { useCallback, useEffect, useState } from 'react'
import { Alert, ScrollView, Text, View } from 'react-native'

import type { CatalogApi, Category } from '../catalog/catalogApi'
import { formatPercentage } from '../dashboard/dashboardView'
import type { Goal, GoalApi, GoalInput } from '../goals/goalApi'
import { amountToInput, formatAmount, parseAmountInput } from '../money/amount'
import { DATE_INVALID, formatDate, parseDateInput } from '../period/period'
import { ChoiceChips } from '../ui/ChoiceChips'
import { formStyles, LinkButton, PrimaryButton, TextField } from '../ui/Form'
import { listStyles as styles } from '../ui/listStyles'
import { ScreenMessages } from '../ui/ScreenMessages'
import { ErrorState, LoadingState } from '../ui/StateViews'
import { messageOf, useActionRunner } from '../ui/useActionRunner'

const LOAD_FAILED = 'Não foi possível carregar as metas. Tente novamente.'
export const MISSING_TITLE = 'Informe o nome da meta.'
export const MISSING_DESCRIPTION = 'Descreva a meta.'

type Loaded = { key: string; goals: Goal[]; categories: Category[] }
type Editor = { original: Goal | null; title: string; description: string; targetAmount: string; dueDate: string; categoryId: string } | null

function editorFor(goal: Goal | null): NonNullable<Editor> {
  if (!goal) return { original: null, title: '', description: '', targetAmount: '', dueDate: '', categoryId: '' }
  return {
    original: goal,
    title: goal.title,
    description: goal.description,
    targetAmount: amountToInput(goal.targetAmount),
    dueDate: goal.dueDate ? formatDate(goal.dueDate) : '',
    categoryId: goal.categoryId ?? '',
  }
}

/** How a goal is described: what it has, out of what it aims at, with the API's own percentage. */
export function goalProgress(goal: Goal): string {
  return `Acumulado ${formatAmount(goal.contributedAmount)} de ${formatAmount(goal.targetAmount)} (${formatPercentage(goal.progressPercentage)})`
}

/**
 * The investment goals of the active wallet, with the progress the API derives from the contributions:
 * the app never adds contributions up nor computes a percentage. `PUT` replaces every field, so an edit
 * sends the subcategory the goal already has unless its category changes. A closed goal stays visible
 * but takes no change.
 */
export function GoalsScreen({
  walletId,
  goalApi,
  catalogApi,
  refreshKey = 0,
  onOpenContributions,
}: {
  walletId: string
  goalApi: GoalApi
  catalogApi: Pick<CatalogApi, 'listCategories'>
  /** Bumped by the route when the screen comes back into view, after contributions may have changed. */
  refreshKey?: number
  onOpenContributions(goal: Goal): void
}) {
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [editor, setEditor] = useState<Editor>(null)
  const key = walletId

  useEffect(() => {
    let current = true
    void Promise.all([goalApi.list(), catalogApi.listCategories('investment')])
      .then(([goals, categories]) => {
        if (!current) return
        setLoaded({ key, goals: goals.items, categories: categories.items })
        setLoadError(null)
      })
      .catch((error: unknown) => { if (current) setLoadError(messageOf(error, LOAD_FAILED)) })
    return () => { current = false }
  }, [goalApi, catalogApi, key, attempt, refreshKey])

  const refresh = useCallback(() => setAttempt((value) => value + 1), [])
  const { busy, feedback, setFeedback, run } = useActionRunner(refresh, key)
  const data = loaded?.key === key ? loaded : null

  // Another wallet starts clean (adjusted while rendering, the way React recommends).
  const [formKey, setFormKey] = useState(key)
  if (formKey !== key) {
    setFormKey(key)
    setEditor(null)
    setFeedback(null)
    setLoadError(null) // the previous wallet's read error is not this one's
  }

  if (loadError && !data) return <ErrorState message={loadError} onRetry={() => { setLoadError(null); refresh() }} />

  const save = () => {
    if (!editor) return
    const title = editor.title.trim()
    if (!title) return setFeedback({ tone: 'error', message: MISSING_TITLE })
    const description = editor.description.trim()
    if (!description) return setFeedback({ tone: 'error', message: MISSING_DESCRIPTION })
    const target = parseAmountInput(editor.targetAmount)
    if (!target.ok) return setFeedback({ tone: 'error', message: target.message })
    let dueDate: string | null = null
    if (editor.dueDate.trim()) {
      dueDate = parseDateInput(editor.dueDate)
      if (!dueDate) return setFeedback({ tone: 'error', message: DATE_INVALID })
    }
    const { original } = editor
    const categoryId = editor.categoryId || null
    const input: GoalInput = {
      title,
      description,
      targetAmount: target.amount,
      dueDate,
      categoryId,
      // The form does not edit the subcategory; it is kept while the category stays the same.
      subcategoryId: original && original.categoryId === categoryId ? original.subcategoryId : null,
    }
    void run(async () => {
      if (original) await goalApi.update(original.id, input)
      else await goalApi.create(input)
      return original ? 'Meta atualizada.' : 'Meta criada.'
    }, () => setEditor(null))
  }

  const confirmClose = (goal: Goal) => {
    Alert.alert('Encerrar meta', `${goal.title} deixa de aceitar aportes e alterações, mas continua visível.`, [
      { text: 'Cancelar', style: 'cancel' },
      {
        text: 'Encerrar',
        style: 'destructive',
        onPress: () => void run(async () => {
          await goalApi.close(goal.id)
          return 'Meta encerrada.'
        }, () => setEditor((open) => (open?.original?.id === goal.id ? null : open))),
      },
    ])
  }

  // A goal whose category is not among the investment categories (an old one) still shows it.
  const categoryOptions = (() => {
    const options = (data?.categories ?? []).map((item) => ({ value: item.id, label: item.name }))
    const current = editor?.original
    if (current?.categoryId && !options.some((option) => option.value === current.categoryId)) {
      options.push({ value: current.categoryId, label: current.categoryName ?? 'Categoria atual' })
    }
    return [{ value: '', label: 'Sem categoria' }, ...options]
  })()

  return (
    <ScrollView contentContainerStyle={styles.screen} keyboardShouldPersistTaps="handled">
      <Text style={formStyles.title} accessibilityRole="header">Metas</Text>
      <ScreenMessages feedback={feedback} loadError={loadError} onRetry={refresh} />

      {data && editor ? (
        <View style={styles.card}>
          <Text style={styles.primary} accessibilityRole="header">{editor.original ? 'Editar meta' : 'Nova meta'}</Text>
          <TextField label="Nome da meta" value={editor.title} onChangeText={(title) => setEditor({ ...editor, title })} />
          <TextField label="Descrição" value={editor.description} onChangeText={(description) => setEditor({ ...editor, description })} />
          <TextField label="Valor-alvo (R$)" value={editor.targetAmount} onChangeText={(targetAmount) => setEditor({ ...editor, targetAmount })} keyboardType="decimal-pad" placeholder="0,00" />
          <TextField label="Prazo (DD/MM/AAAA, opcional)" value={editor.dueDate} onChangeText={(dueDate) => setEditor({ ...editor, dueDate })} keyboardType="numbers-and-punctuation" />
          <Text style={styles.detail}>Categoria</Text>
          <ChoiceChips options={categoryOptions} value={editor.categoryId} onChange={(categoryId) => setEditor({ ...editor, categoryId })} />
          <PrimaryButton label="Salvar meta" onPress={save} busy={busy} />
          <LinkButton label="Cancelar edição" onPress={() => setEditor(null)} />
        </View>
      ) : (
        <PrimaryButton label="Nova meta" onPress={() => setEditor(editorFor(null))} />
      )}

      {!data ? <LoadingState label="Carregando metas…" /> : null}
      {data && data.goals.length === 0 ? <Text style={formStyles.body}>Nenhuma meta nesta carteira.</Text> : null}
      {data?.goals.map((goal) => {
        const closed = goal.status === 'closed'
        return (
          <View key={goal.id} style={[styles.card, closed && styles.inactive]}>
            <Text style={styles.primary}>{goal.title}{closed ? ' · encerrada' : ''}</Text>
            <Text style={styles.detail}>{goalProgress(goal)}</Text>
            {goal.dueDate ? <Text style={styles.detail}>Prazo: {formatDate(goal.dueDate)}</Text> : null}
            <Text style={formStyles.body}>{goal.description}</Text>
            <View style={styles.actions}>
              <LinkButton label={`Aportes de ${goal.title}`} onPress={() => onOpenContributions(goal)} />
              {closed ? null : <LinkButton label={`Editar ${goal.title}`} onPress={() => setEditor(editorFor(goal))} />}
              {closed ? null : <LinkButton label={`Encerrar ${goal.title}`} onPress={() => confirmClose(goal)} />}
            </View>
          </View>
        )
      })}
    </ScrollView>
  )
}
