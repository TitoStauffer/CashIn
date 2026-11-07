import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ChangeEvent, FormEvent } from 'react'
import type { Category } from '../categories/categoriesApi'
import { categoriesApi } from '../categories/categoriesApi'
import { getApiErrorFeedback } from '../feedback/apiErrorFeedback'
import { FinancialSidebar } from '../layout/FinancialSidebar'
import { useWallet } from '../wallets/useWallet'
import type { CreditCard } from '../creditCards/creditCardsApi'
import { creditCardsApi } from '../creditCards/creditCardsApi'
import type {
  CardAmountSign,
  CsvColumnMapping,
  CsvImportConfiguration,
  CsvMappingTemplate,
  FinancialImportFormat,
  FinancialImportItem,
  FinancialImportItemInput,
  FinancialImportKind,
  FinancialImportSession,
  FinancialCategorizationRule,
  FinancialCategorizationRuleInput,
} from './importsApi'
import { importsApi } from './importsApi'
import { CsvConfigurationPanel } from './CsvConfigurationPanel'
import { ImportPreview } from './ImportPreview'
import {
  isCsvConfigurationValid,
  maxAutomaticPollFailures,
  isImportBusy,
  getSessionStatusLabel,
  typeLabels,
  canReconcileStatement,
  isCardSession,
  hasCategory,
  formatFileSize,
  createDraft,
  hasDraftChanged,
} from './importsModel'
import './FinancialImportsPage.css'

type FinancialImportsPageProps = {
  userEmail: string
  isLoggingOut: boolean
  onLogout: () => void
}

type WalletOperation = {
  walletId: string | null
  generation: number
}

type CsvInspectionOptions = {
  configuration?: CsvImportConfiguration
  columns?: CsvColumnMapping
  resetModel?: boolean
  rememberDetected?: boolean
}

const maxFileSize = 10 * 1024 * 1024

function createDefaultCsvConfiguration(): CsvImportConfiguration {
  return {
    delimiter: ',',
    encoding: 'utf-8',
    hasHeader: true,
    dateFormat: 'dd/MM/yyyy',
    numberFormat: 'pt-BR',
    columns: { date: 0, description: null, amount: null, credit: null, debit: null, externalId: null },
  }
}

type RuleDraft = FinancialCategorizationRuleInput & { id: string | null }

const emptyRuleDraft: RuleDraft = { id: null, type: 'expense', description: '', categoryId: '', subcategoryId: null, isActive: true }

// A rule may only be learned from a saved, manually categorized income or expense.
function getFileFormat(fileName: string): FinancialImportFormat | null {
  const extension = fileName.split('.').pop()?.toLowerCase()
  return extension === 'ofx' || extension === 'csv' ? extension : null
}

function formatDateTime(value: string | null | undefined) {
  if (!value) return '—'
  return new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(value))
}

function getImportError(error: unknown, fallback: string) {
  return getApiErrorFeedback(error, fallback, {
    409: 'A importação mudou enquanto esta ação era executada. Atualize os dados e tente novamente.',
    413: 'O arquivo ultrapassa o limite de 10 MB.',
    415: 'Use um arquivo OFX ou CSV válido.',
    422: 'O arquivo não pôde ser processado. Confira o formato e tente novamente.',
  })
}

function getRuleError(error: unknown, fallback: string) {
  return getApiErrorFeedback(error, fallback, {
    409: 'Já existe uma regra para esta descrição e tipo nesta carteira.',
  })
}

function replaceSessionItem(session: FinancialImportSession, updated: FinancialImportItem): FinancialImportSession {
  const items = (session.items ?? []).map((item) => item.id === updated.id ? updated : item)
  return {
    ...session,
    items,
    summary: {
      total: items.length,
      valid: items.filter((item) => item.validationStatus === 'valid').length,
      duplicate: items.filter((item) => item.validationStatus === 'duplicate').length,
      invalid: items.filter((item) => item.validationStatus === 'invalid').length,
      uncategorized: items.filter((item) => item.validationStatus === 'uncategorized').length,
      imported: items.filter((item) => item.validationStatus === 'imported').length,
    },
  }
}

export function FinancialImportsPage(props: FinancialImportsPageProps) {
  const { activeWalletId } = useWallet()
  return <FinancialImportsWalletPage key={String(activeWalletId)} {...props} />
}

