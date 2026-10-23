import { useEffect, useMemo, useRef, useState } from 'react'
import type { ChangeEvent, FormEvent } from 'react'
import type { Category } from '../categories/categoriesApi'
import { categoriesApi } from '../categories/categoriesApi'
import { getApiErrorFeedback } from '../feedback/apiErrorFeedback'
import { FinancialSidebar } from '../layout/FinancialSidebar'
import { formatBrazilianCurrency } from '../money/currency'
import { useWallet } from '../wallets/useWallet'
import type {
  FinancialImportFormat,
  FinancialImportItem,
  FinancialImportItemInput,
  FinancialImportItemStatus,
  FinancialImportItemType,
  FinancialImportSession,
  FinancialImportStatus,
} from './importsApi'
import { importsApi } from './importsApi'
import './FinancialImportsPage.css'

type FinancialImportsPageProps = {
  userEmail: string
  isLoggingOut: boolean
  onLogout: () => void
}

const maxFileSize = 10 * 1024 * 1024

const statusLabels: Record<FinancialImportStatus, string> = {
  processing: 'Processando',
  preview: 'Aguardando confirmação',
  completed: 'Concluída',
  failed: 'Falhou',
  undone: 'Desfeita',
}

const itemStatusLabels: Record<FinancialImportItemStatus, string> = {
  valid: 'Pronta para importar',
  duplicate: 'Duplicada',
  invalid: 'Inválida',
  uncategorized: 'Não categorizada',
  imported: 'Importada',
}

const typeLabels: Record<FinancialImportItemType, string> = {
  income: 'Entrada',
  expense: 'Saída',
  transfer: 'Transferência',
}

function getFileFormat(fileName: string): FinancialImportFormat | null {
  const extension = fileName.split('.').pop()?.toLowerCase()
  return extension === 'ofx' || extension === 'csv' ? extension : null
}

function formatFileSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1).replace('.', ',')} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1).replace('.', ',')} MB`
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

function createDraft(item: FinancialImportItem): FinancialImportItemInput {
  return {
    date: item.date,
    description: item.description,
    type: item.type,
    categoryId: item.categoryId,
    subcategoryId: item.subcategoryId,
  }
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

export function FinancialImportsPage({ userEmail, isLoggingOut, onLogout }: FinancialImportsPageProps) {
  const { activeWalletId, activeWallet } = useWallet()
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [history, setHistory] = useState<FinancialImportSession[]>([])
  const [selectedImport, setSelectedImport] = useState<FinancialImportSession | null>(null)
  const [drafts, setDrafts] = useState<Record<string, FinancialImportItemInput>>({})
  const [incomeCategories, setIncomeCategories] = useState<Category[]>([])
  const [expenseCategories, setExpenseCategories] = useState<Category[]>([])
  const [selectedFile, setSelectedFile] = useState<File | null>(null)
  const [loadedWalletId, setLoadedWalletId] = useState<string | null>(null)
  const [pendingAction, setPendingAction] = useState<string | null>(null)
  const [loadError, setLoadError] = useState('')
  const [formError, setFormError] = useState('')
  const [successMessage, setSuccessMessage] = useState('')
  const [reloadKey, setReloadKey] = useState(0)

  useEffect(() => {
    const controller = new AbortController()

    Promise.all([
      importsApi.list(controller.signal),
      categoriesApi.list('income', controller.signal),
      categoriesApi.list('expense', controller.signal),
    ])
      .then(([imports, incomes, expenses]) => {
        setHistory(imports.items)
        setIncomeCategories(incomes.items)
        setExpenseCategories(expenses.items)
        setLoadError('')
        setFormError('')
        setSuccessMessage('')
        setSelectedImport(null)
        setSelectedFile(null)
        if (fileInputRef.current) fileInputRef.current.value = ''
      })
      .catch((error: unknown) => {
        if (error instanceof Error && error.name === 'AbortError') return
        setLoadError(getImportError(error, 'Não foi possível carregar o histórico de importações.'))
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoadedWalletId(activeWalletId)
      })

    return () => controller.abort()
  }, [activeWalletId, reloadKey])

  useEffect(() => {
    if (selectedImport?.status !== 'processing') return
    const controller = new AbortController()
    const timer = window.setTimeout(() => {
      importsApi.get(selectedImport.id, controller.signal)
        .then((session) => {
          setSelectedImport(session)
          setDrafts(Object.fromEntries((session.items ?? []).map((item) => [item.id, createDraft(item)])))
          if (session.status !== 'processing') {
            setHistory((current) => current.map((item) => item.id === session.id ? session : item))
          }
        })
        .catch((error: unknown) => {
          if (error instanceof Error && error.name === 'AbortError') return
          setFormError(getImportError(error, 'Não foi possível acompanhar o processamento.'))
        })
    }, 1500)
    return () => {
      controller.abort()
      window.clearTimeout(timer)
    }
  }, [selectedImport])

  const confirmableCount = useMemo(
    () => (selectedImport?.items ?? []).filter((item) => item.validationStatus === 'valid' || item.validationStatus === 'uncategorized').length,
    [selectedImport?.items],
  )
  const isLoading = loadedWalletId !== activeWalletId

  function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    setFormError('')
    setSuccessMessage('')
    const file = event.target.files?.[0] ?? null
    if (!file) {
      setSelectedFile(null)
      return
    }
    if (!getFileFormat(file.name)) {
      setSelectedFile(null)
      event.target.value = ''
      setFormError('Selecione um arquivo com extensão .ofx ou .csv.')
      return
    }
    if (file.size > maxFileSize) {
      setSelectedFile(null)
      event.target.value = ''
      setFormError('O arquivo ultrapassa o limite de 10 MB.')
      return
    }
    setSelectedFile(file)
  }

  async function handleUpload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!selectedFile) {
      setFormError('Selecione um arquivo OFX ou CSV para continuar.')
      return
    }
    const format = getFileFormat(selectedFile.name)
    if (!format) return

    setPendingAction('upload')
    setFormError('')
    setSuccessMessage('')
    try {
      const session = await importsApi.upload(selectedFile, format)
      setSelectedImport(session)
      setDrafts(Object.fromEntries((session.items ?? []).map((item) => [item.id, createDraft(item)])))
      setHistory((current) => [session, ...current.filter((item) => item.id !== session.id)])
      setSelectedFile(null)
      if (fileInputRef.current) fileInputRef.current.value = ''
      setSuccessMessage('Arquivo recebido. Acompanhe o processamento e revise a prévia antes de confirmar.')
    } catch (error) {
      setFormError(getImportError(error, 'Não foi possível enviar o arquivo. Tente novamente.'))
    } finally {
      setPendingAction(null)
    }
  }

  async function openImport(importId: string) {
    setPendingAction(`open:${importId}`)
    setFormError('')
    setSuccessMessage('')
    try {
      const session = await importsApi.get(importId)
      setSelectedImport(session)
      setDrafts(Object.fromEntries((session.items ?? []).map((item) => [item.id, createDraft(item)])))
    } catch (error) {
      setFormError(getImportError(error, 'Não foi possível abrir esta importação.'))
    } finally {
      setPendingAction(null)
    }
  }

  function updateDraft(itemId: string, changes: Partial<FinancialImportItemInput>) {
    setDrafts((current) => ({
      ...current,
      [itemId]: { ...current[itemId], ...changes },
    }))
  }

  async function saveItem(item: FinancialImportItem) {
    const draft = drafts[item.id]
    if (!draft?.date || !draft.description.trim()) {
      setFormError('Informe a data e a descrição da movimentação antes de salvar.')
      return
    }
    setPendingAction(`item:${item.id}`)
    setFormError('')
    setSuccessMessage('')
    try {
      const updated = await importsApi.updateItem(selectedImport!.id, item.id, {
        ...draft,
        description: draft.description.trim(),
        categoryId: draft.type === 'transfer' ? null : draft.categoryId,
        subcategoryId: draft.type === 'transfer' ? null : draft.subcategoryId,
      })
      setSelectedImport((current) => current ? replaceSessionItem(current, updated) : current)
      setDrafts((current) => ({ ...current, [updated.id]: createDraft(updated) }))
      setSuccessMessage(`Movimentação ${item.sequence} atualizada na prévia.`)
    } catch (error) {
      setFormError(getImportError(error, 'Não foi possível atualizar a movimentação.'))
    } finally {
      setPendingAction(null)
    }
  }

  async function confirmImport() {
    if (!selectedImport || confirmableCount === 0) return
    if (!window.confirm(`Confirmar ${confirmableCount} movimentações válidas desta importação?`)) return
    setPendingAction('confirm')
    setFormError('')
    setSuccessMessage('')
    try {
      const session = await importsApi.confirm(selectedImport.id)
      setSelectedImport(session)
      setDrafts(Object.fromEntries((session.items ?? []).map((item) => [item.id, createDraft(item)])))
      setHistory((current) => current.map((item) => item.id === session.id ? session : item))
      setSuccessMessage(`${session.summary.imported} movimentações foram importadas com segurança.`)
    } catch (error) {
      setFormError(getImportError(error, 'Não foi possível confirmar a importação. Nenhuma movimentação foi gravada parcialmente.'))
    } finally {
      setPendingAction(null)
    }
  }

  async function undoImport(session: FinancialImportSession) {
    if (!window.confirm(`Desfazer a importação do arquivo ${session.fileName}?`)) return
    setPendingAction(`undo:${session.id}`)
    setFormError('')
    setSuccessMessage('')
    try {
      const undone = await importsApi.undo(session.id)
      setHistory((current) => current.map((item) => item.id === undone.id ? undone : item))
      if (selectedImport?.id === undone.id) setSelectedImport(undone)
      setSuccessMessage('Importação desfeita. As movimentações criadas por ela foram removidas.')
    } catch (error) {
      setFormError(getImportError(error, 'Não foi possível desfazer a importação. Verifique se alguma movimentação já foi alterada.'))
    } finally {
      setPendingAction(null)
    }
  }

  function retryLoad() {
    setLoadedWalletId(null)
    setLoadError('')
    setReloadKey((current) => current + 1)
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

            {formError && <p className="imports-alert imports-alert--error" role="alert">{formError}</p>}
            {successMessage && <p className="imports-alert imports-alert--success" role="status">{successMessage}</p>}

            <form className="imports-upload" onSubmit={handleUpload}>
              <div>
                <h2>Novo arquivo</h2>
                <p>Formatos aceitos: OFX ou CSV. Limite de 10 MB e 10.000 movimentações.</p>
              </div>
              <label className="imports-file-field" htmlFor="financial-import-file">
                <span>Arquivo OFX ou CSV</span>
                <input
                  ref={fileInputRef}
                  id="financial-import-file"
                  type="file"
                  aria-label="Arquivo OFX ou CSV"
                  accept=".ofx,.csv,application/x-ofx,text/csv"
                  onChange={handleFileChange}
                  disabled={pendingAction === 'upload' || isLoading}
                />
                <small>{selectedFile ? `${selectedFile.name} · ${formatFileSize(selectedFile.size)}` : 'O arquivo será processado temporariamente e não ficará armazenado.'}</small>
              </label>
              <button className="imports-primary-button" type="submit" disabled={!selectedFile || pendingAction === 'upload' || isLoading}>
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
                    session={selectedImport}
                    drafts={drafts}
                    incomeCategories={incomeCategories}
                    expenseCategories={expenseCategories}
                    pendingAction={pendingAction}
                    confirmableCount={confirmableCount}
                    onDraftChange={updateDraft}
                    onSaveItem={(item) => void saveItem(item)}
                    onConfirm={() => void confirmImport()}
                    onUndo={(session) => void undoImport(session)}
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
                            <span className={`imports-status imports-status--${session.status}`}>{statusLabels[session.status]}</span>
                            <div>
                              <h3>{session.fileName}</h3>
                              <p>{session.format.toUpperCase()} · {formatFileSize(session.fileSize)} · iniciado em {formatDateTime(session.createdAt)}</p>
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

function ImportPreview({
  session,
  drafts,
  incomeCategories,
  expenseCategories,
  pendingAction,
  confirmableCount,
  onDraftChange,
  onSaveItem,
  onConfirm,
  onUndo,
}: {
  session: FinancialImportSession
  drafts: Record<string, FinancialImportItemInput>
  incomeCategories: Category[]
  expenseCategories: Category[]
  pendingAction: string | null
  confirmableCount: number
  onDraftChange: (itemId: string, changes: Partial<FinancialImportItemInput>) => void
  onSaveItem: (item: FinancialImportItem) => void
  onConfirm: () => void
  onUndo: (session: FinancialImportSession) => void
}) {
  const items = session.items ?? []
  return (
    <section className="imports-preview" aria-labelledby="imports-preview-title">
      <div className="imports-section-heading">
        <div>
          <p className="imports-eyebrow">REVISÃO OBRIGATÓRIA</p>
          <h2 id="imports-preview-title">{session.fileName}</h2>
          <p>{session.format.toUpperCase()} · {formatFileSize(session.fileSize)} · {statusLabels[session.status]}</p>
        </div>
        <span className={`imports-status imports-status--${session.status}`}>{statusLabels[session.status]}</span>
      </div>

      <dl className="imports-summary" aria-label="Resumo da importação">
        <div><dt>Total</dt><dd>{session.summary.total}</dd></div>
        <div><dt>Válidas</dt><dd>{session.summary.valid}</dd></div>
        <div><dt>Duplicadas</dt><dd>{session.summary.duplicate}</dd></div>
        <div><dt>Inválidas</dt><dd>{session.summary.invalid}</dd></div>
        <div><dt>Sem categoria</dt><dd>{session.summary.uncategorized}</dd></div>
        <div><dt>Importadas</dt><dd>{session.summary.imported}</dd></div>
      </dl>

      {session.status === 'processing' ? (
        <p className="imports-loading" role="status"><span className="imports-spinner" aria-hidden="true" />Processando o arquivo. Esta tela será atualizada automaticamente…</p>
      ) : items.length === 0 ? (
        <div className="imports-state-card">
          <h3>Nenhuma movimentação disponível</h3>
          <p>{session.status === 'failed' ? 'O arquivo não pôde ser processado. Consulte o erro informado e envie um novo arquivo.' : 'O processador não encontrou movimentações para revisar neste arquivo.'}</p>
        </div>
      ) : (
        <ol className="imports-item-list">
          {items.map((item) => {
            const draft = drafts[item.id] ?? createDraft(item)
            const categories = draft.type === 'income' ? incomeCategories : draft.type === 'expense' ? expenseCategories : []
            const selectedCategory = categories.find((category) => category.id === draft.categoryId)
            const isEditable = session.status === 'preview' && item.validationStatus !== 'duplicate' && item.validationStatus !== 'invalid'
            return (
              <li className={`imports-item imports-item--${item.validationStatus}`} key={item.id}>
                <div className="imports-item-heading">
                  <div>
                    <span>Movimentação {item.sequence}</span>
                    <strong>{formatBrazilianCurrency(item.amount)}</strong>
                  </div>
                  <span className={`imports-item-status imports-item-status--${item.validationStatus}`}>{itemStatusLabels[item.validationStatus]}</span>
                </div>
                {item.errorMessage && <p className="imports-item-error" role="note">{item.errorMessage}</p>}
                <div className="imports-item-grid">
                  <label>
                    Data
                    <input type="date" value={draft.date} onChange={(event) => onDraftChange(item.id, { date: event.target.value })} disabled={!isEditable} />
                  </label>
                  <label>
                    Tipo
                    <select
                      value={draft.type}
                      onChange={(event) => onDraftChange(item.id, { type: event.target.value as FinancialImportItemType, categoryId: null, subcategoryId: null })}
                      disabled={!isEditable}
                    >
                      {Object.entries(typeLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                    </select>
                  </label>
                  <label className="imports-item-description">
                    Descrição
                    <input type="text" maxLength={500} value={draft.description} onChange={(event) => onDraftChange(item.id, { description: event.target.value })} disabled={!isEditable} />
                  </label>
                  {draft.type !== 'transfer' && (
                    <>
                      <label>
                        Categoria
                        <select value={draft.categoryId ?? ''} onChange={(event) => onDraftChange(item.id, { categoryId: event.target.value || null, subcategoryId: null })} disabled={!isEditable}>
                          <option value="">Não categorizada</option>
                          {categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}
                        </select>
                      </label>
                      <label>
                        Subcategoria
                        <select value={draft.subcategoryId ?? ''} onChange={(event) => onDraftChange(item.id, { subcategoryId: event.target.value || null })} disabled={!isEditable || !selectedCategory}>
                          <option value="">Sem subcategoria</option>
                          {selectedCategory?.subcategories.map((subcategory) => <option key={subcategory.id} value={subcategory.id}>{subcategory.name}</option>)}
                        </select>
                      </label>
                    </>
                  )}
                </div>
                {isEditable && (
                  <button className="imports-secondary-button" type="button" onClick={() => onSaveItem(item)} disabled={pendingAction !== null}>
                    {pendingAction === `item:${item.id}` ? 'Salvando…' : 'Salvar ajuste'}
                  </button>
                )}
              </li>
            )
          })}
        </ol>
      )}

      <div className="imports-preview-actions">
        {session.status === 'preview' && (
          <button className="imports-primary-button" type="button" onClick={onConfirm} disabled={pendingAction !== null || confirmableCount === 0}>
            {pendingAction === 'confirm' ? 'Confirmando importação…' : `Confirmar ${confirmableCount} movimentações`}
          </button>
        )}
        {session.status === 'completed' && (
          <button className="imports-secondary-button imports-secondary-button--danger" type="button" onClick={() => onUndo(session)} disabled={pendingAction !== null || !session.canUndo}>
            {pendingAction === `undo:${session.id}` ? 'Desfazendo…' : 'Desfazer importação'}
          </button>
        )}
      </div>
      {session.status === 'completed' && !session.canUndo && session.undoBlockedReason && <p className="imports-undo-reason">{session.undoBlockedReason}</p>}
    </section>
  )
}
