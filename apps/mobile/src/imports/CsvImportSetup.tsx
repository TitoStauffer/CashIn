import { useCallback, useEffect, useRef, useState } from 'react'
import { StyleSheet, Text, View } from 'react-native'

import { ChoiceChips } from '../ui/ChoiceChips'
import { LinkButton, PrimaryButton, TextField } from '../ui/Form'
import { listStyles } from '../ui/listStyles'
import { ScreenMessages } from '../ui/ScreenMessages'
import { colors, spacing, typography } from '../ui/theme'
import { messageOf, useActionRunner } from '../ui/useActionRunner'
import type {
  CardAmountSign,
  CsvColumnMapping,
  CsvConfiguration,
  CsvInspection,
  CsvMappingTemplate,
  ImportApi,
  ImportFile,
} from './importApi'
import { CSV_COLUMN_FIELDS, isCsvConfigurationValid } from './importModel'

export const INSPECT_FAILED = 'Não foi possível analisar o arquivo CSV. Tente novamente.'
export const MAPPING_INCOMPLETE = 'Mapeie a data e o valor — ou as colunas de crédito e débito — para continuar.'
export const AMOUNT_SIGN_REQUIRED = 'Informe como o CSV da fatura representa as compras.'
export const WAIT_INSPECTION = 'Aguarde a análise do arquivo.'
export const MAPPING_NAME_REQUIRED = 'Informe um nome para salvar este modelo de CSV.'
export const INSPECT_AGAIN = 'A última análise do arquivo falhou. Tente analisar de novo antes de continuar.'

const NONE = ''
const DETECTED = ''

const DELIMITERS = [{ value: ',', label: 'Vírgula (,)' }, { value: ';', label: 'Ponto e vírgula (;)' }] as const
const ENCODINGS = [{ value: 'utf-8', label: 'UTF-8' }, { value: 'windows-1252', label: 'Windows-1252' }, { value: 'iso-8859-1', label: 'ISO-8859-1' }] as const
const DATE_FORMATS = [{ value: 'dd/MM/yyyy', label: 'DD/MM/AAAA' }, { value: 'MM/dd/yyyy', label: 'MM/DD/AAAA' }, { value: 'yyyy-MM-dd', label: 'AAAA-MM-DD' }] as const
const NUMBER_FORMATS = [{ value: 'pt-BR', label: '1.234,56' }, { value: 'en-US', label: '1,234.56' }] as const
const HEADER_OPTIONS = [
  { value: 'yes', label: 'Sim', accessibilityLabel: 'Primeira linha é cabeçalho: sim' },
  { value: 'no', label: 'Não', accessibilityLabel: 'Primeira linha é cabeçalho: não' },
] as const
const AMOUNT_SIGNS = [
  { value: 'purchases_positive', label: 'Compras com valor positivo' },
  { value: 'purchases_negative', label: 'Compras com valor negativo' },
] as const

type Inspected = { columns: CsvInspection['columns']; sample: CsvInspection['sample'] }
type CsvApi = Pick<ImportApi, 'inspectCsv' | 'listCsvMappings' | 'createCsvMapping' | 'updateCsvMapping' | 'upload'>

function Group({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <View style={styles.group}>
      <Text style={styles.label}>{label}</Text>
      {children}
    </View>
  )
}

/**
 * The setup of one CSV before it is sent: the API inspects the file and suggests formats and columns, the
 * person corrects them and the API recomputes the columns and the sample, a saved model of the wallet can
 * be applied, created or updated, and a card statement says how it writes purchases. Only the response of
 * the latest inspection is applied, and the file is not sent while an inspection is running, so what goes
 * is what the sample shows. The file's content is never read here; only the API's sample is shown.
 */
