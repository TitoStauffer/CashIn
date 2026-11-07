import { useState } from 'react'
import type { Category } from '../categories/categoriesApi'
import { formatBrazilianCurrency } from '../money/currency'
import { adjacentClosingDates, calculateClosingDate, calculateDueDate, isValidIsoDate } from './cardStatementCycles'
import type { FinancialImportItem, FinancialImportItemInput, FinancialImportItemType, FinancialImportSession } from './importsApi'
import {
  bankTypeOptions,
  canLearnRuleFromItem,
  canReconcileStatement,
  cardTypeLabels,
  cardTypeOptions,
  createDraft,
  describeStatementCandidate,
  formatFileSize,
  formatIsoDate,
  getSessionStatusLabel,
  hasCategory,
  importItemsPerPage,
  isCardSession,
  isImportBusy,
  itemStatusLabels,
  maxAutomaticPollFailures,
  typeLabels,
} from './importsModel'

export function ImportPreview({
  session,
  drafts,
  incomeCategories,
  expenseCategories,
  pendingAction,
  pollFailureCount,
  isPollingPaused,
  confirmableCount,
  hasPendingDraftChanges,
  onDraftChange,
  onSaveItem,
  onCreateRule,
  onConfirm,
  onUndo,
  onDiscard,
}: {
  session: FinancialImportSession
  drafts: Record<string, FinancialImportItemInput>
  incomeCategories: Category[]
  expenseCategories: Category[]
  pendingAction: string | null
  pollFailureCount: number
  isPollingPaused: boolean
  confirmableCount: number
  hasPendingDraftChanges: boolean
  onDraftChange: (itemId: string, changes: Partial<FinancialImportItemInput>) => void
  onSaveItem: (item: FinancialImportItem, includeDuplicate?: boolean) => void
  onCreateRule: (item: FinancialImportItem) => void
  onConfirm: () => void
  onUndo: (session: FinancialImportSession) => void
  onDiscard: (session: FinancialImportSession) => void
}) {
  const items = session.items ?? []
  const [requestedPage, setRequestedPage] = useState(1)
  const pageCount = Math.max(1, Math.ceil(items.length / importItemsPerPage))
  const currentPage = Math.min(requestedPage, pageCount)
  const firstVisibleIndex = (currentPage - 1) * importItemsPerPage
  const visibleItems = items.slice(firstVisibleIndex, firstVisibleIndex + importItemsPerPage)
  const isCard = isCardSession(session)
  const closingDay = session.creditCardClosingDay ?? null
  const dueDay = session.creditCardDueDay ?? null
  const typeOptions = isCard ? cardTypeOptions : bankTypeOptions
  // Paid statements are shown as such, so the user does not discover it only after saving.
  const paidClosingDates = new Set((session.statements ?? []).filter((statement) => statement.isPaid).map((statement) => statement.closingDate))
  const labelForType = (type: FinancialImportItemType) => (isCard ? cardTypeLabels[type] : undefined) ?? typeLabels[type]
  return (
    <section className="imports-preview" aria-labelledby="imports-preview-title">
      <div className="imports-section-heading">
        <div>
          <p className="imports-eyebrow">REVISÃO OBRIGATÓRIA</p>
          <h2 id="imports-preview-title">{session.fileName}</h2>
          <p>{isCard ? `Fatura do cartão ${session.creditCardName ?? ''} · ` : ''}{session.format.toUpperCase()} · {formatFileSize(session.fileSize)} · {getSessionStatusLabel(session)}</p>
        </div>
        <span className={`imports-status imports-status--${session.status}`}>{getSessionStatusLabel(session)}</span>
      </div>

      <dl className="imports-summary" aria-label="Resumo da importação">
        <div><dt>Total</dt><dd>{session.summary.total}</dd></div>
        <div><dt>Válidas</dt><dd>{session.summary.valid}</dd></div>
        <div><dt>Duplicadas</dt><dd>{session.summary.duplicate}</dd></div>
        <div><dt>Inválidas</dt><dd>{session.summary.invalid}</dd></div>
        <div><dt>Sem categoria</dt><dd>{session.summary.uncategorized}</dd></div>
        <div><dt>Importadas</dt><dd>{session.summary.imported}</dd></div>
      </dl>

      {isCard && (session.statements?.length ?? 0) > 0 && (
        <div className="imports-statements">
          <h3>Faturas calculadas</h3>
          <table aria-label="Faturas calculadas">
            <thead>
              <tr><th scope="col">Fatura</th><th scope="col">Compras</th><th scope="col">Estornos e créditos</th><th scope="col">Total</th></tr>
            </thead>
            <tbody>
              {session.statements!.map((statement) => (
                <tr key={statement.closingDate}>
                  <th scope="row">
                    Fecha {formatIsoDate(statement.closingDate)} · vence {formatIsoDate(statement.dueDate)}
                    {statement.isPaid && <span className="imports-statement-paid"> · já paga</span>}
                  </th>
                  <td>{formatBrazilianCurrency(statement.purchasesAmount)}</td>
                  <td>{formatBrazilianCurrency(statement.creditsAmount)}</td>
                  <td>{formatBrazilianCurrency(statement.totalAmount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {session.status === 'failed' && session.failureMessage && (
        <p className="imports-alert imports-alert--error" role="alert">{session.failureMessage}</p>
      )}

      {session.status === 'preview' && (
        <p className="imports-confirmation-note">
          {confirmableCount === 0
            ? 'Nenhuma movimentação está pronta para confirmar. '
            : `${confirmableCount} ${confirmableCount === 1 ? 'movimentação válida será importada' : 'movimentações válidas serão importadas'}. `}
          Itens sem categoria ({session.summary.uncategorized}) ficam fora até receberem uma categoria. Itens inválidos ({session.summary.invalid}) e duplicidades confirmadas não serão importados. Possíveis duplicidades só entram após sua revisão explícita.
        </p>
      )}
      {session.status === 'preview' && hasPendingDraftChanges && (
        <p className="imports-unsaved-note" role="status">Existem ajustes não salvos. Salve cada movimentação alterada antes de confirmar a importação.</p>
      )}

      {isImportBusy(session.status) ? (
        <p className="imports-loading" role="status">
          {!isPollingPaused && <span className="imports-spinner" aria-hidden="true" />}
          {isPollingPaused
            ? 'O acompanhamento automático foi pausado. Tente novamente para consultar o estado atual.'
            : pollFailureCount > 0
            ? `A atualização falhou temporariamente. Nova tentativa automática ${pollFailureCount + 1} de ${maxAutomaticPollFailures}…`
            : session.status === 'confirming'
              ? 'Confirmando os lançamentos. Aguarde a conclusão antes de continuar…'
              : 'Processando o arquivo. Esta tela será atualizada automaticamente…'}
        </p>
      ) : items.length === 0 ? (
        <div className="imports-state-card">
          <h3>Nenhuma movimentação disponível</h3>
          <p>{session.status === 'failed' ? 'O arquivo não pôde ser processado. Consulte o erro informado e envie um novo arquivo.' : 'O processador não encontrou movimentações para revisar neste arquivo.'}</p>
        </div>
      ) : (
        <ol className="imports-item-list">
          {visibleItems.map((item) => {
            const draft = drafts[item.id] ?? createDraft(item)
            const categories = draft.type === 'income' ? incomeCategories : draft.type === 'expense' ? expenseCategories : []
            const canChooseStatement = isCard && closingDay !== null && dueDay !== null && draft.type !== 'transfer' && isValidIsoDate(draft.date)
            const canReconcilePayment = canReconcileStatement(session, draft.type)
            const candidates = canReconcilePayment ? item.statementCandidates ?? [] : []
            // The candidate list only holds open statements with an outstanding balance, so a statement
            // already chosen drops out of it. It stays selectable, otherwise saving the item again
            // would silently undo the reconciliation the user had made.
            const isChosenStatementListed = candidates.some((candidate) => candidate.statementId === draft.creditCardStatementId)
            const selectedCategory = categories.find((category) => category.id === draft.categoryId)
            const isEditable = session.status === 'preview' && item.canEdit
            const isSavingItem = pendingAction === `item:${item.id}`
            const areItemControlsDisabled = !isEditable || isSavingItem
            return (
              <li className={`imports-item imports-item--${item.validationStatus}`} key={item.id}>
                <div className="imports-item-heading">
                  <div>
                    <span>Movimentação {item.sequence}</span>
                    <strong>{formatBrazilianCurrency(item.amount)}</strong>
                  </div>
                  <span className={`imports-item-status imports-item-status--${item.validationStatus}`}>{itemStatusLabels[item.validationStatus]}</span>
                </div>
                {item.categorizationSource === 'rule' && <p className="imports-rule-suggestion">Categoria sugerida por regra desta carteira</p>}
                {item.errorMessage && <p className="imports-item-error" role="note">{item.errorMessage}</p>}
                <div className="imports-item-grid">
                  <label>
                    Data
                    <input type="date" value={draft.date} onChange={(event) => onDraftChange(item.id, isCard ? { date: event.target.value, statementClosingDate: null } : { date: event.target.value })} disabled={areItemControlsDisabled} />
                  </label>
                  <label>
                    Tipo
                    <select
                      value={draft.type}
                      onChange={(event) => onDraftChange(item.id, {
                        type: event.target.value as FinancialImportItemType,
                        categoryId: null,
                        subcategoryId: null,
                        ...(event.target.value === 'transfer' ? { statementClosingDate: null } : { creditCardStatementId: null }),
                      })}
                      disabled={areItemControlsDisabled}
                    >
                      {typeOptions.map((type) => <option key={type} value={type}>{labelForType(type)}</option>)}
                    </select>
                  </label>
                  {canChooseStatement && (
                    <label>
                      Fatura
                      <select
                        value={draft.statementClosingDate ?? calculateClosingDate(draft.date, closingDay!)}
                        onChange={(event) => onDraftChange(item.id, { statementClosingDate: event.target.value })}
                        disabled={areItemControlsDisabled}
                      >
                        {adjacentClosingDates(draft.date, closingDay!).map((closingDate) => (
                          <option key={closingDate} value={closingDate}>
                            Fecha {formatIsoDate(closingDate)} · vence {formatIsoDate(calculateDueDate(closingDate, closingDay!, dueDay!))}
                            {paidClosingDates.has(closingDate) ? ' · já paga' : ''}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                  {canReconcilePayment && (candidates.length > 0 || draft.creditCardStatementId ? (
                    <label>
                      Fatura paga
                      <select
                        value={draft.creditCardStatementId ?? ''}
                        onChange={(event) => onDraftChange(item.id, { creditCardStatementId: event.target.value || null })}
                        disabled={areItemControlsDisabled}
                      >
                        <option value="">Selecione a fatura</option>
                        {candidates.map((candidate) => (
                          <option key={candidate.statementId} value={candidate.statementId}>
                            {describeStatementCandidate(candidate)}
                          </option>
                        ))}
                        {draft.creditCardStatementId && !isChosenStatementListed && (
                          <option value={draft.creditCardStatementId}>Fatura escolhida anteriormente</option>
                        )}
                      </select>
                    </label>
                  ) : (
                    <p className="imports-item-hint" role="note">
                      Nenhuma fatura em aberto corresponde a esta saída. Escolha outro tipo ou deixe-a fora da importação.
                    </p>
                  ))}
                  <label className="imports-item-description">
                    Descrição
                    <input type="text" maxLength={500} value={draft.description} onChange={(event) => onDraftChange(item.id, { description: event.target.value })} disabled={areItemControlsDisabled} />
                  </label>
                  {hasCategory(draft.type) && (
                    <>
                      <label>
                        Categoria
                        <select value={draft.categoryId ?? ''} onChange={(event) => onDraftChange(item.id, { categoryId: event.target.value || null, subcategoryId: null })} disabled={areItemControlsDisabled}>
                          <option value="">Não categorizada</option>
                          {categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}
                        </select>
                      </label>
                      <label>
                        Subcategoria
                        <select value={draft.subcategoryId ?? ''} onChange={(event) => onDraftChange(item.id, { subcategoryId: event.target.value || null })} disabled={areItemControlsDisabled || !selectedCategory}>
                          <option value="">Sem subcategoria</option>
                          {selectedCategory?.subcategories.map((subcategory) => <option key={subcategory.id} value={subcategory.id}>{subcategory.name}</option>)}
                        </select>
                      </label>
                    </>
                  )}
                </div>
                {isEditable && (
                  <button className="imports-secondary-button" type="button" onClick={() => onSaveItem(item)} disabled={pendingAction !== null}>
                    {isSavingItem ? 'Salvando…' : 'Salvar ajuste'}
                  </button>
                )}
                {session.status === 'preview' && canLearnRuleFromItem(item, drafts[item.id]) && (
                  <button className="imports-text-button" type="button" onClick={() => onCreateRule(item)} disabled={pendingAction !== null}>
                    {pendingAction === `rule-from-item:${item.id}` ? 'Criando regra…' : 'Criar regra para esta descrição'}
                  </button>
                )}
                {session.status === 'preview' && item.validationStatus === 'duplicate' && item.canIncludeDuplicate && (
                  <button
                    className="imports-secondary-button"
                    type="button"
                    onClick={() => onSaveItem(item, true)}
                    disabled={pendingAction !== null}
                  >
                    {isSavingItem ? 'Salvando…' : 'Importar mesmo assim'}
                  </button>
                )}
              </li>
            )
          })}
        </ol>
      )}

      {!isImportBusy(session.status) && items.length > importItemsPerPage && (
        <nav className="imports-pagination" aria-label="Paginação da prévia">
          <span>Mostrando {firstVisibleIndex + 1}–{Math.min(firstVisibleIndex + importItemsPerPage, items.length)} de {items.length}</span>
          <div>
            <button className="imports-text-button" type="button" onClick={() => setRequestedPage(1)} disabled={currentPage === 1}>Primeira</button>
            <button className="imports-text-button" type="button" onClick={() => setRequestedPage(currentPage - 1)} disabled={currentPage === 1}>Anterior</button>
            <span>Página {currentPage} de {pageCount}</span>
            <button className="imports-text-button" type="button" onClick={() => setRequestedPage(currentPage + 1)} disabled={currentPage === pageCount}>Próxima</button>
            <button className="imports-text-button" type="button" onClick={() => setRequestedPage(pageCount)} disabled={currentPage === pageCount}>Última</button>
          </div>
        </nav>
      )}

      <div className="imports-preview-actions">
        {session.status === 'preview' && (
          <>
            <button className="imports-primary-button" type="button" onClick={onConfirm} disabled={pendingAction !== null || confirmableCount === 0 || hasPendingDraftChanges}>
              {pendingAction === 'confirm' ? 'Confirmando importação…' : `Confirmar ${confirmableCount} ${confirmableCount === 1 ? 'movimentação' : 'movimentações'}`}
            </button>
            <button className="imports-secondary-button imports-secondary-button--danger" type="button" onClick={() => onDiscard(session)} disabled={pendingAction !== null}>
              {pendingAction === `discard:${session.id}` ? 'Descartando prévia…' : 'Descartar prévia'}
            </button>
          </>
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
