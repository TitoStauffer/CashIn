import { useCallback, useEffect, useState } from 'react'
import { Alert, ScrollView, StyleSheet, Text, View } from 'react-native'

import type { CatalogApi, Category } from '../catalog/catalogApi'
import type { CategorizationRule, CategorizationRuleInput, ImportApi } from '../imports/importApi'
import { RULE_TYPE_LABELS } from '../imports/importModel'
import { ChoiceChips } from '../ui/ChoiceChips'
import { FormMessage, formStyles, LinkButton, PrimaryButton, TextField } from '../ui/Form'
import { listStyles } from '../ui/listStyles'
import { ScreenMessages } from '../ui/ScreenMessages'
import { ErrorState, LoadingState } from '../ui/StateViews'
import { colors, spacing, typography } from '../ui/theme'
import { messageOf, useActionRunner } from '../ui/useActionRunner'

const LOAD_FAILED = 'Não foi possível carregar as regras. Tente novamente.'
export const RULE_DESCRIPTION_REQUIRED = 'Informe a descrição exata da movimentação.'
export const RULE_CATEGORY_REQUIRED = 'Escolha a categoria da regra.'

const NONE = ''
const TYPE_OPTIONS = [{ value: 'expense', label: 'Saída' }, { value: 'income', label: 'Entrada' }] as const
const ACTIVE_OPTIONS = [{ value: 'yes', label: 'Ativa' }, { value: 'no', label: 'Desativada' }] as const

type Loaded = { key: string; rules: CategorizationRule[]; categories: Category[] }
type Editing = { id: string | null; draft: CategorizationRuleInput }

const EMPTY: CategorizationRuleInput = { type: 'expense', description: '', categoryId: '', subcategoryId: null, isActive: true }

/** The accessible name of a rule; a wallet holds at most one rule per type and description. */
function ruleName(rule: Pick<CategorizationRule, 'type' | 'description'>): string {
  return `regra de ${RULE_TYPE_LABELS[rule.type].toLowerCase()} “${rule.description}”`
}

/** Every field of the rule, as the update replaces them all; `isActive` included. */
function inputOf(rule: CategorizationRule): CategorizationRuleInput {
  return { type: rule.type, description: rule.description, categoryId: rule.categoryId, subcategoryId: rule.subcategoryId, isActive: rule.isActive }
}

/**
 * The categorization rules of the active wallet: list, create, edit, activate or deactivate and delete.
 * A rule matches the exact description of an income or expense in the next imports. A rule whose
 * category or subcategory was removed (`isStale`) no longer classifies; it can only be edited to a
 * category that exists. Every change sends all the fields, so an edit never reactivates a rule.
 */
