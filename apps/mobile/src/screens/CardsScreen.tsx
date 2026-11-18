import { useCallback, useEffect, useState } from 'react'
import { ScrollView, StyleSheet, Text, View } from 'react-native'

import type { CreditCard, CreditCardApi } from '../cards/creditCardApi'
import { FormMessage, formStyles, LinkButton, PrimaryButton, TextField } from '../ui/Form'
import { ErrorState, LoadingState } from '../ui/StateViews'
import { colors, spacing, typography } from '../ui/theme'
import { messageOf, useActionRunner } from '../ui/useActionRunner'

const LOAD_FAILED = 'Não foi possível carregar os cartões. Tente novamente.'
/** The API's own message for a blank nickname. */
export const MISSING_NICKNAME = 'Informe o apelido do cartão.'
export const INVALID_DAY = 'Informe os dias de fechamento e de vencimento entre 1 e 31.'

type Loaded = { walletId: string; cards: CreditCard[] }
type Editor = { original: CreditCard | null; nickname: string; closingDay: string; dueDay: string } | null

/** A day of the month typed by the person: 1 to 31, whole, or null. */
export function parseDay(text: string): number | null {
  if (!/^\d{1,2}$/.test(text.trim())) return null
  const day = Number(text.trim())
  return day >= 1 && day <= 31 ? day : null
}

/** Only what the person changed, so an edit never resends a field it did not touch. */
export function cardChanges(original: CreditCard, nickname: string, closingDay: number, dueDay: number) {
  return {
    ...(nickname !== original.nickname ? { nickname } : {}),
    ...(closingDay !== original.closingDay ? { closingDay } : {}),
    ...(dueDay !== original.dueDay ? { dueDay } : {}),
  }
}

/**
 * The credit cards of the active wallet. A card is never deleted, because its purchases and statements
 * keep their history: it is deactivated, and can be activated again. Each card opens its statements.
 */
