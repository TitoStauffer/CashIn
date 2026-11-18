import { useState } from 'react'
import { StyleSheet, Text, View } from 'react-native'

import type { Category } from '../catalog/catalogApi'
import { DATE_INVALID, formatDate, parseDateInput } from '../period/period'
import { ChoiceChips } from '../ui/ChoiceChips'
import { FormMessage, LinkButton, PrimaryButton, TextField } from '../ui/Form'
import { colors, spacing, typography } from '../ui/theme'
import type { ImportItem, ImportItemInput, ImportSession } from './importApi'
import {
  adjacentClosingDates,
  canReconcile,
  createDraft,
  currentReconciliation,
  describeMissingReconciliation,
  hasCategory,
  reconciliationOptions,
  typeOptions,
  withDate,
  withType,
} from './importModel'

const NONE = ''
export const DESCRIPTION_REQUIRED = 'Informe a descrição.'

/**
 * The editor of one preview item: date, description, type and, as the type allows, category and
 * subcategory, the statement of a card item, or the reconciliation of a bank transfer. Everything the
 * API offers comes from the item itself (candidates, counterpart wallets); the editor only chooses among
 * them. A category of the item missing from the lists stays selectable, so saving never drops it.
 */
export function ImportItemEditor({
  session,
  item,
  categories,
  busy,
  onSave,
  onCancel,
}: {
  session: Pick<ImportSession, 'kind' | 'creditCardClosingDay'>
  item: ImportItem
  /** The income and expense categories of the wallet. */
  categories: Category[]
  busy: boolean
  onSave(input: ImportItemInput): void
  onCancel(): void
}) {
  const [draft, setDraft] = useState(() => createDraft(item))
  const [dateText, setDateText] = useState(() => (item.date ? formatDate(item.date) : ''))
  const [error, setError] = useState<string | null>(null)

  const update = (changes: Partial<ImportItemInput>) => setDraft((current) => ({ ...current, ...changes }))
  // A new valid date moves the item back to the statement it calculates right away, so a statement picked
  // after the new date is kept on save.
  const changeDate = (text: string) => {
    setDateText(text)
    const date = parseDateInput(text)
    if (date) setDraft((current) => (date === current.date ? current : withDate(current, date)))
  }
  const closingDay = session.creditCardClosingDay ?? null
  const ofNature = categories.filter((category) => category.nature === draft.type)
  const known = categories.some((category) => category.id === draft.categoryId)
  const categoryOptions = [
    { value: NONE, label: 'Sem categoria' },
    ...(draft.categoryId && !known ? [{ value: draft.categoryId, label: 'Categoria atual' }] : []),
    ...ofNature.map((category) => ({ value: category.id, label: category.name })),
  ]
  const category = categories.find((option) => option.id === draft.categoryId)
  const subcategoryOptions = [
    { value: NONE, label: 'Sem subcategoria' },
    ...(draft.subcategoryId && !category?.subcategories.some((sub) => sub.id === draft.subcategoryId) ? [{ value: draft.subcategoryId, label: 'Subcategoria atual' }] : []),
    ...(category?.subcategories ?? []).map((sub) => ({ value: sub.id, label: sub.name })),
  ]
  const reconciliations = reconciliationOptions(item)
  const parsedDate = parseDateInput(dateText)
  const statementOptions = closingDay !== null && parsedDate
    ? [
        { value: NONE, label: 'Pela data da compra' },
        ...adjacentClosingDates(parsedDate, closingDay).map((date) => ({ value: date, label: `Fecha em ${formatDate(date)}` })),
      ]
    : []

  const save = () => {
    const date = parseDateInput(dateText)
    if (!date) return setError(DATE_INVALID)
    if (!draft.description.trim()) return setError(DESCRIPTION_REQUIRED)
    setError(null)
    onSave({ ...draft, date, description: draft.description.trim() })
  }

  return (
    <View style={styles.editor}>
      <TextField label="Data (DD/MM/AAAA)" value={dateText} onChangeText={changeDate} keyboardType="numbers-and-punctuation" />
      <TextField label="Descrição" value={draft.description} onChangeText={(description) => update({ description })} />
      <Text style={styles.label}>Tipo</Text>
      <ChoiceChips options={typeOptions(session)} value={draft.type} onChange={(type) => setDraft((current) => withType(current, type))} />

      {hasCategory(draft.type) ? (
        <>
          <Text style={styles.label}>Categoria</Text>
          <ChoiceChips options={categoryOptions} value={draft.categoryId ?? NONE} onChange={(id) => update({ categoryId: id || null, subcategoryId: null })} />
          {category && category.subcategories.length > 0 || draft.subcategoryId ? (
            <>
              <Text style={styles.label}>Subcategoria</Text>
              <ChoiceChips options={subcategoryOptions} value={draft.subcategoryId ?? NONE} onChange={(id) => update({ subcategoryId: id || null })} />
            </>
          ) : null}
        </>
      ) : null}

      {statementOptions.length > 0 ? (
        <>
          <Text style={styles.label}>Fatura</Text>
          <ChoiceChips options={statementOptions} value={draft.statementClosingDate ?? NONE} onChange={(date) => update({ statementClosingDate: date || null })} />
        </>
      ) : null}

      {canReconcile(session, draft.type) ? (
        <>
          <Text style={styles.label}>Conciliação</Text>
          {draft.type !== item.type || reconciliations.length === 0
            ? <Text style={styles.detail}>{draft.type !== item.type ? describeMissingReconciliation({ ...item, reconciliationUnavailableReason: 'not_a_transfer' }) : describeMissingReconciliation(item)}</Text>
            : (
              <ChoiceChips
                options={[{ value: NONE, label: 'Sem conciliação' }, ...reconciliations.map(({ value, label }) => ({ value, label }))]}
                value={currentReconciliation(draft)}
                onChange={(value) => update(reconciliations.find((option) => option.value === value)?.changes
                  ?? { creditCardStatementId: null, walletTransferId: null, transferCounterpartWalletId: null })}
              />
            )}
        </>
      ) : null}

      {error ? <FormMessage tone="error" message={error} /> : null}
      <PrimaryButton label="Salvar movimentação" onPress={save} busy={busy} />
      <LinkButton label="Cancelar edição" onPress={onCancel} />
    </View>
  )
}

const styles = StyleSheet.create({
  editor: { gap: spacing.xs, marginTop: spacing.sm },
  label: { fontSize: typography.caption, color: colors.textMuted },
  detail: { fontSize: typography.caption, color: colors.textMuted },
})