export function ImportRulesScreen({
  walletId,
  importApi,
  catalogApi,
}: {
  walletId: string
  importApi: Pick<ImportApi, 'listRules' | 'createRule' | 'updateRule' | 'deleteRule'>
  catalogApi: Pick<CatalogApi, 'listCategories'>
}) {
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [editing, setEditing] = useState<Editing | null>(null)
  const [formError, setFormError] = useState<string | null>(null)
  const key = walletId

  useEffect(() => {
    let current = true
    void Promise.all([importApi.listRules(), catalogApi.listCategories('income'), catalogApi.listCategories('expense')])
      .then(([rules, incomes, expenses]) => {
        if (!current) return
        setLoaded({ key, rules: rules.items, categories: [...incomes.items, ...expenses.items] })
        setLoadError(null)
      })
      .catch((error: unknown) => { if (current) setLoadError(messageOf(error, LOAD_FAILED)) })
    return () => { current = false }
  }, [importApi, catalogApi, key, attempt])

  const refresh = useCallback(() => setAttempt((value) => value + 1), [])
  const { busy, feedback, setFeedback, run } = useActionRunner(refresh, key)
  const data = loaded?.key === key ? loaded : null

  // Another wallet starts clean (adjusted while rendering, the way React recommends).
  const [formKey, setFormKey] = useState(key)
  if (formKey !== key) {
    setFormKey(key)
    setEditing(null)
    setFormError(null)
    setFeedback(null)
    setLoadError(null)
  }

  if (loadError && !data) return <ErrorState message={loadError} onRetry={() => { setLoadError(null); refresh() }} />
  if (!data) return <LoadingState label="Carregando regras…" />

  const { categories } = data
  const update = (changes: Partial<CategorizationRuleInput>) =>
    setEditing((current) => (current ? { ...current, draft: { ...current.draft, ...changes } } : current))

  // A removed category or subcategory is not offered again: the person picks one that exists.
  const startEdit = (rule: CategorizationRule) => {
    const category = categories.find((item) => item.id === rule.categoryId && item.nature === rule.type)
    const subcategoryExists = category?.subcategories.some((sub) => sub.id === rule.subcategoryId) ?? false
    setFormError(null)
    setEditing({
      id: rule.id,
      draft: { ...inputOf(rule), categoryId: category ? rule.categoryId : '', subcategoryId: subcategoryExists ? rule.subcategoryId : null },
    })
  }

  const save = () => {
    if (!editing) return
    const description = editing.draft.description.trim()
    if (!description) return setFormError(RULE_DESCRIPTION_REQUIRED)
    if (!editing.draft.categoryId) return setFormError(RULE_CATEGORY_REQUIRED)
    setFormError(null)
    const input = { ...editing.draft, description }
    const { id } = editing
    void run(async () => {
      const saved = id ? await importApi.updateRule(id, input) : await importApi.createRule(input)
      return `Regra para “${saved.description}” salva.`
    }, () => setEditing(null))
  }

  const toggle = (rule: CategorizationRule) =>
    void run(async () => {
      const saved = await importApi.updateRule(rule.id, { ...inputOf(rule), isActive: !rule.isActive })
      return saved.isActive ? 'Regra ativada.' : 'Regra desativada.'
    })

  const remove = (rule: CategorizationRule) =>
    Alert.alert('Excluir regra', `Excluir a regra para “${rule.description}”? As próximas importações deixam de usá-la.`, [
      { text: 'Cancelar', style: 'cancel' },
      {
        text: 'Excluir',
        style: 'destructive',
        onPress: () => void run(async () => {
          await importApi.deleteRule(rule.id)
          return 'Regra excluída.'
        }),
      },
    ])

  const draft = editing?.draft
  const ofType = categories.filter((category) => category.nature === draft?.type)
  const category = ofType.find((item) => item.id === draft?.categoryId)

  return (
    <ScrollView contentContainerStyle={listStyles.screen} keyboardShouldPersistTaps="handled">
      <Text style={formStyles.title} accessibilityRole="header">Regras de categorização</Text>
      <Text style={listStyles.detail}>
        Uma regra classifica, nas próximas importações desta carteira, as entradas ou saídas com exatamente a mesma descrição.
      </Text>
      <ScreenMessages feedback={feedback} loadError={loadError} onRetry={refresh} />

      {editing && draft ? (
        <View style={listStyles.card}>
          <Text style={listStyles.primary}>{editing.id ? 'Editar regra' : 'Nova regra'}</Text>
          <TextField label="Descrição exata da movimentação" value={draft.description} onChangeText={(description) => update({ description })} maxLength={512} />
          <Text style={styles.label}>Tipo</Text>
          <ChoiceChips options={TYPE_OPTIONS} value={draft.type} onChange={(type) => update({ type, categoryId: '', subcategoryId: null })} />
          <Text style={styles.label}>Categoria</Text>
          {ofType.length === 0 ? <Text style={listStyles.detail}>Nenhuma categoria deste tipo na carteira. Cadastre uma em Categorias.</Text> : null}
          <ChoiceChips
            options={ofType.map((item) => ({ value: item.id, label: item.name }))}
            value={draft.categoryId}
            onChange={(categoryId) => update({ categoryId, subcategoryId: null })}
          />
          {category && category.subcategories.length > 0 ? (
            <>
              <Text style={styles.label}>Subcategoria</Text>
              <ChoiceChips
                options={[{ value: NONE, label: 'Sem subcategoria' }, ...category.subcategories.map((sub) => ({ value: sub.id, label: sub.name }))]}
                value={draft.subcategoryId ?? NONE}
                onChange={(id) => update({ subcategoryId: id || null })}
              />
            </>
          ) : null}
          <Text style={styles.label}>Situação</Text>
          <ChoiceChips options={ACTIVE_OPTIONS} value={draft.isActive ? 'yes' : 'no'} onChange={(value) => update({ isActive: value === 'yes' })} />
          {formError ? <FormMessage tone="error" message={formError} /> : null}
          <PrimaryButton label={editing.id ? 'Salvar regra' : 'Confirmar e criar regra'} onPress={save} busy={busy} />
          <LinkButton label="Cancelar edição da regra" onPress={() => { setEditing(null); setFormError(null) }} />
        </View>
      ) : (
        <PrimaryButton label="Nova regra" onPress={() => { setFormError(null); setEditing({ id: null, draft: EMPTY }) }} />
      )}

      {data.rules.length === 0 ? <Text style={formStyles.body}>Nenhuma regra nesta carteira.</Text> : null}
      {data.rules.map((rule) => {
        const name = ruleName(rule)
        return (
          <View key={rule.id} style={[listStyles.card, !rule.isActive && listStyles.inactive]}>
            <Text style={listStyles.primary}>{rule.description}</Text>
            <Text style={listStyles.detail}>
              {RULE_TYPE_LABELS[rule.type]} · {rule.categoryName ?? 'Categoria removida'}
              {rule.subcategoryId ? ` › ${rule.subcategoryName ?? 'subcategoria removida'}` : ''}
              {rule.isActive ? '' : ' · desativada'}
            </Text>
            {rule.isStale ? <Text style={styles.warning}>A categoria foi removida. Edite a regra para ela voltar a classificar movimentações.</Text> : null}
            <View style={listStyles.actions}>
              <LinkButton label={`Editar ${name}`} onPress={() => startEdit(rule)} />
              {rule.isStale ? null : <LinkButton label={`${rule.isActive ? 'Desativar' : 'Ativar'} ${name}`} onPress={() => toggle(rule)} />}
              <LinkButton label={`Excluir ${name}`} onPress={() => remove(rule)} />
            </View>
          </View>
        )
      })}
    </ScrollView>
  )
}

const styles = StyleSheet.create({
  label: { fontSize: typography.caption, color: colors.textMuted, marginTop: spacing.xs },
  warning: { fontSize: typography.caption, color: colors.danger },
})
