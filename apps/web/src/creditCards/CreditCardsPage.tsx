import { getApiErrorFeedback } from '../feedback/apiErrorFeedback'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { FinancialSidebar } from '../layout/FinancialSidebar'
import { formatBrazilianCurrency, hasInvalidBrazilianCurrencyInput, maskBrazilianCurrencyInput, parseBrazilianCurrencyInput } from '../money/currency'
import { formatMonth, getCurrentMonth, getMonthRange } from '../period/month'
import { MonthYearSelector } from '../period/MonthYearSelector'
import { useWallet } from '../wallets/useWallet'
import { creditCardsApi } from './creditCardsApi'
import type { CreditCard, CreditCardInput, CreditCardStatement, CreditCardStatementPaymentSource } from './creditCardsApi'
import './CreditCardsPage.css'

type EditorState = { id: string | null; nickname: string; closingDay: string; dueDay: string }

function formatDate(value: string) {
  const [year, month, day] = value.slice(0, 10).split('-')
  return `${day}/${month}/${year}`
}

function displayMoney(value: string | null) {
  return value === null ? '—' : formatBrazilianCurrency(value)
}

function getErrorMessage(error: unknown, action: 'load' | 'save' | 'pay') {
  const actionLabel = { load: 'carregar cartões e faturas', save: 'salvar o cartão', pay: 'registrar o pagamento da fatura' }[action]
  return getApiErrorFeedback(error, `Não foi possível ${actionLabel}. Verifique sua conexão e tente novamente.`, {
    404: 'Este cartão ou esta fatura não está mais disponível. Atualize a lista e tente novamente.',
    409: action === 'pay'
      ? 'Esta fatura mudou ou já foi paga. Atualize as faturas e confira a situação antes de tentar novamente.'
      : 'Não foi possível alterar o cartão com os dados atuais. Confira o apelido e as informações do cartão antes de tentar novamente.',
  })
}

// The API sends decimal strings with two places; only the sign matters here, so no money arithmetic is done.
// What is left to pay is the outstanding balance, which already discounts the payments. The contract
// returns `outstandingAmount` on every statement, so there is nothing to fall back to: falling back to
// the statement total would overstate "Falta …" for a statement with a partial payment.
function amountDue(statement: CreditCardStatement) {
  return statement.outstandingAmount
}

function hasAmountDue(statement: CreditCardStatement) {
  return Number(amountDue(statement)) > 0
}

function hasPayments(statement: CreditCardStatement) {
  return Number(statement.paymentsAmount ?? '0') > 0
}

const paymentSourceLabels: Record<CreditCardStatementPaymentSource, string> = {
  manual: 'registrado aqui',
  bank_statement: 'conciliado do extrato',
}

// O valor digitado segue os mesmos utilitários monetários das outras telas, em vez de um regex
// próprio: o campo recusava justamente o formato que o seu placeholder sugere, com separador de
// milhar. Uma mensagem só, porque `parseBrazilianCurrencyInput` recusa formato inválido e zero pelo
// mesmo motivo — não é um valor que dá para cobrar.
function normalizePaymentAmount(value: string) {
  const trimmed = value.trim()
  if (!trimmed) return { amount: undefined as string | undefined, error: '' }
  const amount = parseBrazilianCurrencyInput(trimmed)
  if (!amount) {
    return { amount: undefined, error: 'Informe um valor maior que zero, no formato 1.234,56, ou deixe em branco para pagar a fatura integral.' }
  }
  return { amount, error: '' }
}

function today() {
  const current = new Date()
  return `${current.getFullYear()}-${String(current.getMonth() + 1).padStart(2, '0')}-${String(current.getDate()).padStart(2, '0')}`
}

