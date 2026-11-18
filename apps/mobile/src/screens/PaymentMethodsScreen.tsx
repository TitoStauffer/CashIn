import { useCallback, useEffect, useState } from 'react'
import { ScrollView, StyleSheet, Text, View } from 'react-native'

import {
  PAYMENT_METHOD_NATURES,
  paymentMethodNatureLabel,
  type CatalogApi,
  type PaymentMethod,
  type PaymentMethodNature,
} from '../catalog/catalogApi'
import { ChoiceChips } from '../ui/ChoiceChips'
import { FormMessage, formStyles, LinkButton, PrimaryButton, TextField } from '../ui/Form'
import { ErrorState, LoadingState } from '../ui/StateViews'
import { colors, spacing, typography } from '../ui/theme'
import { messageOf, useActionRunner } from '../ui/useActionRunner'

const LOAD_FAILED = 'Não foi possível carregar as formas de pagamento. Tente novamente.'
const MISSING_NAME = 'Informe o nome da forma de pagamento.'

type Loaded = { walletId: string; methods: PaymentMethod[] }
type Editor = { original: PaymentMethod | null; name: string; nature: PaymentMethodNature } | null

const isLegacy = (nature: PaymentMethodNature) => nature === 'food_benefit' || nature === 'meal_benefit'

/**
 * Only what the person changed. The API normalizes every `nature` it receives, turning a historical VA or
 * VR into the unified benefit, so sending an unchanged nature along with a new name would reclassify the
 * method behind the person's back (Code Review of PR #123).
 */
export function paymentMethodChanges(original: PaymentMethod, name: string, nature: PaymentMethodNature) {
  return {
    ...(name !== original.name ? { name } : {}),
    ...(nature !== original.nature ? { nature } : {}),
  }
}

/**
 * The payment methods of the active wallet. The API never deletes one, so the history of the expenses
 * that used it survives: a method is deactivated instead, and can be activated again. A method kept with
 * a historical VA or VR nature still offers that nature while being edited, and an edit sends only the
 * fields that changed, so renaming it does not reclassify it.
 */
export function PaymentMethodsScreen({ walletId, catalogApi }: { walletId: string; catalogApi: CatalogApi }) {
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [editor, setEditor] = useState<Editor>(null)

  useEffect(() => {
    let current = true
    void catalogApi.listPaymentMethods()
      .then(({ items }) => {
        if (!current) return
        setLoaded({ walletId, methods: items })
        setLoadError(null)
      })
      .catch((error: unknown) => { if (current) setLoadError(messageOf(error, LOAD_FAILED)) })
    return () => { current = false }
  }, [catalogApi, walletId, attempt])

  const refresh = useCallback(() => setAttempt((value) => value + 1), [])
  const { busy, feedback, setFeedback, run } = useActionRunner(refresh, walletId)
  const methods = loaded?.walletId === walletId ? loaded.methods : null

  // Another wallet starts clean: no open editor or old message carries over (adjusted while rendering).
  const [formWalletId, setFormWalletId] = useState(walletId)
  if (formWalletId !== walletId) {
    setFormWalletId(walletId)
    setEditor(null)
    setFeedback(null)
    setLoadError(null) // the previous wallet's read error is not this one's
  }

  if (loadError && !methods) return <ErrorState message={loadError} onRetry={() => { setLoadError(null); refresh() }} />

  const save = () => {
    if (!editor) return
    if (!editor.name.trim()) {
      setFeedback({ tone: 'error', message: MISSING_NAME })
      return
    }
    const { original, nature } = editor
    const name = editor.name.trim()
    if (original) {
      const changes = paymentMethodChanges(original, name, nature)
      // Nothing changed: the API would refuse an empty update, and there is nothing to save.
      if (Object.keys(changes).length === 0) {
        setEditor(null)
        return
      }
      void run(async () => {
        await catalogApi.updatePaymentMethod(original.id, changes)
        return 'Forma de pagamento atualizada.'
      }, () => setEditor(null))
      return
    }
    void run(async () => {
      await catalogApi.createPaymentMethod(name, nature)
      return 'Forma de pagamento criada.'
    }, () => setEditor(null))
  }

  const toggle = (method: PaymentMethod) => void run(async () => {
    await catalogApi.updatePaymentMethod(method.id, { isActive: !method.isActive })
    return method.isActive ? 'Forma de pagamento desativada.' : 'Forma de pagamento ativada.'
  })

  const natureOptions = editor && isLegacy(editor.nature)
    ? [...PAYMENT_METHOD_NATURES, { value: editor.nature, label: `${paymentMethodNatureLabel(editor.nature)} (legado)` }]
    : PAYMENT_METHOD_NATURES

  return (
    <ScrollView contentContainerStyle={styles.screen} keyboardShouldPersistTaps="handled">
      <Text style={formStyles.title} accessibilityRole="header">Formas de pagamento</Text>
      {feedback ? <FormMessage tone={feedback.tone} message={feedback.message} /> : null}
      {loadError ? (
        <View style={styles.card}>
          <FormMessage tone="error" message={loadError} />
          <LinkButton label="Tentar novamente" onPress={refresh} />
        </View>
      ) : null}

      {editor ? (
        <View style={styles.card}>
          <Text style={styles.primary} accessibilityRole="header">{editor.original ? 'Editar forma de pagamento' : 'Nova forma de pagamento'}</Text>
          <TextField label="Nome da forma de pagamento" value={editor.name} onChangeText={(name) => setEditor({ ...editor, name })} />
          <Text style={styles.detail}>Natureza</Text>
          <ChoiceChips options={natureOptions} value={editor.nature} onChange={(nature) => setEditor({ ...editor, nature })} />
          <Text style={styles.detail}>VA e VR usam um único saldo de benefícios, separado do dinheiro.</Text>
          <PrimaryButton label="Salvar forma de pagamento" onPress={save} busy={busy} />
          <LinkButton label="Cancelar edição" onPress={() => setEditor(null)} />
        </View>
      ) : (
        <PrimaryButton label="Nova forma de pagamento" onPress={() => setEditor({ original: null, name: '', nature: 'immediate' })} />
      )}

      {!methods ? <LoadingState label="Carregando formas de pagamento…" /> : null}
      {methods && methods.length === 0 ? <Text style={formStyles.body}>Nenhuma forma de pagamento cadastrada.</Text> : null}
      {methods?.map((method) => (
        <View key={method.id} style={[styles.card, !method.isActive && styles.inactive]}>
          <Text style={styles.primary}>{method.name}</Text>
          <Text style={styles.detail}>{paymentMethodNatureLabel(method.nature)} · {method.isActive ? 'Ativa' : 'Inativa'}</Text>
          <View style={styles.actions}>
            <LinkButton label={`Editar ${method.name}`} onPress={() => setEditor({ original: method, name: method.name, nature: method.nature })} />
            <LinkButton label={`${method.isActive ? 'Desativar' : 'Ativar'} ${method.name}`} onPress={() => toggle(method)} />
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
