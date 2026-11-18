import { useCallback, useEffect, useState } from 'react'
import { Alert, ScrollView, StyleSheet, Text, View } from 'react-native'

import type { CatalogApi, Category } from '../catalog/catalogApi'
import type { ImportApi, ImportItem, ImportItemInput, ImportSession } from '../imports/importApi'
import { ImportItemEditor } from '../imports/ImportItemEditor'
import {
  createDraft,
  currentReconciliation,
  describeImporter,
  DISCARDED_MESSAGE,
  effectiveClosingDate,
  isCardSession,
  ITEM_STATUS_LABELS,
  itemDate,
  itemName,
  reconciliationOptions,
  sessionStatusLabel,
  typeLabel,
} from '../imports/importModel'
import { formatAmount } from '../money/amount'
import { formatDate } from '../period/period'
import { formStyles, LinkButton, PrimaryButton } from '../ui/Form'
import { listStyles } from '../ui/listStyles'
import { ScreenMessages } from '../ui/ScreenMessages'
import { ErrorState, LoadingState } from '../ui/StateViews'
import { colors, spacing, typography } from '../ui/theme'
import { messageOf, useActionRunner } from '../ui/useActionRunner'

const LOAD_FAILED = 'Não foi possível carregar a importação. Tente novamente.'
export const ITEMS_PER_PAGE = 50
export const SAVE_BEFORE_CONFIRMING = 'Salve ou cancele a edição da movimentação antes de confirmar.'

type Loaded = { session: ImportSession; categories: Category[] }

/**
 * The message of a confirmation, from what the API answered. A return to the preview has more than one
 * cause (a possible duplicate, a statement paid meanwhile, no valid line left), so none is named here:
 * the lines carry the real one (Code Review of PR #129).
 */
function confirmationMessage(session: ImportSession): string {
  if (session.status === 'completed') return `Importação confirmada: ${session.summary.imported} movimentações importadas.`
  if (session.status === 'preview') return 'Nenhuma movimentação foi importada: a prévia voltou para revisão. Confira as movimentações sinalizadas.'
  return `Importação ${sessionStatusLabel(session).toLowerCase()}.`
}

function confirmThen(title: string, message: string, action: string, onConfirm: () => void) {
  Alert.alert(title, message, [{ text: 'Cancelar', style: 'cancel' }, { text: action, style: 'destructive', onPress: onConfirm }])
}

/**
 * One import of the active wallet. In preview, each line can be corrected (date, description, type,
 * category, the statement of a card purchase, the reconciliation of a bank transfer), a possible
 * duplicate can be imported anyway, and the whole preview is confirmed or discarded. After confirmation
 * it can be undone while the API allows (`canUndo`, or the reason it does not). Totals, statements and
 * statuses are the API's, read again after every action; nothing is recomputed here.
 */