export function CreditCardsPage({ userEmail, isLoggingOut, onLogout }: { userEmail: string; isLoggingOut: boolean; onLogout: () => void }) {
  const { activeWalletId } = useWallet()
  const [cards, setCards] = useState<CreditCard[]>([])
  const [statements, setStatements] = useState<CreditCardStatement[]>([])
  const [selectedCardId, setSelectedCardId] = useState('')
  const [month, setMonth] = useState(getCurrentMonth)
  const [editor, setEditor] = useState<EditorState | null>(null)
  const [paymentDates, setPaymentDates] = useState<Record<string, string>>({})
  const [paymentAmounts, setPaymentAmounts] = useState<Record<string, string>>({})
  // What the user typed and the mask dropped, per statement: the field signals while typing, the way
  // the other amount screens do.
  const [invalidPaymentAmounts, setInvalidPaymentAmounts] = useState<Record<string, boolean>>({})
  const [isLoading, setIsLoading] = useState(true)
  const [loadedWalletId, setLoadedWalletId] = useState<string | null>(null)
  const lastLoadedWalletId = useRef<string | null>(null)
  const [pendingAction, setPendingAction] = useState<'save' | 'toggle' | 'pay' | null>(null)
  const isSaving = pendingAction !== null
  const pendingMessage = pendingAction ? {"save":"Salvando o cartão.","toggle":"Atualizando o estado do cartão.","pay":"Registrando o pagamento integral da fatura."}[pendingAction] : ''
  const [loadError, setLoadError] = useState('')
  const [statementLoad, setStatementLoad] = useState({ key: '', error: '' })
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [reloadKey, setReloadKey] = useState(0)
  const range = useMemo(() => getMonthRange(month), [month])
  const statementRequestKey = [activeWalletId, selectedCardId, month, reloadKey].join(':')
  const isStatementsLoading = statementLoad.key !== statementRequestKey
  const isWalletLoading = loadedWalletId !== activeWalletId

  useEffect(() => {
    const controller = new AbortController()
    creditCardsApi.list(controller.signal)
      .then(({ items }) => {
        if (controller.signal.aborted) return
        if (lastLoadedWalletId.current !== activeWalletId) {
          setEditor(null)
          setPaymentDates({})
          setMessage('')
          setError('')
        }
        lastLoadedWalletId.current = activeWalletId
        setCards(items)
        setLoadedWalletId(activeWalletId)
        setSelectedCardId((current) => items.some((card) => card.id === current)
          ? current
          : items.find((card) => card.isActive)?.id ?? items[0]?.id ?? '')
        setLoadError('')
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted || cause instanceof Error && cause.name === 'AbortError') return
        setLoadedWalletId(activeWalletId)
        setLoadError(getErrorMessage(cause, 'load'))
      })
      .finally(() => { if (!controller.signal.aborted) setIsLoading(false) })
    return () => controller.abort()
  }, [activeWalletId, reloadKey])

  useEffect(() => {
    if (!selectedCardId || isWalletLoading || loadError) {
      return
    }
    const controller = new AbortController()
    creditCardsApi.statements(selectedCardId, range.from, range.to, controller.signal)
      .then(({ items }) => {
        if (controller.signal.aborted) return
        setStatements(items)
        setStatementLoad({ key: statementRequestKey, error: '' })
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted || cause instanceof Error && cause.name === 'AbortError') return
        setStatementLoad({ key: statementRequestKey, error: getErrorMessage(cause, 'load') })
      })
    return () => controller.abort()
  }, [activeWalletId, range.from, range.to, selectedCardId, reloadKey, statementRequestKey, isWalletLoading, loadError])

  function startCreate() {
    setError('')
    setMessage('')
    setEditor({ id: null, nickname: '', closingDay: '', dueDay: '' })
  }

  function startEdit(card: CreditCard) {
    setError('')
    setMessage('')
    setEditor({ id: card.id, nickname: card.nickname, closingDay: String(card.closingDay), dueDay: String(card.dueDay) })
  }

  async function handleSave(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!editor) return
    const nickname = editor.nickname.trim()
    const closingDay = Number(editor.closingDay)
    const dueDay = Number(editor.dueDay)
    if (!nickname || nickname.length > 100 || !Number.isInteger(closingDay) || closingDay < 1 || closingDay > 31 || !Number.isInteger(dueDay) || dueDay < 1 || dueDay > 31) {
      setError('Informe um apelido e dias de fechamento e vencimento entre 1 e 31.')
      return
    }
    const input: CreditCardInput = { nickname, closingDay, dueDay }
    setPendingAction('save')
    setError('')
    setMessage('')
    try {
      if (editor.id) {
        await creditCardsApi.update(editor.id, input)
        setMessage('Cartão atualizado.')
      } else {
        await creditCardsApi.create(input)
        setMessage('Cartão cadastrado.')
      }
      setEditor(null)
      setReloadKey((current) => current + 1)
    } catch (cause) {
      setError(getErrorMessage(cause, 'save'))
    } finally {
      setPendingAction(null)
    }
  }

  async function toggleActive(card: CreditCard) {
    setPendingAction('toggle')
    setError('')
    setMessage('')
    try {
      const updated = await creditCardsApi.update(card.id, { isActive: !card.isActive })
      setCards((current) => current.map((item) => item.id === updated.id ? updated : item))
      if (!updated.isActive && selectedCardId === updated.id) {
        setSelectedCardId(cards.find((item) => item.isActive && item.id !== updated.id)?.id ?? '')
      }
      setMessage(updated.isActive ? 'Cartão ativado.' : 'Cartão desativado.')
    } catch (cause) {
      setError(getErrorMessage(cause, 'save'))
    } finally {
      setPendingAction(null)
    }
  }

  async function payStatement(statement: CreditCardStatement) {
    const date = paymentDates[statement.id] || today()
    const { amount, error: amountError } = normalizePaymentAmount(paymentAmounts[statement.id] ?? '')
    if (amountError) {
      setMessage('')
      setError(amountError)
      return
    }
    setPendingAction('pay')
    setError('')
    setMessage('')
    try {
      const updated = await creditCardsApi.payStatement(statement.creditCardId, statement.id, date, amount)
      setStatements((current) => current.map((item) => item.id === updated.id ? updated : item))
      setPaymentAmounts((current) => ({ ...current, [statement.id]: '' }))
      // Clearing the field without clearing its invalid flag left the input marked invalid after a
      // payment that worked, and a screen reader kept announcing it.
      setInvalidPaymentAmounts((current) => ({ ...current, [statement.id]: false }))
      // A partial payment does not settle the statement, so the message says what really happened.
      // paidAmount only exists once the statement is settled, which is what tells the two apart even
      // if the response omits the settlement date.
      setMessage(updated.paidDate || updated.paidAmount
        ? `Fatura paga em ${formatDate(updated.paidDate ?? date)}.`
        : amount
          ? `Pagamento de ${formatBrazilianCurrency(amount)} registrado em ${formatDate(date)}. Falta ${formatBrazilianCurrency(amountDue(updated))}.`
          : `Pagamento registrado em ${formatDate(date)}. Falta ${formatBrazilianCurrency(amountDue(updated))}.`)
    } catch (cause) {
      setError(getErrorMessage(cause, 'pay'))
    } finally {
      setPendingAction(null)
    }
  }

  function retry() {
    setIsLoading(true)
    setLoadError('')
    setReloadKey((current) => current + 1)
  }

  function selectStatementCard(cardId: string) {
    if (cardId === selectedCardId) return
    setStatementLoad({ key: '', error: '' })
    setSelectedCardId(cardId)
  }

  function selectStatementMonth(selectedMonth: string) {
    if (selectedMonth === month) return
    setStatementLoad({ key: '', error: '' })
    setMonth(selectedMonth)
  }

  return <>
    <FinancialSidebar activePage="credit-cards" userEmail={userEmail} isLoggingOut={isLoggingOut} onLogout={onLogout} />
    <main className="credit-cards-page">
      <div className="credit-cards-shell">
        <section className="credit-cards-content" aria-labelledby="credit-cards-title">
          <header className="credit-cards-heading">
            <div>
              <p className="credit-cards-eyebrow">ORGANIZAÇÃO FINANCEIRA</p>
              <h1 id="credit-cards-title">Cartões e faturas</h1>
              <p>Cadastre cartões e acompanhe as compras agrupadas por fechamento da fatura.</p>
            </div>
            <button type="button" className="credit-cards-primary" onClick={startCreate} disabled={isSaving || isLoading || isWalletLoading || !!loadError}>＋ Novo cartão</button>
          </header>

          {!isWalletLoading && error && <p className="credit-cards-alert credit-cards-alert--error" role="alert">{error}</p>}
          {!isWalletLoading && message && <p className="credit-cards-alert credit-cards-alert--success" role="status">{message}</p>}
          {isSaving && <p className="credit-cards-alert credit-cards-alert--pending" role="note" aria-live="polite">{pendingMessage} Aguarde a confirmação antes de iniciar outra ação.</p>}

          {editor && !isWalletLoading && !loadError && <form className="credit-card-editor" onSubmit={handleSave} aria-label={editor.id ? 'Editar cartão' : 'Novo cartão'}>
            <h2>{editor.id ? 'Editar cartão' : 'Cadastrar cartão de crédito'}</h2>
            <div className="credit-card-editor__grid">
              <label>Apelido
                <input autoFocus maxLength={100} value={editor.nickname} onChange={(event) => setEditor({ ...editor, nickname: event.target.value })} placeholder="Ex.: Cartão principal" required />
              </label>
              <label>Dia de fechamento
                <input type="number" min="1" max="31" value={editor.closingDay} onChange={(event) => setEditor({ ...editor, closingDay: event.target.value })} required />
              </label>
              <label>Dia de vencimento
                <input type="number" min="1" max="31" value={editor.dueDay} onChange={(event) => setEditor({ ...editor, dueDay: event.target.value })} required />
              </label>
            </div>
            <div className="credit-card-editor__actions">
              <button className="credit-cards-secondary" type="button" onClick={() => setEditor(null)} disabled={isSaving}>Cancelar</button>
              <button className="credit-cards-primary" type="submit" disabled={isSaving}>{isSaving ? 'Salvando…' : 'Salvar cartão'}</button>
            </div>
          </form>}

          {isLoading || isWalletLoading ? <div className="credit-cards-loading" role="status">Carregando cartões…</div> : loadError ? <div className="credit-cards-alert credit-cards-alert--error" role="alert"><p>{loadError}</p><button type="button" className="credit-cards-secondary" onClick={retry}>Tentar novamente</button></div> : cards.length === 0 ? (
            <section className="credit-cards-empty">
              <span aria-hidden="true">▣</span>
              <h2>Nenhum cartão cadastrado</h2>
              <p>Cadastre um cartão para organizar compras e acompanhar o pagamento das faturas.</p>
              <button type="button" className="credit-cards-secondary" onClick={startCreate}>Cadastrar primeiro cartão</button>
            </section>
          ) : <>
            <section className="credit-card-list" aria-label="Cartões cadastrados">
              {cards.map((card) => <article className="credit-card-item" key={card.id}>
                <div className="credit-card-item__icon" aria-hidden="true">▣</div>
                <div className="credit-card-item__details">
                  <h2>{card.nickname}<span className={card.isActive ? 'credit-card-status credit-card-status--active' : 'credit-card-status'}>{card.isActive ? 'Ativo' : 'Inativo'}</span></h2>
                  <p>Fecha dia {card.closingDay} <span aria-hidden="true">·</span> vence dia {card.dueDay}</p>
                </div>
                <div className="credit-card-item__actions">
                  <button type="button" className="credit-card-text-action" onClick={() => startEdit(card)} disabled={isSaving}>Editar</button>
                  <button type="button" className="credit-card-text-action" onClick={() => void toggleActive(card)} disabled={isSaving}>{card.isActive ? 'Desativar' : 'Ativar'}</button>
                </div>
              </article>)}
            </section>

            <section className="statement-section" aria-labelledby="statements-title">
              <div className="statement-heading">
                <div><p className="credit-cards-eyebrow">FATURAS</p><h2 id="statements-title">Visão mensal por fechamento</h2></div>
                <select aria-label="Selecionar cartão para consultar faturas" value={selectedCardId} onChange={(event) => selectStatementCard(event.target.value)}>
                  <option value="" disabled>Selecione um cartão</option>
                  {cards.map((card) => <option key={card.id} value={card.id}>{card.nickname}{card.isActive ? '' : ' (inativo)'}</option>)}
                </select>
              </div>
              <MonthYearSelector month={month} onMonthChange={selectStatementMonth} />
              <p className="statement-period">Faturas com fechamento em {formatMonth(month).toLocaleLowerCase('pt-BR')}.</p>
              {!selectedCardId ? <p className="statement-period">Selecione um cartão para consultar suas faturas, incluindo cartões inativos.</p> : isStatementsLoading ? <div className="credit-cards-loading" role="status">Carregando faturas do cartão selecionado…</div> : statementLoad.error ? <div className="credit-cards-alert credit-cards-alert--error" role="alert"><p>{statementLoad.error}</p><button type="button" className="credit-cards-secondary" onClick={() => setReloadKey((current) => current + 1)}>Tentar novamente</button></div> : statements.length === 0 ? <div className="credit-cards-empty credit-cards-empty--compact">
                <h3>Nenhuma fatura neste período</h3><p>As faturas aparecerão aqui conforme houver compras no cartão.</p>
              </div> : <div className="statement-list">{statements.map((statement) => <article className="statement-card" key={statement.id}>
                <header className="statement-card__header">
                  <div><h3>Fatura de {statement.creditCardName}</h3><p>Fechamento {formatDate(statement.closingDate)} <span aria-hidden="true">·</span> vencimento {formatDate(statement.dueDate)}</p></div>
                  <div className="statement-card__total"><span>Total da fatura</span><strong>{formatBrazilianCurrency(statement.totalAmount)}</strong>
                    {hasPayments(statement) && !statement.paidDate && <small>Falta {formatBrazilianCurrency(amountDue(statement))}</small>}
                  </div>
                </header>
                <ul className="statement-purchases">{statement.purchases.map((purchase) => <li key={purchase.id}>
                  <div><strong>{purchase.description?.trim() || purchase.categoryName}</strong><small>{formatDate(purchase.date)} · {purchase.categoryName}{purchase.subcategoryName ? ` / ${purchase.subcategoryName}` : ''}</small></div>
                  <b>{formatBrazilianCurrency(purchase.amount)}</b>
                </li>)}</ul>
                {(statement.credits?.length ?? 0) > 0 && <>
                  <h4 className="statement-credits-title">Estornos e créditos</h4>
                  <ul className="statement-purchases statement-credits">{statement.credits!.map((credit) => <li key={credit.id}>
                    <div><strong>{credit.description?.trim() || 'Crédito na fatura'}</strong><small>{formatDate(credit.date)}{credit.originalExpenseId ? ' · vinculado à compra original' : ''}</small></div>
                    <b>− {formatBrazilianCurrency(credit.amount)}</b>
                  </li>)}</ul>
                </>}
                {(statement.payments?.length ?? 0) > 0 && <>
                  <h4 className="statement-credits-title">Pagamentos</h4>
                  <ul className="statement-purchases statement-payments">{statement.payments!.map((payment) => <li key={payment.id}>
                    <div><strong>Pagamento {paymentSourceLabels[payment.source]}</strong><small>{formatDate(payment.date)}</small></div>
                    <b>{formatBrazilianCurrency(payment.amount)}</b>
                  </li>)}</ul>
                </>}
                <footer className="statement-card__footer">
                  {statement.paidDate ? <p className="statement-paid">Paga em {formatDate(statement.paidDate)} · {displayMoney(statement.paidAmount)}</p> : <>
                    <label>Data do pagamento <input type="date" value={paymentDates[statement.id] ?? today()} onChange={(event) => setPaymentDates((current) => ({ ...current, [statement.id]: event.target.value }))} /></label>
                    <label>Valor do pagamento <input type="text" inputMode="decimal" placeholder={`Integral (${formatBrazilianCurrency(amountDue(statement))})`} value={paymentAmounts[statement.id] ?? ''} aria-invalid={invalidPaymentAmounts[statement.id] ?? false} aria-describedby={invalidPaymentAmounts[statement.id] ? `statement-amount-error-${statement.id}` : undefined} onChange={(event) => {
                      setInvalidPaymentAmounts((current) => ({ ...current, [statement.id]: hasInvalidBrazilianCurrencyInput(event.target.value) }))
                      setPaymentAmounts((current) => ({ ...current, [statement.id]: maskBrazilianCurrencyInput(event.target.value) }))
                    }} /></label>
                    {/* `aria-invalid` alone announces "invalid" and nothing else. The reason is described
                        the way `ExpensesPage` and `IncomesPage` already do it, keyed per statement because
                        every open statement renders its own field. */}
                    {invalidPaymentAmounts[statement.id] && <small id={`statement-amount-error-${statement.id}`} role="alert">Use apenas números, até duas casas decimais e respeite o limite de R$ 999.999.999.999,99.</small>}
                    <button type="button" className="credit-cards-primary" onClick={() => void payStatement(statement)} disabled={isSaving || statement.purchases.length === 0 || !hasAmountDue(statement)} aria-describedby={statement.purchases.length === 0 || !hasAmountDue(statement) ? `statement-payment-hint-${statement.id}` : undefined}>{(paymentAmounts[statement.id] ?? '').trim() ? 'Pagar valor informado' : 'Pagar fatura integral'}</button>
                    {statement.purchases.length === 0 && <p id={`statement-payment-hint-${statement.id}`} className="statement-period">Esta fatura não possui compras para pagar. Registre uma despesa vinculada ao cartão para gerar uma fatura com valor.</p>}
                    {statement.purchases.length > 0 && !hasAmountDue(statement) && <p id={`statement-payment-hint-${statement.id}`} className="statement-period">{hasPayments(statement) ? 'Os pagamentos registrados cobrem o total desta fatura: não há saldo a pagar.' : 'Os estornos e créditos cobrem as compras desta fatura: não há saldo a pagar.'}</p>}
                  </>}
                </footer>
              </article>)}</div>}
            </section>
          </>}
        </section>
        <footer className="credit-cards-footer"><span>Saldo Certo · seu espaço de organização financeira</span><span>{formatMonth(month)}</span></footer>
      </div>
    </main>
  </>
}
