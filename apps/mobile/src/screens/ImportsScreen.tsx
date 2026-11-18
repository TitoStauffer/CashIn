import { useCallback, useEffect, useState } from 'react'
import { ScrollView, Text, View } from 'react-native'

import type { CreditCard, CreditCardApi } from '../cards/creditCardApi'
import { CsvImportSetup } from '../imports/CsvImportSetup'
import type { ImportApi, ImportFile, ImportSession } from '../imports/importApi'
import { describeImporter, DISCARDED_MESSAGE, formatFileSize, formatTimestampDate, importNames, sessionStatusLabel } from '../imports/importModel'
import { ChoiceChips } from '../ui/ChoiceChips'
import { formStyles, LinkButton, PrimaryButton } from '../ui/Form'
import { listStyles } from '../ui/listStyles'
import { ScreenMessages } from '../ui/ScreenMessages'
import { ErrorState, LoadingState } from '../ui/StateViews'
import { messageOf, useActionRunner } from '../ui/useActionRunner'

const LOAD_FAILED = 'Não foi possível carregar as importações. Tente novamente.'
export const NO_ACTIVE_CARD = 'Cadastre ou reative um cartão em Cartões para importar a fatura.'
export const PICK_FAILED = 'Não foi possível abrir o arquivo escolhido. Tente novamente.'

type Kind = 'bank' | 'card'
type Format = 'ofx' | 'csv'
type Loaded = { key: string; sessions: ImportSession[]; cards: CreditCard[] }
/** A CSV chosen and waiting for its setup, with the card it was chosen for. */
type PendingCsv = { file: ImportFile; card: { id: string; nickname: string } | null }

const KIND_OPTIONS = [
  { value: 'bank', label: 'Extrato bancário' },
  { value: 'card', label: 'Fatura de cartão' },
] as const

const FORMAT_OPTIONS = [
  { value: 'ofx', label: 'OFX' },
  { value: 'csv', label: 'CSV' },
] as const

function summaryLine(session: ImportSession): string {
  const { summary } = session
  return `${summary.valid} prontas · ${summary.uncategorized} sem categoria · ${summary.duplicate} duplicadas · ${summary.invalid} inválidas · ${summary.imported} importadas`
}

/**
 * The imports of the active wallet: a new OFX or CSV import, of a bank statement or of the statement of
 * an active card, and the history, newest first as the API sends it. The file is read by `pickFile` and
 * goes to the API as is; its content is never shown, logged or kept by the screen. An OFX goes right away;
 * a CSV opens its setup first (`CsvImportSetup`). A refusal (size, format, a structural error, a card
 * statement sent as a bank statement) is the API's message.
 */