function FinancialImportsWalletPage({ userEmail, isLoggingOut, onLogout }: FinancialImportsPageProps) {
  const { activeWalletId, activeWallet } = useWallet()
  const fileInputRef = useRef<HTMLInputElement>(null)
  const csvInspectionControllerRef = useRef<AbortController | null>(null)
  const activeWalletIdRef = useRef(activeWalletId)
  const walletGenerationRef = useRef(0)
  const [history, setHistory] = useState<FinancialImportSession[]>([])
  const [selectedImport, setSelectedImport] = useState<FinancialImportSession | null>(null)
  const [drafts, setDrafts] = useState<Record<string, FinancialImportItemInput>>({})
  const [incomeCategories, setIncomeCategories] = useState<Category[]>([])
  const [expenseCategories, setExpenseCategories] = useState<Category[]>([])
  const [selectedFile, setSelectedFile] = useState<File | null>(null)
  const [csvConfiguration, setCsvConfiguration] = useState<CsvImportConfiguration | null>(null)
  const [detectedCsvConfiguration, setDetectedCsvConfiguration] = useState<CsvImportConfiguration | null>(null)
  const [csvColumns, setCsvColumns] = useState<Array<{ index: number; label: string }>>([])
  const [csvSample, setCsvSample] = useState<Array<{ lineNumber: number; values: string[] }>>([])
  const [csvMappings, setCsvMappings] = useState<CsvMappingTemplate[]>([])
  const [categorizationRules, setCategorizationRules] = useState<FinancialCategorizationRule[]>([])
  const [isRulesOpen, setIsRulesOpen] = useState(false)
  const [isRulesLoading, setIsRulesLoading] = useState(false)
  const [areRulesLoaded, setAreRulesLoaded] = useState(false)
  const [ruleDraft, setRuleDraft] = useState<RuleDraft>(emptyRuleDraft)
  const [selectedCsvMappingId, setSelectedCsvMappingId] = useState('')
  const [csvMappingName, setCsvMappingName] = useState('')
  const [isCsvMappingDirty, setIsCsvMappingDirty] = useState(false)
  const [loadedWalletId, setLoadedWalletId] = useState<string | null>(null)
  const [pendingAction, setPendingAction] = useState<string | null>(null)
  const [loadError, setLoadError] = useState('')
  const [formError, setFormError] = useState('')
  const [successMessage, setSuccessMessage] = useState('')
  const [reloadKey, setReloadKey] = useState(0)
  const [importKind, setImportKind] = useState<FinancialImportKind>('bank_statement')
  const [creditCards, setCreditCards] = useState<CreditCard[]>([])
  const [areCreditCardsLoading, setAreCreditCardsLoading] = useState(false)
  const [creditCardsError, setCreditCardsError] = useState('')
  const [selectedCreditCardId, setSelectedCreditCardId] = useState('')
  const [cardAmountSign, setCardAmountSign] = useState<CardAmountSign | ''>('')
  const [pollFailureCount, setPollFailureCount] = useState(0)
  const [isPollingPaused, setIsPollingPaused] = useState(false)

  useLayoutEffect(() => {
    activeWalletIdRef.current = activeWalletId
    walletGenerationRef.current += 1
  }, [activeWalletId])

  function captureWalletOperation(): WalletOperation {
    return { walletId: activeWalletIdRef.current, generation: walletGenerationRef.current }
  }

  function isCurrentWalletOperation(operation: WalletOperation) {
    return activeWalletIdRef.current === operation.walletId && walletGenerationRef.current === operation.generation
  }

  useEffect(() => {
    const controller = new AbortController()
    const operation = captureWalletOperation()

    Promise.all([
      importsApi.list(controller.signal),
      importsApi.listCsvMappings(controller.signal),
      categoriesApi.list('income', controller.signal),
      categoriesApi.list('expense', controller.signal),
    ])
      .then(([imports, mappings, incomes, expenses]) => {
        if (controller.signal.aborted || !isCurrentWalletOperation(operation)) return
        setHistory(imports.items)
        setCsvMappings(mappings.items)
        setIncomeCategories(incomes.items)
        setExpenseCategories(expenses.items)
        setLoadError('')
        setFormError('')
        setSuccessMessage('')
        setSelectedImport(null)
        setDrafts({})
        setSelectedFile(null)
        setImportKind('bank_statement')
        setCreditCards([])
        setCreditCardsError('')
        setSelectedCreditCardId('')
        setCardAmountSign('')
        setCsvConfiguration(null)
        setDetectedCsvConfiguration(null)
        setCsvColumns([])
        setCsvSample([])
        setSelectedCsvMappingId('')
        setCsvMappingName('')
        setIsCsvMappingDirty(false)
        setPendingAction(null)
        if (fileInputRef.current) fileInputRef.current.value = ''
      })
      .catch((error: unknown) => {
        if ((error instanceof Error && error.name === 'AbortError') || !isCurrentWalletOperation(operation)) return
        setLoadError(getImportError(error, 'Não foi possível carregar o histórico de importações.'))
      })
      .finally(() => {
        if (!controller.signal.aborted && isCurrentWalletOperation(operation)) setLoadedWalletId(operation.walletId)
      })

    return () => controller.abort()
  }, [activeWalletId, reloadKey])

  useEffect(() => {
    if (!selectedImport || !isImportBusy(selectedImport.status) || loadedWalletId !== activeWalletId || isPollingPaused) return
    const controller = new AbortController()
    const operation = captureWalletOperation()
    const pollDelay = 1500 * (2 ** Math.min(pollFailureCount, 3))
    const timer = window.setTimeout(() => {
      importsApi.get(selectedImport.id, controller.signal)
        .then((session) => {
          if (controller.signal.aborted || !isCurrentWalletOperation(operation)) return
          setPollFailureCount(0)
          setIsPollingPaused(false)
          setFormError('')
          setSelectedImport(session)
          setDrafts(Object.fromEntries((session.items ?? []).map((item) => [item.id, createDraft(item)])))
          if (session.status !== 'processing') {
            setHistory((current) => current.map((item) => item.id === session.id ? session : item))
          }
          if (selectedImport.status === 'confirming' && session.status === 'completed') {
            setSuccessMessage(`${session.summary.imported} movimentações foram importadas com segurança.`)
          }
        })
        .catch((error: unknown) => {
          if ((error instanceof Error && error.name === 'AbortError') || !isCurrentWalletOperation(operation)) return
          const nextFailureCount = pollFailureCount + 1
          setPollFailureCount(nextFailureCount)
          if (nextFailureCount >= maxAutomaticPollFailures) {
            setIsPollingPaused(true)
            setFormError(getImportError(error, 'Não foi possível atualizar o processamento após novas tentativas.'))
          }
        })
    }, pollDelay)
    return () => {
      controller.abort()
      window.clearTimeout(timer)
    }
  }, [activeWalletId, isPollingPaused, loadedWalletId, pollFailureCount, selectedImport])

  const confirmableCount = useMemo(
    () => (selectedImport?.items ?? []).filter((item) => item.validationStatus === 'valid').length,
    [selectedImport?.items],
  )
  const hasPendingDraftChanges = useMemo(
    () => (selectedImport?.items ?? []).some((item) => hasDraftChanged(item, drafts[item.id])),
    [drafts, selectedImport?.items],
  )
  const isLoading = loadedWalletId !== activeWalletId
  const isSelectedImportBusy = selectedImport ? isImportBusy(selectedImport.status) : false

  useEffect(() => () => csvInspectionControllerRef.current?.abort(), [])

  function clearCsvSetup() {
    csvInspectionControllerRef.current?.abort()
    csvInspectionControllerRef.current = null
    setPendingAction((current) => current === 'inspect-csv' ? null : current)
    setCsvConfiguration(null)
    setDetectedCsvConfiguration(null)
    setCsvColumns([])
    setCsvSample([])
    setSelectedCsvMappingId('')
    setCsvMappingName('')
    setIsCsvMappingDirty(false)
  }

  function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    setFormError('')
    setSuccessMessage('')
    const file = event.target.files?.[0] ?? null
    if (!file) {
      setSelectedFile(null)
      clearCsvSetup()
      return
    }
    if (!getFileFormat(file.name)) {
      setSelectedFile(null)
      clearCsvSetup()
      event.target.value = ''
      setFormError('Selecione um arquivo com extensão .ofx ou .csv.')
      return
    }
    if (file.size > maxFileSize) {
      setSelectedFile(null)
      clearCsvSetup()
      event.target.value = ''
      setFormError('O arquivo ultrapassa o limite de 10 MB.')
      return
    }
    setSelectedFile(file)
    if (getFileFormat(file.name) === 'csv') void inspectCsv(file, { rememberDetected: true })
    else clearCsvSetup()
  }

  async function inspectCsv(file: File, options: CsvInspectionOptions = {}) {
    csvInspectionControllerRef.current?.abort()
    const controller = new AbortController()
    csvInspectionControllerRef.current = controller
    const operation = captureWalletOperation()
    setPendingAction('inspect-csv')
    setFormError('')
    setCsvColumns([])
    setCsvSample([])
    try {
      const inspection = options.configuration
        ? await importsApi.inspectCsv(file, controller.signal, options.configuration)
        : await importsApi.inspectCsv(file, controller.signal)
      if (controller.signal.aborted || !isCurrentWalletOperation(operation)) return
      const inspectedConfiguration = {
        ...inspection.detectedConfiguration,
        columns: options.columns ?? inspection.suggestedMapping,
      }
      setCsvConfiguration(inspectedConfiguration)
      if (options.rememberDetected) setDetectedCsvConfiguration(inspectedConfiguration)
      setCsvColumns(inspection.columns)
      setCsvSample(inspection.sample)
      if (options.resetModel !== false) {
        setSelectedCsvMappingId('')
        setCsvMappingName('')
        setIsCsvMappingDirty(false)
      }
    } catch (error) {
      if (controller.signal.aborted || !isCurrentWalletOperation(operation)) return
      if (!options.configuration) setCsvConfiguration(createDefaultCsvConfiguration())
      if (options.rememberDetected) setDetectedCsvConfiguration(null)
      setCsvColumns([])
      setCsvSample([])
      setFormError(getImportError(error, 'Não foi possível analisar o CSV. Confira o arquivo e tente novamente.'))
    } finally {
      if (!controller.signal.aborted && isCurrentWalletOperation(operation)) setPendingAction(null)
      if (csvInspectionControllerRef.current === controller) csvInspectionControllerRef.current = null
    }
  }

  function retryCsvInspection() {
    if (!selectedFile || !csvConfiguration) return
    void inspectCsv(selectedFile, {
      configuration: csvConfiguration,
      columns: selectedCsvMappingId ? csvConfiguration.columns : undefined,
      resetModel: false,
    })
  }

  function updateCsvConfiguration(changes: Partial<CsvImportConfiguration>, preserveColumns: boolean) {
    if (!csvConfiguration || !selectedFile) return
    const nextConfiguration = { ...csvConfiguration, ...changes }
    setCsvConfiguration(nextConfiguration)
    setIsCsvMappingDirty(Boolean(selectedCsvMappingId))
    void inspectCsv(selectedFile, {
      configuration: nextConfiguration,
      columns: preserveColumns ? nextConfiguration.columns : undefined,
      resetModel: false,
    })
  }

  function updateCsvColumnMapping(field: keyof CsvImportConfiguration['columns'], value: string) {
    setCsvConfiguration((current) => current ? {
      ...current,
      columns: { ...current.columns, [field]: value === '' ? null : Number(value) },
    } : current)
    setIsCsvMappingDirty(Boolean(selectedCsvMappingId))
  }

  function selectCsvMapping(mappingId: string) {
    setSelectedCsvMappingId(mappingId)
    const mapping = csvMappings.find((item) => item.id === mappingId)
    if (!mapping) {
      setCsvMappingName('')
      setIsCsvMappingDirty(false)
      if (detectedCsvConfiguration && selectedFile) {
        setCsvConfiguration(detectedCsvConfiguration)
        void inspectCsv(selectedFile, {
          configuration: detectedCsvConfiguration,
          columns: detectedCsvConfiguration.columns,
          resetModel: false,
        })
      }
      return
    }
    setCsvMappingName(mapping.name)
    setCsvConfiguration(mapping.configuration)
    setIsCsvMappingDirty(false)
    if (selectedFile) {
      void inspectCsv(selectedFile, {
        configuration: mapping.configuration,
        columns: mapping.configuration.columns,
        resetModel: false,
      })
    }
  }

  async function saveCsvMapping() {
    if (!csvConfiguration || !csvMappingName.trim()) {
      setFormError('Informe um nome para salvar este modelo de CSV.')
      return
    }
    const operation = captureWalletOperation()
    setPendingAction('save-csv-mapping')
    setFormError('')
    try {
      const mapping = selectedCsvMappingId
        ? await importsApi.updateCsvMapping(selectedCsvMappingId, csvMappingName.trim(), csvConfiguration)
        : await importsApi.createCsvMapping(csvMappingName.trim(), csvConfiguration)
      if (!isCurrentWalletOperation(operation)) return
      setCsvMappings((current) => [mapping, ...current.filter((item) => item.id !== mapping.id)])
      setSelectedCsvMappingId(mapping.id)
      setCsvMappingName(mapping.name)
      setCsvConfiguration(mapping.configuration)
      setIsCsvMappingDirty(false)
      setSuccessMessage(`Modelo “${mapping.name}” salvo para esta carteira.`)
    } catch (error) {
      if (!isCurrentWalletOperation(operation)) return
      setFormError(getImportError(error, 'Não foi possível salvar o modelo de CSV.'))
    } finally {
      if (isCurrentWalletOperation(operation)) setPendingAction(null)
    }
  }

  // Cards are loaded only when a card statement import is chosen, scoped to the active wallet.
  async function selectImportKind(kind: FinancialImportKind) {
    setImportKind(kind)
    setFormError('')
    if (kind !== 'credit_card_statement' || creditCards.length > 0) return
    const operation = captureWalletOperation()
    setAreCreditCardsLoading(true)
    setCreditCardsError('')
    try {
      const result = await creditCardsApi.list()
      if (!isCurrentWalletOperation(operation)) return
      setCreditCards(result.items.filter((card) => card.isActive))
    } catch {
      if (!isCurrentWalletOperation(operation)) return
      setCreditCardsError('Não foi possível carregar os cartões desta carteira. Tente novamente.')
      setFormError('Não foi possível carregar os cartões desta carteira. Tente novamente.')
    } finally {
      if (isCurrentWalletOperation(operation)) setAreCreditCardsLoading(false)
    }
  }

  async function handleUpload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (loadError || isSelectedImportBusy) return
    if (!selectedFile) {
      setFormError('Selecione um arquivo OFX ou CSV para continuar.')
      return
    }
    const format = getFileFormat(selectedFile.name)
    if (!format) return
    if (format === 'csv' && !isCsvConfigurationValid(csvConfiguration, csvColumns)) {
      setFormError('Mapeie a data e o valor — ou as colunas de crédito e débito — para continuar.')
      return
    }
    const isCardImport = importKind === 'credit_card_statement'
    if (isCardImport && !selectedCreditCardId) {
      setFormError('Selecione o cartão da fatura antes de enviar o arquivo.')
      return
    }
    if (isCardImport && format === 'csv' && !cardAmountSign) {
      setFormError('Informe como o CSV da fatura representa as compras.')
      return
    }

    const operation = captureWalletOperation()
    setPendingAction('upload')
    setFormError('')
    setSuccessMessage('')
    try {
      const csvMapping = format === 'csv' && csvConfiguration
        ? selectedCsvMappingId && !isCsvMappingDirty
          ? { mappingId: selectedCsvMappingId } as const
          : { configuration: csvConfiguration } as const
        : undefined
      const card = isCardImport
        ? { creditCardId: selectedCreditCardId, ...(format === 'csv' && cardAmountSign ? { amountSign: cardAmountSign } : {}) }
        : undefined
      const session = card
        ? await importsApi.upload(selectedFile, format, csvMapping, card)
        : csvMapping
          ? await importsApi.upload(selectedFile, format, csvMapping)
          : await importsApi.upload(selectedFile, format)
      if (!isCurrentWalletOperation(operation)) return
      setSelectedImport(session)
      setPollFailureCount(0)
      setIsPollingPaused(false)
      setDrafts(Object.fromEntries((session.items ?? []).map((item) => [item.id, createDraft(item)])))
      setHistory((current) => [session, ...current.filter((item) => item.id !== session.id)])
      setSelectedFile(null)
      clearCsvSetup()
      if (fileInputRef.current) fileInputRef.current.value = ''
      setSuccessMessage('Arquivo recebido. Acompanhe o processamento e revise a prévia antes de confirmar.')
    } catch (error) {
      if (!isCurrentWalletOperation(operation)) return
      setFormError(getImportError(error, 'Não foi possível enviar o arquivo. Tente novamente.'))
    } finally {
      if (isCurrentWalletOperation(operation)) setPendingAction(null)
    }
  }

  async function openImport(importId: string) {
    const operation = captureWalletOperation()
    setPendingAction(`open:${importId}`)
    setFormError('')
    setSuccessMessage('')
    setPollFailureCount(0)
    setIsPollingPaused(false)
    try {
      const session = await importsApi.get(importId)
      if (!isCurrentWalletOperation(operation)) return
      setSelectedImport(session)
      setDrafts(Object.fromEntries((session.items ?? []).map((item) => [item.id, createDraft(item)])))
    } catch (error) {
      if (!isCurrentWalletOperation(operation)) return
      setFormError(getImportError(error, 'Não foi possível abrir esta importação.'))
    } finally {
      if (isCurrentWalletOperation(operation)) setPendingAction(null)
    }
  }

  function updateDraft(itemId: string, changes: Partial<FinancialImportItemInput>) {
    setDrafts((current) => ({
      ...current,
      [itemId]: { ...current[itemId], ...changes },
    }))
  }

  async function saveItem(item: FinancialImportItem, includeDuplicate = false) {
    const draft = drafts[item.id]
    if (!draft?.date) {
      setFormError('Informe a data da movimentação antes de salvar.')
      return
    }
    const operation = captureWalletOperation()
    setPendingAction(`item:${item.id}`)
    setFormError('')
    setSuccessMessage('')
    try {
      const isCardItem = isCardSession(selectedImport!)
      const canReconcilePayment = canReconcileStatement(selectedImport!, draft.type)
      const { statementClosingDate, creditCardStatementId, transferCounterpartWalletId, walletTransferId, ...itemDraft } = draft
      const updated = await importsApi.updateItem(selectedImport!.id, item.id, {
        ...itemDraft,
        description: draft.description.trim(),
        categoryId: hasCategory(draft.type) ? draft.categoryId : null,
        subcategoryId: hasCategory(draft.type) ? draft.subcategoryId : null,
        ...(isCardItem ? { statementClosingDate: statementClosingDate ?? null } : {}),
        // The fields are only accepted on a bank statement import, and only a transfer may carry
        // them. A transfer settles a statement or mirrors another wallet, never both, so the pair not
        // chosen is sent as null.
        ...(isCardItem ? {} : {
          creditCardStatementId: canReconcilePayment ? creditCardStatementId ?? null : null,
          transferCounterpartWalletId: canReconcilePayment ? transferCounterpartWalletId ?? null : null,
          walletTransferId: canReconcilePayment ? walletTransferId ?? null : null,
        }),
        ...(includeDuplicate ? { includeDuplicate: true } : {}),
      })
      if (!isCurrentWalletOperation(operation)) return
      // The item is already persisted here, so a failed reload must not be reported as a failed save.
      setSelectedImport((current) => current ? replaceSessionItem(current, updated) : current)
      setDrafts((current) => ({ ...current, [updated.id]: createDraft(updated) }))
      setSuccessMessage(`Movimentação ${item.sequence} atualizada na prévia.`)
      // A reconciled payment needs the session again too: the item response carries no candidate
      // list, and a type changed into a transfer has none loaded yet.
      if (!isCardItem && !canReconcilePayment) return
      // Statement totals and candidates are computed by the API; reload the session so they reflect
      // the change.
      try {
        const refreshed = await importsApi.get(selectedImport!.id)
        if (!isCurrentWalletOperation(operation)) return
        setSelectedImport(refreshed)
        // Only the saved item is refreshed from the server; unsaved edits to the other items stay.
        setDrafts((current) => Object.fromEntries((refreshed.items ?? []).map((reloaded) => [
          reloaded.id,
          reloaded.id === updated.id ? createDraft(reloaded) : current[reloaded.id] ?? createDraft(reloaded),
        ])))
      } catch {
        if (!isCurrentWalletOperation(operation)) return
        setFormError(`A movimentação ${item.sequence} foi salva, mas os dados das faturas não puderam ser atualizados. Recarregue a importação.`)
      }
    } catch (error) {
      if (!isCurrentWalletOperation(operation)) return
      setFormError(getImportError(error, 'Não foi possível atualizar a movimentação.'))
    } finally {
      if (isCurrentWalletOperation(operation)) setPendingAction(null)
    }
  }

  async function toggleRules() {
    const nextOpen = !isRulesOpen
    setIsRulesOpen(nextOpen)
    if (!nextOpen || areRulesLoaded) return
    const operation = captureWalletOperation()
    setIsRulesLoading(true)
    setFormError('')
    try {
      const result = await importsApi.listCategorizationRules()
      if (isCurrentWalletOperation(operation)) {
        setCategorizationRules(result.items)
        setAreRulesLoaded(true)
      }
    } catch (error) {
      if (isCurrentWalletOperation(operation)) setFormError(getRuleError(error, 'Não foi possível carregar as regras da carteira.'))
    } finally {
      if (isCurrentWalletOperation(operation)) setIsRulesLoading(false)
    }
  }

  async function saveCategorizationRule(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const { id, ...input } = ruleDraft
    if (!input.categoryId || !input.description.trim()) {
      setFormError('Informe uma descrição e uma categoria para a regra.')
      return
    }
    const operation = captureWalletOperation()
    setPendingAction('categorization-rule')
    setFormError('')
    try {
      const saved = id
        ? await importsApi.updateCategorizationRule(id, { ...input, description: input.description.trim() })
        : await importsApi.createCategorizationRule({ ...input, description: input.description.trim() })
      if (!isCurrentWalletOperation(operation)) return
      setCategorizationRules((current) => [saved, ...current.filter((rule) => rule.id !== saved.id)])
      setRuleDraft(emptyRuleDraft)
      setSuccessMessage(id ? 'Regra atualizada.' : 'Regra criada. Ela será aplicada às próximas importações desta carteira.')
    } catch (error) {
      if (isCurrentWalletOperation(operation)) setFormError(getRuleError(error, 'Não foi possível salvar a regra.'))
    } finally {
      if (isCurrentWalletOperation(operation)) setPendingAction(null)
    }
  }

  async function deleteCategorizationRule(rule: FinancialCategorizationRule) {
    if (!window.confirm(`Excluir a regra para “${rule.description}”?`)) return
    const operation = captureWalletOperation()
    setPendingAction(`delete-rule:${rule.id}`)
    setFormError('')
    try {
      await importsApi.deleteCategorizationRule(rule.id)
      if (isCurrentWalletOperation(operation)) {
        setCategorizationRules((current) => current.filter((item) => item.id !== rule.id))
        setSuccessMessage('Regra excluída.')
      }
    } catch (error) {
      if (isCurrentWalletOperation(operation)) setFormError(getRuleError(error, 'Não foi possível excluir a regra.'))
    } finally {
      if (isCurrentWalletOperation(operation)) setPendingAction(null)
    }
  }

  async function createRuleFromItem(item: FinancialImportItem) {
    if (item.type === 'transfer' || item.type === 'card_credit' || !item.categoryId) return
    const description = item.description?.trim() ?? ''
    if (!description) {
      setFormError('Informe uma descrição na movimentação antes de criar uma regra.')
      return
    }
    const category = (item.type === 'income' ? incomeCategories : expenseCategories).find((current) => current.id === item.categoryId)
    const subcategory = category?.subcategories.find((current) => current.id === item.subcategoryId)
    const target = [category?.name ?? 'a categoria escolhida', subcategory?.name].filter(Boolean).join(' / ')
    if (!window.confirm(`Criar uma regra para classificar ${typeLabels[item.type].toLowerCase()}s com a descrição “${description}” como ${target} nas próximas importações desta carteira?`)) return
    const operation = captureWalletOperation()
    setPendingAction(`rule-from-item:${item.id}`)
    setFormError('')
    setSuccessMessage('')
    try {
      const saved = await importsApi.createCategorizationRule({
        type: item.type,
        description,
        categoryId: item.categoryId,
        subcategoryId: item.subcategoryId,
      })
      if (!isCurrentWalletOperation(operation)) return
      if (areRulesLoaded) setCategorizationRules((current) => [saved, ...current.filter((rule) => rule.id !== saved.id)])
      setSuccessMessage('Regra criada. Ela será aplicada às próximas importações desta carteira.')
    } catch (error) {
      if (isCurrentWalletOperation(operation)) setFormError(getRuleError(error, 'Não foi possível criar a regra.'))
    } finally {
      if (isCurrentWalletOperation(operation)) setPendingAction(null)
    }
  }

  async function confirmImport() {
    if (!selectedImport || confirmableCount === 0 || hasPendingDraftChanges) return
    if (!window.confirm(`Confirmar ${confirmableCount} ${confirmableCount === 1 ? 'movimentação válida' : 'movimentações válidas'} desta importação?`)) return
    const operation = captureWalletOperation()
    setPendingAction('confirm')
    setFormError('')
    setSuccessMessage('')
    try {
      const session = await importsApi.confirm(selectedImport.id)
      if (!isCurrentWalletOperation(operation)) return
      setSelectedImport(session)
      setDrafts(Object.fromEntries((session.items ?? []).map((item) => [item.id, createDraft(item)])))
      setHistory((current) => current.map((item) => item.id === session.id ? session : item))
      setSuccessMessage(session.status === 'confirming'
        ? 'Confirmação iniciada. Aguarde a conclusão antes de continuar.'
        : session.status === 'preview' && session.summary.duplicate > 0
          ? `A validação encontrou ${session.summary.duplicate} duplicidade(s). A prévia foi atualizada para revisão; nada desta tentativa foi importado.`
        : `${session.summary.imported} movimentações foram importadas com segurança.`)
    } catch (error) {
      if (!isCurrentWalletOperation(operation)) return
      setFormError(getImportError(error, 'Não foi possível confirmar a importação. Nenhuma movimentação foi gravada parcialmente.'))
    } finally {
      if (isCurrentWalletOperation(operation)) setPendingAction(null)
    }
  }

  async function undoImport(session: FinancialImportSession) {
    if (!window.confirm(`Desfazer a importação do arquivo ${session.fileName}?`)) return
    const operation = captureWalletOperation()
    setPendingAction(`undo:${session.id}`)
    setFormError('')
    setSuccessMessage('')
    try {
      const undone = await importsApi.undo(session.id)
      if (!isCurrentWalletOperation(operation)) return
      setHistory((current) => current.map((item) => item.id === undone.id ? undone : item))
      if (selectedImport?.id === undone.id) {
        setSelectedImport(undone)
        setDrafts(Object.fromEntries((undone.items ?? []).map((item) => [item.id, createDraft(item)])))
      }
      setSuccessMessage('Importação desfeita. As movimentações criadas por ela foram removidas.')
    } catch (error) {
      if (!isCurrentWalletOperation(operation)) return
      setFormError(getImportError(error, 'Não foi possível desfazer a importação. Verifique se alguma movimentação já foi alterada.'))
    } finally {
      if (isCurrentWalletOperation(operation)) setPendingAction(null)
    }
  }

  async function discardImport(session: FinancialImportSession) {
    if (!window.confirm(`Descartar a prévia do arquivo ${session.fileName}? Os lançamentos ainda não foram criados.`)) return
    const operation = captureWalletOperation()
    setPendingAction(`discard:${session.id}`)
    setFormError('')
    setSuccessMessage('')
    try {
      const discarded = await importsApi.discard(session.id)
      if (!isCurrentWalletOperation(operation)) return
      setSelectedImport(discarded)
      setDrafts(Object.fromEntries((discarded.items ?? []).map((item) => [item.id, createDraft(item)])))
      setHistory((current) => current.map((item) => item.id === discarded.id ? discarded : item))
      setSuccessMessage('Prévia descartada. Nenhuma movimentação foi criada.')
    } catch (error) {
      if (!isCurrentWalletOperation(operation)) return
      setFormError(getImportError(error, 'Não foi possível descartar a prévia.'))
    } finally {
      if (isCurrentWalletOperation(operation)) setPendingAction(null)
    }
  }

  function retryLoad() {
    setLoadedWalletId(null)
    setLoadError('')
    setReloadKey((current) => current + 1)
  }

  function retryPolling() {
    setFormError('')
    setPollFailureCount(0)
    setIsPollingPaused(false)
  }

  return (
    <>
      <FinancialSidebar activePage="imports" userEmail={userEmail} isLoggingOut={isLoggingOut} onLogout={onLogout} />
      <main className="imports-page">
        <div className="imports-shell">
          <section className="imports-content" aria-labelledby="imports-title">
            <header className="imports-heading">
              <div>
                <p className="imports-eyebrow">MOVIMENTAÇÕES</p>
                <h1 id="imports-title">Importar arquivo financeiro</h1>
                <p>Envie um extrato ou fatura, revise a prévia e só então confirme os lançamentos.</p>
              </div>
              <span className="imports-wallet">Carteira: <strong>{activeWallet?.name}</strong></span>
            </header>

            <section className="imports-rules" aria-labelledby="imports-rules-title">
              <div className="imports-section-heading">
                <div>
                  <p className="imports-eyebrow">CLASSIFICAÇÃO EXPLÍCITA</p>
                  <h2 id="imports-rules-title">Regras por carteira</h2>
                  <p>As regras usam a descrição normalizada e o tipo. Só são criadas ou alteradas quando você confirma.</p>
                </div>
                <button className="imports-secondary-button" type="button" onClick={() => void toggleRules()} disabled={pendingAction !== null}>
                  {isRulesOpen ? 'Ocultar regras' : 'Gerenciar regras'}
                </button>
              </div>
              {isRulesOpen && (
                <div className="imports-rules__content">
                  {isRulesLoading ? <p role="status">Carregando regras…</p> : (
                    <ul className="imports-rules__list">
                      {categorizationRules.map((rule) => (
                        <li key={rule.id}>
                          <div>
                            <strong>{rule.description}</strong>
                            <span>{rule.type === 'income' ? 'Entrada' : 'Saída'} · {rule.categoryName ?? 'Categoria removida'}{rule.subcategoryId ? ` / ${rule.subcategoryName ?? 'subcategoria removida'}` : ''}</span>
                            {rule.isStale && <small role="status">Categoria removida. Edite a regra para voltar a classificar movimentações.</small>}
                            {!rule.isActive && <small>Regra desativada</small>}
                          </div>
                          <div className="imports-rules__actions">
                            <button className="imports-text-button" type="button" onClick={() => setRuleDraft({ id: rule.id, type: rule.type, description: rule.description, categoryId: rule.categoryId, subcategoryId: rule.subcategoryId, isActive: rule.isActive })}>Editar</button>
                            <button className="imports-text-button" type="button" disabled={pendingAction !== null} onClick={() => void deleteCategorizationRule(rule)}>Excluir</button>
                          </div>
                        </li>
                      ))}
                      {categorizationRules.length === 0 && <li>Nenhuma regra cadastrada para esta carteira.</li>}
                    </ul>
                  )}
                  <form className="imports-rules__form" onSubmit={(event) => void saveCategorizationRule(event)}>
                    <h3>{ruleDraft.id ? 'Editar regra' : 'Criar regra'}</h3>
                    <label>Descrição exata da movimentação<input value={ruleDraft.description} maxLength={512} onChange={(event) => setRuleDraft((current) => ({ ...current, description: event.target.value }))} /></label>
                    <div className="imports-rules__fields">
                      <label>Tipo<select value={ruleDraft.type} onChange={(event) => setRuleDraft((current) => ({ ...current, type: event.target.value as 'income' | 'expense', categoryId: '', subcategoryId: null }))}><option value="income">Entrada</option><option value="expense">Saída</option></select></label>
                      <label>Categoria<select value={ruleDraft.categoryId} onChange={(event) => setRuleDraft((current) => ({ ...current, categoryId: event.target.value, subcategoryId: null }))}><option value="">Selecione</option>{(ruleDraft.type === 'income' ? incomeCategories : expenseCategories).map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}</select></label>
                      <label>Subcategoria<select value={ruleDraft.subcategoryId ?? ''} disabled={!ruleDraft.categoryId} onChange={(event) => setRuleDraft((current) => ({ ...current, subcategoryId: event.target.value || null }))}><option value="">Sem subcategoria</option>{(ruleDraft.type === 'income' ? incomeCategories : expenseCategories).find((category) => category.id === ruleDraft.categoryId)?.subcategories.map((subcategory) => <option key={subcategory.id} value={subcategory.id}>{subcategory.name}</option>)}</select></label>
                    </div>
                    <label className="imports-rules__active"><input type="checkbox" checked={ruleDraft.isActive ?? true} onChange={(event) => setRuleDraft((current) => ({ ...current, isActive: event.target.checked }))} /> Regra ativa</label>
                    <div className="imports-rules__actions">
                      <button className="imports-primary-button" type="submit" disabled={pendingAction !== null || isRulesLoading}>{pendingAction === 'categorization-rule' ? 'Salvando…' : ruleDraft.id ? 'Salvar alterações' : 'Confirmar e criar regra'}</button>
                      {ruleDraft.id && <button className="imports-text-button" type="button" onClick={() => setRuleDraft(emptyRuleDraft)}>Cancelar edição</button>}
                    </div>
                  </form>
                </div>
              )}
            </section>

            {formError && (
              <div className="imports-alert imports-alert--error" role="alert">
                <span>{formError}</span>
                {isPollingPaused && <button className="imports-text-button" type="button" onClick={retryPolling}>Tentar acompanhar novamente</button>}
              </div>
            )}
            {successMessage && <p className="imports-alert imports-alert--success" role="status">{successMessage}</p>}

            <form className="imports-upload" onSubmit={handleUpload}>
              <div>
                <h2>Novo arquivo</h2>
                <p>Formatos aceitos: OFX ou CSV. Limite de 10 MB e 10.000 movimentações.</p>
              </div>
              <fieldset className="imports-kind-field" disabled={pendingAction !== null || isLoading || Boolean(loadError) || isSelectedImportBusy}>
                <legend>Tipo de arquivo</legend>
                <label>
                  <input type="radio" name="financial-import-kind" value="bank_statement" checked={importKind === 'bank_statement'} onChange={() => void selectImportKind('bank_statement')} />
                  Extrato bancário
                </label>
                <label>
                  <input type="radio" name="financial-import-kind" value="credit_card_statement" checked={importKind === 'credit_card_statement'} onChange={() => void selectImportKind('credit_card_statement')} />
                  Fatura de cartão
                </label>
              </fieldset>
              {importKind === 'credit_card_statement' && (
                <div className="imports-card-fields">
                  <label>
                    <span>Cartão da fatura</span>
                    <select value={selectedCreditCardId} onChange={(event) => setSelectedCreditCardId(event.target.value)} disabled={pendingAction !== null || areCreditCardsLoading}>
                      <option value="">{areCreditCardsLoading ? 'Carregando cartões…' : 'Selecione o cartão'}</option>
                      {creditCards.map((card) => <option key={card.id} value={card.id}>{card.nickname}</option>)}
                    </select>
                  </label>
                  {!areCreditCardsLoading && creditCards.length === 0 && !creditCardsError && <small>Cadastre um cartão ativo nesta carteira para importar a fatura.</small>}
                  {selectedFile && getFileFormat(selectedFile.name) === 'csv' && (
                    <label>
                      <span>Como o CSV mostra as compras</span>
                      <select value={cardAmountSign} onChange={(event) => setCardAmountSign(event.target.value as CardAmountSign | '')} disabled={pendingAction !== null}>
                        <option value="">Selecione</option>
                        <option value="purchases_positive">Compras com valor positivo</option>
                        <option value="purchases_negative">Compras com valor negativo</option>
                      </select>
                    </label>
                  )}
                  <small>Compras entram na fatura pelo fechamento do cartão e não reduzem o saldo até o pagamento. Estornos e reembolsos abatem a fatura.</small>
                </div>
              )}
              <label className="imports-file-field" htmlFor="financial-import-file">
                <span>Arquivo OFX ou CSV</span>
                <input
                  ref={fileInputRef}
                  id="financial-import-file"
                  type="file"
                  aria-label="Arquivo OFX ou CSV"
                  accept=".ofx,.csv,application/x-ofx,text/csv"
                  onChange={handleFileChange}
                  disabled={pendingAction !== null || isLoading || Boolean(loadError) || isSelectedImportBusy}
                />
                <small>{selectedFile ? `${selectedFile.name} · ${formatFileSize(selectedFile.size)}` : 'O arquivo será processado temporariamente e não ficará armazenado.'}</small>
              </label>
              {selectedFile && getFileFormat(selectedFile.name) === 'csv' && pendingAction === 'inspect-csv' && (
                <p className="imports-csv-loading" role="status"><span className="imports-spinner" aria-hidden="true" />Analisando estrutura do CSV…</p>
              )}
              {selectedFile && getFileFormat(selectedFile.name) === 'csv' && csvConfiguration && (
                <CsvConfigurationPanel
                  configuration={csvConfiguration}
                  columns={csvColumns}
                  sample={csvSample}
                  mappings={csvMappings}
                  selectedMappingId={selectedCsvMappingId}
                  mappingName={csvMappingName}
                  mappingDirty={isCsvMappingDirty}
                  disabled={pendingAction !== null && pendingAction !== 'inspect-csv'}
                  inspecting={pendingAction === 'inspect-csv'}
                  onConfigurationChange={updateCsvConfiguration}
                  onColumnChange={updateCsvColumnMapping}
                  onMappingSelect={selectCsvMapping}
                  onMappingNameChange={(name) => {
                    setCsvMappingName(name)
                    setIsCsvMappingDirty(Boolean(selectedCsvMappingId))
                  }}
                  onSaveMapping={() => void saveCsvMapping()}
                  onRetryInspection={retryCsvInspection}
                />
              )}
              <button className="imports-primary-button" type="submit" disabled={!selectedFile || pendingAction !== null || isLoading || Boolean(loadError) || isSelectedImportBusy || (getFileFormat(selectedFile?.name ?? '') === 'csv' && !isCsvConfigurationValid(csvConfiguration, csvColumns)) || (importKind === 'credit_card_statement' && (!selectedCreditCardId || (getFileFormat(selectedFile?.name ?? '') === 'csv' && !cardAmountSign)))}>
                {pendingAction === 'upload' ? 'Enviando arquivo…' : 'Enviar e preparar prévia'}
              </button>
            </form>

            {loadError ? (
              <section className="imports-state-card" role="alert">
                <h2>Não foi possível carregar</h2>
                <p>{loadError}</p>
                <button className="imports-secondary-button" type="button" onClick={retryLoad}>Tentar novamente</button>
              </section>
            ) : isLoading ? (
              <p className="imports-loading" role="status"><span className="imports-spinner" aria-hidden="true" />Carregando importações…</p>
            ) : (
              <>
                {selectedImport && (
                  <ImportPreview
                    key={selectedImport.id}
                    session={selectedImport}
                    drafts={drafts}
                    incomeCategories={incomeCategories}
                    expenseCategories={expenseCategories}
                    pendingAction={pendingAction}
                    pollFailureCount={pollFailureCount}
                    isPollingPaused={isPollingPaused}
                    confirmableCount={confirmableCount}
                    hasPendingDraftChanges={hasPendingDraftChanges}
                    onDraftChange={updateDraft}
                    onSaveItem={(item, includeDuplicate) => void saveItem(item, includeDuplicate)}
                    onCreateRule={(item) => void createRuleFromItem(item)}
                    onConfirm={() => void confirmImport()}
                    onUndo={(session) => void undoImport(session)}
                    onDiscard={(session) => void discardImport(session)}
                  />
                )}

                <section className="imports-history" aria-labelledby="imports-history-title">
                  <div className="imports-section-heading">
                    <div>
                      <p className="imports-eyebrow">RASTREABILIDADE</p>
                      <h2 id="imports-history-title">Histórico da carteira</h2>
                    </div>
                    <span>{history.length} {history.length === 1 ? 'importação' : 'importações'}</span>
                  </div>
                  {history.length === 0 ? (
                    <div className="imports-state-card">
                      <h3>Nenhum arquivo importado</h3>
                      <p>O histórico mostrará cada processamento e seu resultado nesta carteira.</p>
                    </div>
                  ) : (
                    <ul className="imports-history-list">
                      {history.map((session) => (
                        <li key={session.id}>
                          <div className="imports-history-main">
                            <span className={`imports-status imports-status--${session.status}`}>{getSessionStatusLabel(session)}</span>
                            <div>
                              <h3>{session.fileName}</h3>
                              <p>{isCardSession(session) ? `Fatura · ${session.creditCardName ?? 'cartão'} · ` : ''}{session.format.toUpperCase()} · {formatFileSize(session.fileSize)} · iniciado em {formatDateTime(session.createdAt)}</p>
                            </div>
                          </div>
                          <div className="imports-history-summary">
                            <span>{session.summary.imported} importadas</span>
                            <span>{session.summary.duplicate} duplicadas</span>
                            <span>{session.summary.invalid} inválidas</span>
                            <span>{session.summary.uncategorized} sem categoria</span>
                          </div>
                          <div className="imports-history-actions">
                            <button className="imports-text-button" type="button" onClick={() => void openImport(session.id)} disabled={pendingAction !== null}>
                              {pendingAction === `open:${session.id}` ? 'Abrindo…' : 'Ver detalhes'}
                            </button>
                            {session.status === 'completed' && (
                              <button
                                className="imports-text-button imports-text-button--danger"
                                type="button"
                                onClick={() => void undoImport(session)}
                                disabled={pendingAction !== null || !session.canUndo}
                                title={!session.canUndo ? session.undoBlockedReason ?? 'Esta importação não pode mais ser desfeita.' : undefined}
                              >
                                {pendingAction === `undo:${session.id}` ? 'Desfazendo…' : 'Desfazer'}
                              </button>
                            )}
                          </div>
                          {session.status === 'failed' && session.failureMessage && (
                            <p className="imports-item-error">{session.failureMessage}</p>
                          )}
                          {session.status === 'completed' && !session.canUndo && session.undoBlockedReason && (
                            <p className="imports-undo-reason">{session.undoBlockedReason}</p>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                </section>
              </>
            )}
          </section>
          <footer className="imports-footer">
            <span>Saldo Certo · importação revisável e rastreável</span>
            <span>Carteira ativa: {activeWallet?.name}</span>
          </footer>
        </div>
      </main>
    </>
  )
}