export function ImportPreviewScreen({
  importId,
  importApi,
  catalogApi,
}: {
  importId: string
  importApi: ImportApi
  catalogApi: Pick<CatalogApi, 'listCategories'>
}) {
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [visible, setVisible] = useState(ITEMS_PER_PAGE)

  useEffect(() => {
    let current = true
    void Promise.all([importApi.get(importId), catalogApi.listCategories('income'), catalogApi.listCategories('expense')])
      .then(([session, incomes, expenses]) => {
        if (!current) return
        setLoaded({ session, categories: [...incomes.items, ...expenses.items] })
        setLoadError(null)
      })
      .catch((error: unknown) => { if (current) setLoadError(messageOf(error, LOAD_FAILED)) })
    return () => { current = false }
  }, [importApi, catalogApi, importId, attempt])

  const refresh = useCallback(() => setAttempt((value) => value + 1), [])
  const { busy, feedback, run } = useActionRunner(refresh, importId)

  if (loadError && !loaded) return <ErrorState message={loadError} onRetry={() => { setLoadError(null); refresh() }} />
  if (!loaded) return <LoadingState label="Carregando importação…" />

  const { session, categories } = loaded
  const items = session.items ?? []
  const inPreview = session.status === 'preview'
  const card = isCardSession(session)
  const closingDay = session.creditCardClosingDay ?? null
  const names = new Map([...categories.flatMap((category) => [
    [category.id, category.name] as const,
    ...category.subcategories.map((sub) => [sub.id, sub.name] as const),
  ])])

  const save = (item: ImportItem, input: ImportItemInput) =>
    void run(async () => {
      await importApi.updateItem(session.id, item.id, input)
      return 'Movimentação salva.'
    }, () => setEditingId(null))

  const includeDuplicate = (item: ImportItem) =>
    void run(async () => {
      await importApi.updateItem(session.id, item.id, { ...createDraft(item), includeDuplicate: true })
      return 'A movimentação será importada mesmo sendo uma possível duplicidade.'
    })

  const confirm = () => void run(async () => confirmationMessage(await importApi.confirm(session.id)))
  const discard = () => confirmThen('Descartar prévia', 'Nenhuma movimentação será importada. A importação fica no histórico como descartada.', 'Descartar', () => {
    void run(async () => {
      await importApi.discard(session.id)
      return 'Prévia descartada.'
    })
  })
  const undo = () => confirmThen('Desfazer importação', 'Os lançamentos criados por esta importação serão removidos.', 'Desfazer', () => {
    void run(async () => {
      const result = await importApi.undo(session.id)
      return result.status === 'undone' ? 'Importação desfeita.' : `Importação ${sessionStatusLabel(result).toLowerCase()}.`
    })
  })

  const reconciliationLabel = (item: ImportItem) => {
    const value = currentReconciliation(createDraft(item))
    if (!value) return null
    return reconciliationOptions(item).find((option) => option.value === value)?.label ?? 'Conciliada'
  }

  return (
    <ScrollView contentContainerStyle={listStyles.screen} keyboardShouldPersistTaps="handled">
      <Text style={formStyles.title} accessibilityRole="header">{session.fileName}</Text>
      <Text style={listStyles.detail}>
        {card ? `Fatura de ${session.creditCardName ?? 'cartão'}` : 'Extrato bancário'} · {sessionStatusLabel(session)} · {describeImporter(session)}
      </Text>
      <ScreenMessages feedback={feedback} loadError={loadError} onRetry={refresh} />

      {session.status === 'failed' && session.failureMessage && session.failureMessage !== DISCARDED_MESSAGE
        ? <Text style={formStyles.body}>{session.failureMessage}</Text>
        : null}
      {session.status === 'processing' || session.status === 'confirming' ? (
        <View style={listStyles.card}>
          <Text style={listStyles.detail}>A importação ainda está em andamento.</Text>
          <LinkButton label="Atualizar importação" onPress={refresh} />
        </View>
      ) : null}

      <View style={listStyles.card}>
        <Text style={listStyles.primary}>Resumo</Text>
        <Text style={listStyles.detail}>
          {session.summary.total} movimentações · {session.summary.valid} prontas · {session.summary.uncategorized} sem categoria · {session.summary.duplicate} duplicadas · {session.summary.invalid} inválidas · {session.summary.imported} importadas
        </Text>
      </View>

      {card ? (session.statements ?? []).map((statement) => (
        <View key={statement.closingDate} style={listStyles.card}>
          <Text style={listStyles.primary}>Fatura que fecha em {formatDate(statement.closingDate)} · vence em {formatDate(statement.dueDate)}</Text>
          <Text style={listStyles.detail}>
            Compras {formatAmount(statement.purchasesAmount)} · estornos {formatAmount(statement.creditsAmount)} · total {formatAmount(statement.totalAmount)}{statement.isPaid ? ' · já paga' : ''}
          </Text>
        </View>
      )) : null}

      {inPreview ? (
        <View style={listStyles.card}>
          {editingId
            ? <Text style={listStyles.detail}>{SAVE_BEFORE_CONFIRMING}</Text>
            : <PrimaryButton label="Confirmar importação" onPress={confirm} busy={busy} />}
          <Text style={listStyles.detail}>Só as movimentações prontas são importadas. Inválidas, duplicadas não aceitas e sem categoria ficam de fora.</Text>
          <LinkButton label="Descartar prévia" onPress={discard} />
        </View>
      ) : null}
      {session.status === 'completed' ? (
        <View style={listStyles.card}>
          {session.canUndo
            ? <LinkButton label="Desfazer importação" onPress={undo} />
            : <Text style={listStyles.detail}>{session.undoBlockedReason ?? 'Esta importação não pode mais ser desfeita.'}</Text>}
        </View>
      ) : null}

      {items.slice(0, visible).map((item) => {
        const name = itemName(item)
        const statementDate = card ? effectiveClosingDate(item, closingDay) : null
        const reconciliation = reconciliationLabel(item)
        return (
          <View key={item.id} style={listStyles.card}>
            <Text style={listStyles.primary}>{item.description ?? 'Sem descrição'}</Text>
            <Text style={styles.amount}>{formatAmount(item.amount)} · {typeLabel(session, item.type)}</Text>
            <Text style={listStyles.detail}>Linha {item.sequence} · {itemDate(item)} · {ITEM_STATUS_LABELS[item.validationStatus]}</Text>
            {item.categoryId ? (
              <Text style={listStyles.detail}>
                {names.get(item.categoryId) ?? 'Categoria'}{item.subcategoryId ? ` › ${names.get(item.subcategoryId) ?? 'subcategoria'}` : ''}
                {item.categorizationSource === 'rule' ? ' · sugerida por regra' : ''}
              </Text>
            ) : null}
            {statementDate ? <Text style={listStyles.detail}>Fatura que fecha em {formatDate(statementDate)}</Text> : null}
            {reconciliation ? <Text style={listStyles.detail}>{reconciliation}</Text> : null}
            {item.errorMessage ? <Text style={styles.error}>{item.errorMessage}</Text> : null}

            {inPreview && editingId === item.id ? (
              <ImportItemEditor
                session={session}
                item={item}
                categories={categories}
                busy={busy}
                onSave={(input) => save(item, input)}
                onCancel={() => setEditingId(null)}
              />
            ) : null}
            {inPreview && editingId !== item.id ? (
              <View style={listStyles.actions}>
                {item.canEdit ? <LinkButton label={`Editar ${name}`} onPress={() => setEditingId(item.id)} /> : null}
                {item.validationStatus === 'duplicate' && item.canIncludeDuplicate
                  ? <LinkButton label={`Importar mesmo assim ${name}`} onPress={() => includeDuplicate(item)} />
                  : null}
              </View>
            ) : null}
          </View>
        )
      })}
      {items.length > visible
        ? <LinkButton label={`Mostrar mais ${Math.min(ITEMS_PER_PAGE, items.length - visible)} movimentações`} onPress={() => setVisible((value) => value + ITEMS_PER_PAGE)} />
        : null}
    </ScrollView>
  )
}

const styles = StyleSheet.create({
  amount: { fontSize: typography.body, fontWeight: '600', color: colors.text },
  error: { fontSize: typography.caption, color: colors.danger, marginTop: spacing.xs },
})