export function CardsScreen({
  walletId,
  cardApi,
  onOpenStatements,
}: {
  walletId: string
  cardApi: CreditCardApi
  onOpenStatements(card: CreditCard): void
}) {
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [editor, setEditor] = useState<Editor>(null)

  useEffect(() => {
    let current = true
    void cardApi.list()
      .then(({ items }) => {
        if (!current) return
        setLoaded({ walletId, cards: items })
        setLoadError(null)
      })
      .catch((error: unknown) => { if (current) setLoadError(messageOf(error, LOAD_FAILED)) })
    return () => { current = false }
  }, [cardApi, walletId, attempt])

  const refresh = useCallback(() => setAttempt((value) => value + 1), [])
  const { busy, feedback, setFeedback, run } = useActionRunner(refresh, walletId)
  const cards = loaded?.walletId === walletId ? loaded.cards : null

  // Another wallet starts clean (adjusted while rendering, the way React recommends).
  const [formWalletId, setFormWalletId] = useState(walletId)
  if (formWalletId !== walletId) {
    setFormWalletId(walletId)
    setEditor(null)
    setFeedback(null)
    setLoadError(null) // the previous wallet's read error is not this one's
  }

  if (loadError && !cards) return <ErrorState message={loadError} onRetry={() => { setLoadError(null); refresh() }} />

  const save = () => {
    if (!editor) return
    const nickname = editor.nickname.trim()
    if (!nickname) return setFeedback({ tone: 'error', message: MISSING_NICKNAME })
    const closingDay = parseDay(editor.closingDay)
    const dueDay = parseDay(editor.dueDay)
    if (closingDay === null || dueDay === null) return setFeedback({ tone: 'error', message: INVALID_DAY })
    const { original } = editor
    if (original) {
      const changes = cardChanges(original, nickname, closingDay, dueDay)
      // Nothing changed: the API would refuse an empty update, and there is nothing to save.
      if (Object.keys(changes).length === 0) return setEditor(null)
      void run(async () => {
        await cardApi.update(original.id, changes)
        return 'Cartão atualizado.'
      }, () => setEditor(null))
      return
    }
    void run(async () => {
      await cardApi.create({ nickname, closingDay, dueDay })
      return 'Cartão cadastrado.'
    }, () => setEditor(null))
  }

  const toggle = (card: CreditCard) => void run(async () => {
    await cardApi.update(card.id, { isActive: !card.isActive })
    return card.isActive ? 'Cartão desativado.' : 'Cartão ativado.'
  })

  return (
    <ScrollView contentContainerStyle={styles.screen} keyboardShouldPersistTaps="handled">
      <Text style={formStyles.title} accessibilityRole="header">Cartões</Text>
      {feedback ? <FormMessage tone={feedback.tone} message={feedback.message} /> : null}
      {loadError ? (
        <View style={styles.card}>
          <FormMessage tone="error" message={loadError} />
          <LinkButton label="Tentar novamente" onPress={refresh} />
        </View>
      ) : null}

      {editor ? (
        <View style={styles.card}>
          <Text style={styles.primary} accessibilityRole="header">{editor.original ? 'Editar cartão' : 'Novo cartão'}</Text>
          <TextField label="Apelido do cartão" value={editor.nickname} onChangeText={(nickname) => setEditor({ ...editor, nickname })} />
          <TextField label="Dia de fechamento" value={editor.closingDay} onChangeText={(closingDay) => setEditor({ ...editor, closingDay })} keyboardType="number-pad" />
          <TextField label="Dia de vencimento" value={editor.dueDay} onChangeText={(dueDay) => setEditor({ ...editor, dueDay })} keyboardType="number-pad" />
          <Text style={styles.detail}>Compras até o dia de fechamento entram na fatura que fecha nesse dia. Em meses mais curtos, o dia é limitado ao último do mês.</Text>
          <PrimaryButton label="Salvar cartão" onPress={save} busy={busy} />
          <LinkButton label="Cancelar edição" onPress={() => setEditor(null)} />
        </View>
      ) : (
        <PrimaryButton label="Novo cartão" onPress={() => setEditor({ original: null, nickname: '', closingDay: '', dueDay: '' })} />
      )}

      {!cards ? <LoadingState label="Carregando cartões…" /> : null}
      {cards && cards.length === 0 ? <Text style={formStyles.body}>Nenhum cartão cadastrado nesta carteira.</Text> : null}
      {cards?.map((card) => (
        <View key={card.id} style={[styles.card, !card.isActive && styles.inactive]}>
          <Text style={styles.primary}>{card.nickname}</Text>
          <Text style={styles.detail}>Fecha dia {card.closingDay} · vence dia {card.dueDay} · {card.isActive ? 'Ativo' : 'Inativo'}</Text>
          <View style={styles.actions}>
            <LinkButton label={`Faturas de ${card.nickname}`} onPress={() => onOpenStatements(card)} />
            <LinkButton
              label={`Editar ${card.nickname}`}
              onPress={() => setEditor({ original: card, nickname: card.nickname, closingDay: String(card.closingDay), dueDay: String(card.dueDay) })}
            />
            <LinkButton label={`${card.isActive ? 'Desativar' : 'Ativar'} ${card.nickname}`} onPress={() => toggle(card)} />
          </View>
        </View>
      ))}
    </ScrollView>
  )
}

const styles = StyleSheet.create({
  screen: { gap: spacing.md, padding: spacing.lg, backgroundColor: colors.background },
  card: { borderWidth: 1, borderColor: colors.border, borderRadius: 8, backgroundColor: colors.surface, padding: spacing.md, gap: spacing.xs },
  inactive: { opacity: 0.7 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.md },
  primary: { fontSize: typography.body, fontWeight: '600', color: colors.text },
  detail: { fontSize: typography.caption, color: colors.textMuted },
})
