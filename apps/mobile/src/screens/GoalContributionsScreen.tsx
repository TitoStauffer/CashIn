import { useCallback, useEffect, useState } from 'react'
import { Alert, ScrollView, Text, View } from 'react-native'

import type { Contribution, Goal, GoalApi } from '../goals/goalApi'
import { formatAmount, parseAmountInput } from '../money/amount'
import { DATE_INVALID, formatDate, parseDateInput, todayIso } from '../period/period'
import { formStyles, LinkButton, PrimaryButton, TextField } from '../ui/Form'
import { listStyles as styles } from '../ui/listStyles'
import { ScreenMessages } from '../ui/ScreenMessages'
import { ErrorState, LoadingState } from '../ui/StateViews'
import { messageOf, useActionRunner } from '../ui/useActionRunner'

const LOAD_FAILED = 'Não foi possível carregar os aportes. Tente novamente.'

type Draft = { amount: string; date: string; description: string }

/**
 * The contributions of one goal. An active goal takes new contributions, in the exact decimal typed,
 * and lets a wrong one be removed; the API keeps the goal's progress in step. A closed goal only shows
 * its history, because the API refuses any change to it.
 */
export function GoalContributionsScreen({
  goal,
  goalApi,
  now = new Date(),
}: {
  goal: Pick<Goal, 'id' | 'title' | 'status'>
  goalApi: GoalApi
  now?: Date
}) {
  const [contributions, setContributions] = useState<Contribution[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [draft, setDraft] = useState<Draft>(() => ({ amount: '', date: formatDate(todayIso(now)), description: '' }))
  const active = goal.status === 'active'

  useEffect(() => {
    let current = true
    void goalApi.listContributions(goal.id)
      .then(({ items }) => {
        if (!current) return
        setContributions(items)
        setLoadError(null)
      })
      .catch((error: unknown) => { if (current) setLoadError(messageOf(error, LOAD_FAILED)) })
    return () => { current = false }
  }, [goalApi, goal.id, attempt])

  const refresh = useCallback(() => setAttempt((value) => value + 1), [])
  const { busy, feedback, setFeedback, run } = useActionRunner(refresh, goal.id)

  if (loadError && !contributions) return <ErrorState message={loadError} onRetry={() => { setLoadError(null); refresh() }} />

  const add = () => {
    const amount = parseAmountInput(draft.amount)
    if (!amount.ok) return setFeedback({ tone: 'error', message: amount.message })
    const date = parseDateInput(draft.date)
    if (!date) return setFeedback({ tone: 'error', message: DATE_INVALID })
    const description = draft.description.trim() || null
    void run(async () => {
      await goalApi.createContribution(goal.id, { amount: amount.amount, date, description })
      return 'Aporte registrado.'
    }, () => setDraft({ amount: '', date: draft.date, description: '' }))
  }

  const confirmRemoval = (contribution: Contribution) => {
    Alert.alert('Excluir aporte', `${formatAmount(contribution.amount)} de ${formatDate(contribution.date)} será excluído.`, [
      { text: 'Cancelar', style: 'cancel' },
      {
        text: 'Excluir',
        style: 'destructive',
        onPress: () => void run(async () => {
          await goalApi.removeContribution(goal.id, contribution.id)
          return 'Aporte excluído.'
        }),
      },
    ])
  }

  return (
    <ScrollView contentContainerStyle={styles.screen} keyboardShouldPersistTaps="handled">
      <Text style={formStyles.title} accessibilityRole="header">Aportes de {goal.title}</Text>
      {active ? null : <Text style={styles.detail}>Meta encerrada: os aportes ficam só para consulta.</Text>}
      <ScreenMessages feedback={feedback} loadError={loadError} onRetry={refresh} />

      {active ? (
        <View style={styles.card}>
          <Text style={styles.primary} accessibilityRole="header">Novo aporte</Text>
          <TextField label="Valor do aporte (R$)" value={draft.amount} onChangeText={(amount) => setDraft({ ...draft, amount })} keyboardType="decimal-pad" placeholder="0,00" />
          <TextField label="Data (DD/MM/AAAA)" value={draft.date} onChangeText={(date) => setDraft({ ...draft, date })} keyboardType="numbers-and-punctuation" />
          <TextField label="Descrição (opcional)" value={draft.description} onChangeText={(description) => setDraft({ ...draft, description })} />
          <PrimaryButton label="Registrar aporte" onPress={add} busy={busy} />
        </View>
      ) : null}

      {!contributions ? <LoadingState label="Carregando aportes…" /> : null}
      {contributions && contributions.length === 0 ? <Text style={formStyles.body}>Nenhum aporte nesta meta.</Text> : null}
      {contributions?.map((contribution) => (
        <View key={contribution.id} style={styles.card}>
          <Text style={styles.primary}>{formatAmount(contribution.amount)}</Text>
          <Text style={styles.detail}>{formatDate(contribution.date)}{contribution.description ? ` · ${contribution.description}` : ''}</Text>
          {active ? (
            <LinkButton
              label={`Excluir aporte de ${formatAmount(contribution.amount)} em ${formatDate(contribution.date)}`}
              onPress={() => confirmRemoval(contribution)}
            />
          ) : null}
        </View>
      ))}
    </ScrollView>
  )
}