export function ImportsScreen({
  walletId,
  importApi,
  cardApi,
  pickFile,
  onOpenImport,
  refreshKey = 0,
}: {
  walletId: string
  importApi: ImportApi
  cardApi: Pick<CreditCardApi, 'list'>
  /** Opens the device's file picker; null when the person gave up choosing. */
  pickFile(): Promise<ImportFile | null>
  onOpenImport(importId: string): void
  /** Bumped by the route when it is focused again, so a confirmed or undone import shows its new state. */
  refreshKey?: number
}) {
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [kind, setKind] = useState<Kind>('bank')
  const [cardId, setCardId] = useState<string | null>(null)
  const [format, setFormat] = useState<Format>('ofx')
  const [pendingCsv, setPendingCsv] = useState<PendingCsv | null>(null)
  const key = walletId

  useEffect(() => {
    let current = true
    void Promise.all([importApi.list(), cardApi.list()])
      .then(([sessions, cards]) => {
        if (!current) return
        setLoaded({ key, sessions: sessions.items, cards: cards.items.filter((card) => card.isActive) })
        setLoadError(null)
      })
      .catch((error: unknown) => { if (current) setLoadError(messageOf(error, LOAD_FAILED)) })
    return () => { current = false }
  }, [importApi, cardApi, key, attempt, refreshKey])

  const refresh = useCallback(() => setAttempt((value) => value + 1), [])
  const { busy, feedback, setFeedback, run } = useActionRunner(refresh, key)
  const data = loaded?.key === key ? loaded : null

  // Another wallet starts clean (adjusted while rendering, the way React recommends).
  const [formKey, setFormKey] = useState(key)
  if (formKey !== key) {
    setFormKey(key)
    setKind('bank')
    setCardId(null)
    setFormat('ofx')
    setPendingCsv(null)
    setFeedback(null)
    setLoadError(null)
  }

  if (loadError && !data) return <ErrorState message={loadError} onRetry={() => { setLoadError(null); refresh() }} />
  if (!data) return <LoadingState label="Carregando importações…" />

  // A card chosen earlier and since deactivated is not sent: the API would answer 404.
  const card = data.cards.find((item) => item.id === cardId) ?? null
  const names = importNames(data.sessions)

  const startImport = () => {
    if (kind === 'card' && !card) return setFeedback({ tone: 'error', message: data.cards.length ? 'Escolha o cartão da fatura.' : NO_ACTIVE_CARD })
    const chosenCard = kind === 'card' && card ? { id: card.id, nickname: card.nickname } : null
    let created: string | null = null
    let picked: ImportFile | null = null
    void run(async () => {
      try {
        picked = await pickFile()
      } catch {
        throw new Error(PICK_FAILED)
      }
      if (!picked || format === 'csv') return
      created = (await importApi.upload(picked, { format: 'ofx', creditCardId: chosenCard?.id ?? null })).id
    }, () => {
      // Opened only while the wallet is still the one the file was chosen in: the preview of another
      // wallet's import would answer 404 in the new one.
      if (created) onOpenImport(created)
      else if (picked && format === 'csv') setPendingCsv({ file: picked, card: chosenCard })
    })
  }

  return (
    <ScrollView contentContainerStyle={listStyles.screen} keyboardShouldPersistTaps="handled">
      <Text style={formStyles.title} accessibilityRole="header">Importações</Text>
      <ScreenMessages feedback={feedback} loadError={loadError} onRetry={refresh} />

      {pendingCsv ? (
        <CsvImportSetup
          key={`${pendingCsv.file.name}:${pendingCsv.card?.id ?? 'bank'}`}
          file={pendingCsv.file}
          card={pendingCsv.card}
          importApi={importApi}
          onUploaded={(importId) => { setPendingCsv(null); onOpenImport(importId) }}
          onCancel={() => setPendingCsv(null)}
        />
      ) : (
      <View style={listStyles.card}>
        <Text style={listStyles.primary}>Nova importação</Text>
        <Text style={listStyles.detail}>Escolha o arquivo OFX ou CSV baixado do banco (até 10 MB). Você revisa a prévia antes de confirmar.</Text>
        <ChoiceChips<Kind> options={KIND_OPTIONS} value={kind} onChange={setKind} />
        <ChoiceChips<Format> options={FORMAT_OPTIONS} value={format} onChange={setFormat} />
        {kind === 'card' && data.cards.length === 0 ? <Text style={listStyles.detail}>{NO_ACTIVE_CARD}</Text> : null}
        {kind === 'card' && data.cards.length > 0 ? (
          <ChoiceChips options={data.cards.map((item) => ({ value: item.id, label: item.nickname }))} value={card?.id ?? ''} onChange={setCardId} />
        ) : null}
        <PrimaryButton label={format === 'csv' ? 'Escolher arquivo CSV' : 'Escolher arquivo OFX'} onPress={startImport} busy={busy} />
      </View>
      )}

      {data.sessions.length === 0 ? <Text style={formStyles.body}>Nenhuma importação nesta carteira.</Text> : null}
      {data.sessions.map((session, index) => (
        <View key={session.id} style={listStyles.card}>
          <Text style={listStyles.primary}>{session.fileName}</Text>
          <Text style={listStyles.detail}>
            {sessionStatusLabel(session)} · {formatTimestampDate(session.createdAt)} · {formatFileSize(session.fileSize)} · {describeImporter(session)}
          </Text>
          {session.kind === 'credit_card_statement' ? <Text style={listStyles.detail}>Fatura de {session.creditCardName ?? 'cartão'}</Text> : null}
          <Text style={listStyles.detail}>{summaryLine(session)}</Text>
          {session.status === 'failed' && session.failureMessage && session.failureMessage !== DISCARDED_MESSAGE
            ? <Text style={listStyles.detail}>{session.failureMessage}</Text>
            : null}
          <LinkButton label={`Abrir ${names[index]}`} onPress={() => onOpenImport(session.id)} />
        </View>
      ))}
    </ScrollView>
  )
}
