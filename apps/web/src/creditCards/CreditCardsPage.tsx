import { useEffect, useMemo, useState } from 'react'
import type { FormEvent } from 'react'
import { FinancialSidebar } from '../layout/FinancialSidebar'
import { formatBrazilianCurrency } from '../money/currency'
import { formatMonth, getCurrentMonth, getMonthRange } from '../period/month'
import { MonthYearSelector } from '../period/MonthYearSelector'
import { useWallet } from '../wallets/useWallet'
import { CreditCardApiError, creditCardsApi } from './creditCardsApi'
import type { CreditCard, CreditCardInput, CreditCardStatement } from './creditCardsApi'
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
  if (!(error instanceof CreditCardApiError)) return 'Não foi possível conectar ao serviço. Verifique sua conexão e tente novamente.'
  if (error.status === 401 || error.status === 403) {
    window.location.assign('/login')
    return 'Sua sessão expirou. Entre novamente para continuar.'
  }
  if (error.message.trim()) return error.message
  if (error.status === 400) return 'Confira os dados informados e tente novamente.'
  if (error.status === 409) return 'Este cartão possui informações relacionadas e não pode ser alterado agora.'
  return action === 'load' ? 'Não foi possível carregar cartões e faturas. Tente novamente.' : 'Não foi possível concluir a operação. Tente novamente.'
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
  const [isLoading, setIsLoading] = useState(true)
  const [isSaving, setIsSaving] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [reloadKey, setReloadKey] = useState(0)
  const range = useMemo(() => getMonthRange(month), [month])

  useEffect(() => {
    const controller = new AbortController()
    creditCardsApi.list(controller.signal)
      .then(({ items }) => {
        setCards(items)
        setSelectedCardId((current) => items.some((card) => card.id === current)
          ? current
          : items.find((card) => card.isActive)?.id ?? items[0]?.id ?? '')
        setError('')
      })
      .catch((cause: unknown) => {
        if (cause instanceof Error && cause.name === 'AbortError') return
        setError(getErrorMessage(cause, 'load'))
      })
      .finally(() => { if (!controller.signal.aborted) setIsLoading(false) })
    return () => controller.abort()
  }, [activeWalletId, reloadKey])

  useEffect(() => {
    if (!selectedCardId) {
      return
    }
    const controller = new AbortController()
    creditCardsApi.statements(selectedCardId, range.from, range.to, controller.signal)
      .then(({ items }) => {
        setStatements(items)
        setError('')
      })
      .catch((cause: unknown) => {
        if (cause instanceof Error && cause.name === 'AbortError') return
        setError(getErrorMessage(cause, 'load'))
      })
    return () => controller.abort()
  }, [activeWalletId, range.from, range.to, selectedCardId, reloadKey])

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
    setIsSaving(true)
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
      setIsSaving(false)
    }
  }

  async function toggleActive(card: CreditCard) {
    setIsSaving(true)
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
      setIsSaving(false)
    }
  }

  async function payStatement(statement: CreditCardStatement) {
    const date = paymentDates[statement.id] || today()
    setIsSaving(true)
    setError('')
    setMessage('')
    try {
      const updated = await creditCardsApi.payStatement(statement.creditCardId, statement.id, date)
      setStatements((current) => current.map((item) => item.id === updated.id ? updated : item))
      setMessage(`Fatura paga em ${formatDate(updated.paidDate ?? date)}.`)
    } catch (cause) {
      setError(getErrorMessage(cause, 'pay'))
    } finally {
      setIsSaving(false)
    }
  }

  function retry() {
    setIsLoading(true)
    setError('')
    setReloadKey((current) => current + 1)
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
            <button type="button" className="credit-cards-primary" onClick={startCreate} disabled={isSaving}>＋ Novo cartão</button>
          </header>

          {error && <div className="credit-cards-alert credit-cards-alert--error" role="alert"><span>{error}</span> <button type="button" onClick={retry}>Tentar novamente</button></div>}
          {message && <p className="credit-cards-alert credit-cards-alert--success" role="status">{message}</p>}

          {editor && <form className="credit-card-editor" onSubmit={handleSave} aria-label={editor.id ? 'Editar cartão' : 'Novo cartão'}>
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

          {isLoading ? <div className="credit-cards-loading" role="status">Carregando cartões…</div> : cards.length === 0 ? (
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
                <select aria-label="Selecionar cartão para consultar faturas" value={selectedCardId} onChange={(event) => setSelectedCardId(event.target.value)}>
                  {cards.map((card) => <option key={card.id} value={card.id}>{card.nickname}{card.isActive ? '' : ' (inativo)'}</option>)}
                </select>
              </div>
              <MonthYearSelector month={month} onMonthChange={setMonth} />
              <p className="statement-period">Faturas com fechamento em {formatMonth(month).toLocaleLowerCase('pt-BR')}.</p>
              {statements.length === 0 ? <div className="credit-cards-empty credit-cards-empty--compact">
                <h3>Nenhuma fatura neste período</h3><p>As faturas aparecerão aqui conforme houver compras no cartão.</p>
              </div> : <div className="statement-list">{statements.map((statement) => <article className="statement-card" key={statement.id}>
                <header className="statement-card__header">
                  <div><h3>Fatura de {statement.creditCardName}</h3><p>Fechamento {formatDate(statement.closingDate)} <span aria-hidden="true">·</span> vencimento {formatDate(statement.dueDate)}</p></div>
                  <div className="statement-card__total"><span>Total da fatura</span><strong>{formatBrazilianCurrency(statement.totalAmount)}</strong></div>
                </header>
                <ul className="statement-purchases">{statement.purchases.map((purchase) => <li key={purchase.id}>
                  <div><strong>{purchase.description?.trim() || purchase.categoryName}</strong><small>{formatDate(purchase.date)} · {purchase.categoryName}{purchase.subcategoryName ? ` / ${purchase.subcategoryName}` : ''}</small></div>
                  <b>{formatBrazilianCurrency(purchase.amount)}</b>
                </li>)}</ul>
                <footer className="statement-card__footer">
                  {statement.paidDate ? <p className="statement-paid">Paga em {formatDate(statement.paidDate)} · {displayMoney(statement.paidAmount)}</p> : <>
                    <label>Data do pagamento <input type="date" value={paymentDates[statement.id] ?? today()} onChange={(event) => setPaymentDates((current) => ({ ...current, [statement.id]: event.target.value }))} /></label>
                    <button type="button" className="credit-cards-primary" onClick={() => void payStatement(statement)} disabled={isSaving || statement.purchases.length === 0}>Pagar fatura integral</button>
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