export function CsvImportSetup({
  file,
  card,
  importApi,
  onUploaded,
  onCancel,
}: {
  file: ImportFile
  /** The active card of a card statement, or null for a bank statement. */
  card: { id: string; nickname: string } | null
  importApi: CsvApi
  onUploaded(importId: string): void
  onCancel(): void
}) {
  const [inspected, setInspected] = useState<Inspected | null>(null)
  const [configuration, setConfiguration] = useState<CsvConfiguration | null>(null)
  const [detected, setDetected] = useState<CsvConfiguration | null>(null)
  const [inspecting, setInspecting] = useState(true)
  const [inspectError, setInspectError] = useState<string | null>(null)
  const [mappings, setMappings] = useState<CsvMappingTemplate[]>([])
  const [selectedId, setSelectedId] = useState(DETECTED)
  const [name, setName] = useState('')
  const [dirty, setDirty] = useState(false)
  const [amountSign, setAmountSign] = useState<CardAmountSign | null>(null)
  const latest = useRef(0)
  // The last inspection asked for, so a retry repeats exactly that request, columns policy included.
  const lastRequest = useRef<{ layout?: CsvConfiguration; keepColumns: boolean }>({ keepColumns: false })
  const mounted = useRef(true)
  useEffect(() => () => { mounted.current = false }, [])

  const noop = useCallback(() => undefined, [])
  const { busy, feedback, setFeedback, run } = useActionRunner(noop)

  // Each inspection is numbered; an answer that is not the latest one is dropped, so a slow response to
  // an earlier layout never replaces the columns and sample of the current one. When the columns are kept,
  // they are the ones on screen when the answer arrives, so a column fixed meanwhile is not undone (Code
  // Review of PR #130); otherwise the API's suggestion replaces them.
  const requestInspection = useCallback((layout: CsvConfiguration | undefined, keepColumns: boolean) => {
    const request = ++latest.current
    void importApi.inspectCsv(file, layout)
      .then((result) => {
        if (!mounted.current || request !== latest.current) return
        setConfiguration((current) => ({
          ...result.detectedConfiguration,
          columns: keepColumns && current ? current.columns : result.suggestedMapping,
        }))
        // The first inspection, without a layout, never keeps columns: it is what the API detected.
        if (!layout) setDetected({ ...result.detectedConfiguration, columns: result.suggestedMapping })
        setInspected({ columns: result.columns, sample: result.sample })
      })
      .catch((error: unknown) => {
        if (mounted.current && request === latest.current) setInspectError(messageOf(error, INSPECT_FAILED))
      })
      .finally(() => {
        if (mounted.current && request === latest.current) setInspecting(false)
      })
  }, [importApi, file])

  useEffect(() => {
    requestInspection(undefined, false)
    void importApi.listCsvMappings()
      .then(({ items }) => { if (mounted.current) setMappings(items) })
      // Without the models the file can still be set up by hand; the list is only a shortcut.
      .catch(() => undefined)
  }, [importApi, requestInspection])

  const inspect = (layout: CsvConfiguration | undefined, keepColumns: boolean) => {
    setInspecting(true)
    setInspectError(null)
    // A message about the previous layout no longer describes what is on screen.
    setFeedback(null)
    lastRequest.current = { layout, keepColumns }
    requestInspection(layout, keepColumns)
  }

  const changeFormat = (changes: Partial<CsvConfiguration>, keepColumns: boolean) => {
    if (!configuration) return
    const next = { ...configuration, ...changes }
    setConfiguration(next)
    if (selectedId) setDirty(true)
    // The delimiter, the encoding and the header change the columns themselves; the date and money
    // formats only change how the same columns are read.
    inspect(next, keepColumns)
  }

  const changeColumn = (field: keyof CsvColumnMapping, value: string) => {
    if (!configuration) return
    setConfiguration({ ...configuration, columns: { ...configuration.columns, [field]: value === NONE ? null : Number(value) } })
    if (selectedId) setDirty(true)
  }

  const selectMapping = (id: string) => {
    setSelectedId(id)
    setDirty(false)
    const mapping = mappings.find((item) => item.id === id)
    const layout = mapping?.configuration ?? detected
    setName(mapping?.name ?? '')
    if (!layout) return
    setConfiguration(layout)
    inspect(layout, true)
  }

  // After a failed inspection the layout on screen may no longer match the sample (Code Review of PR #130),
  // so nothing is sent or saved until an inspection succeeds again.
  const ready = !inspecting && !inspectError && isCsvConfigurationValid(configuration, inspected?.columns ?? [])
  const blockedMessage = inspecting ? WAIT_INSPECTION : inspectError ? INSPECT_AGAIN : MAPPING_INCOMPLETE

  const saveMapping = () => {
    if (!configuration || !ready) return setFeedback({ tone: 'error', message: blockedMessage })
    const trimmed = name.trim()
    if (!trimmed) return setFeedback({ tone: 'error', message: MAPPING_NAME_REQUIRED })
    const layout = configuration
    void run(async () => {
      const mapping = selectedId
        ? await importApi.updateCsvMapping(selectedId, trimmed, layout)
        : await importApi.createCsvMapping(trimmed, layout)
      if (!mounted.current) return
      setMappings((current) => [mapping, ...current.filter((item) => item.id !== mapping.id)])
      setSelectedId(mapping.id)
      setName(mapping.name)
      setConfiguration(mapping.configuration)
      setDirty(false)
      return `Modelo “${mapping.name}” salvo para esta carteira.`
    })
  }

  const send = () => {
    if (!configuration || !ready) return setFeedback({ tone: 'error', message: blockedMessage })
    if (card && !amountSign) return setFeedback({ tone: 'error', message: AMOUNT_SIGN_REQUIRED })
    // A saved model unchanged goes by its id; anything edited goes as the layout on screen.
    const csvMapping = selectedId && !dirty ? { mappingId: selectedId } : { configuration }
    const statement = card && amountSign ? { creditCardId: card.id, amountSign } : null
    let created: string | null = null
    void run(async () => {
      created = (await importApi.upload(file, { format: 'csv', csvMapping, card: statement })).id
    }, () => {
      // Opened only while this setup is still on screen: a wallet change unmounts it.
      if (created && mounted.current) onUploaded(created)
    })
  }

  // A file may repeat a header ("Valor" twice), so a repeated label also names the column's position, on
  // screen and to screen readers (rule 23; Code Review of PR #130).
  const headers = (inspected?.columns ?? []).map((column) => column.label)
  const columnName = (column: { index: number; label: string }) =>
    headers.indexOf(column.label) !== headers.lastIndexOf(column.label) ? `${column.index + 1} (${column.label})` : column.label
  const columnOptions = (field: { key: keyof CsvColumnMapping; label: string }) => [
    ...(field.key === 'date' ? [] : [{ value: NONE, label: 'Não mapear', accessibilityLabel: `${field.label}: não mapear` }]),
    ...(inspected?.columns ?? []).map((column) => ({
      value: String(column.index),
      label: columnName(column),
      accessibilityLabel: `${field.label}: coluna ${columnName(column)}`,
    })),
  ]

  return (
    <View style={listStyles.card}>
      <Text style={listStyles.primary}>Configurar {file.name}</Text>
      <Text style={listStyles.detail}>
        {card ? `Fatura de ${card.nickname}. ` : 'Extrato bancário. '}A detecção é só uma sugestão: confira a amostra antes de enviar.
      </Text>
      <ScreenMessages feedback={feedback} loadError={inspectError} onRetry={() => inspect(lastRequest.current.layout, lastRequest.current.keepColumns)} />
      {inspecting ? <Text style={listStyles.detail}>Analisando o arquivo…</Text> : null}

      {mappings.length > 0 ? (
        <Group label="Modelo">
          <ChoiceChips
            options={[{ value: DETECTED, label: 'Configuração detectada' }, ...mappings.map((mapping) => ({ value: mapping.id, label: mapping.name }))]}
            value={selectedId}
            onChange={selectMapping}
          />
        </Group>
      ) : null}

      {configuration ? (
        <>
          <Group label="Delimitador">
            <ChoiceChips options={DELIMITERS} value={configuration.delimiter} onChange={(delimiter) => changeFormat({ delimiter }, false)} />
          </Group>
          <Group label="Codificação">
            <ChoiceChips options={ENCODINGS} value={configuration.encoding} onChange={(encoding) => changeFormat({ encoding }, false)} />
          </Group>
          <Group label="Primeira linha é cabeçalho">
            <ChoiceChips options={HEADER_OPTIONS} value={configuration.hasHeader ? 'yes' : 'no'} onChange={(value) => changeFormat({ hasHeader: value === 'yes' }, false)} />
          </Group>
          <Group label="Formato da data">
            <ChoiceChips options={DATE_FORMATS} value={configuration.dateFormat} onChange={(dateFormat) => changeFormat({ dateFormat }, true)} />
          </Group>
          <Group label="Formato do valor">
            <ChoiceChips options={NUMBER_FORMATS} value={configuration.numberFormat} onChange={(numberFormat) => changeFormat({ numberFormat }, true)} />
          </Group>

          {CSV_COLUMN_FIELDS.map((field) => (
            <Group key={field.key} label={field.key === 'date' ? `${field.label} *` : field.label}>
              <ChoiceChips options={columnOptions(field)} value={configuration.columns[field.key] === null ? NONE : String(configuration.columns[field.key])} onChange={(value) => changeColumn(field.key, value)} />
            </Group>
          ))}
          <Text style={listStyles.detail}>Mapeie “Valor único” ou use “Crédito” e “Débito” em conjunto.</Text>
          {!inspecting && !ready ? <Text style={styles.warning}>{blockedMessage}</Text> : null}

          {card ? (
            <Group label="Como o arquivo mostra as compras">
              <ChoiceChips<CardAmountSign | ''> options={AMOUNT_SIGNS} value={amountSign ?? ''} onChange={(value) => setAmountSign(value || null)} />
            </Group>
          ) : null}

          {inspected && inspected.sample.length > 0 ? (
            <Group label="Amostra das primeiras linhas">
              <Text style={styles.sampleHeader}>{inspected.columns.map((column) => column.label).join(' · ')}</Text>
              {inspected.sample.map((row) => (
                <Text key={row.lineNumber} style={listStyles.detail}>
                  Linha {row.lineNumber}: {inspected.columns.map((column) => row.values[column.index] || '—').join(' · ')}
                </Text>
              ))}
            </Group>
          ) : null}

          <TextField label="Nome do modelo" value={name} onChangeText={setName} maxLength={80} placeholder="Ex.: Extrato Banco X" />
          {selectedId && !dirty
            ? <Text style={listStyles.detail}>Modelo salvo nesta carteira.</Text>
            : <LinkButton label={selectedId ? 'Atualizar modelo' : 'Salvar novo modelo'} onPress={saveMapping} />}
        </>
      ) : null}

      <PrimaryButton label="Enviar CSV" onPress={send} busy={busy || inspecting} />
      <LinkButton label="Cancelar importação do CSV" onPress={onCancel} />
    </View>
  )
}

const styles = StyleSheet.create({
  group: { gap: spacing.xs },
  label: { fontSize: typography.caption, color: colors.textMuted },
  warning: { fontSize: typography.caption, color: colors.danger },
  sampleHeader: { fontSize: typography.caption, fontWeight: '600', color: colors.text },
})
