import { getApiErrorFeedback } from '../feedback/apiErrorFeedback'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import type { Category } from '../categories/categoriesApi'
import { categoriesApi } from '../categories/categoriesApi'
import type { Expense, ExpenseInput } from './expensesApi'
import { expensesApi } from './expensesApi'
import { getPaymentMethodNatureLabel, paymentMethodsApi } from '../paymentMethods/paymentMethodsApi'
import type { PaymentMethod } from '../paymentMethods/paymentMethodsApi'
import { creditCardsApi } from '../creditCards/creditCardsApi'
import type { CreditCard } from '../creditCards/creditCardsApi'
import { FinancialSidebar } from '../layout/FinancialSidebar'
import { useWallet } from '../wallets/useWallet'
import { MonthYearSelector } from '../period/MonthYearSelector'
import { formatMonth, getCurrentMonth, getMonthRange } from '../period/month'
import { formatBrazilianCurrency, formatBrazilianCurrencyInput, hasInvalidBrazilianCurrencyInput, maskBrazilianCurrencyInput, parseBrazilianCurrencyInput } from '../money/currency'
import './ExpensesPage.css'

type ExpenseEditor = {
  expenseId: string | null
  amount: string
  date: string
  description: string
  categoryId: string
  subcategoryId: string
  paymentMethodId: string
  creditCardId: string
} | null

function formatDate(date: string) {
  const [year, month, day] = date.split('-')
  return `${day}/${month}/${year}`
}

function formatAmount(amount: string) {
  return formatBrazilianCurrency(amount)
}

function getErrorMessage(error: unknown, action: 'load' | 'save' | 'delete') {
  const actionLabel = { load: 'carregar as despesas', save: 'salvar a despesa', delete: 'excluir a despesa' }[action]
  return getApiErrorFeedback(error, `Não foi possível ${actionLabel}. Verifique sua conexão e tente novamente.`, {
    404: 'Esta despesa não foi encontrada. Atualize a lista e tente novamente.',
    409: 'Esta despesa não pode ser alterada agora. Atualize a lista e confira os dados antes de tentar novamente.',
  })
}

type ExpensesPageProps = {
  userEmail: string
  isLoggingOut: boolean
  onLogout: () => void
}

export function ExpensesPage({ userEmail, isLoggingOut, onLogout }: ExpensesPageProps) {
  const { activeWalletId } = useWallet()
  const [month, setMonth] = useState(getCurrentMonth)
  const [categories, setCategories] = useState<Category[]>([])
  const [paymentMethods, setPaymentMethods] = useState<PaymentMethod[]>([])
  const [creditCards, setCreditCards] = useState<CreditCard[]>([])
  const [expenses, setExpenses] = useState<Expense[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [loadedWalletId, setLoadedWalletId] = useState<string | null>(null)
  const [pendingAction, setPendingAction] = useState<'save' | 'delete' | null>(null)
  const isSaving = pendingAction !== null
  const pendingMessage = pendingAction ? {"save":"Salvando a despesa.","delete":"Excluindo a despesa."}[pendingAction] : ''
  const [loadError, setLoadError] = useState('')
  const [formError, setFormError] = useState('')
  const [successMessage, setSuccessMessage] = useState('')
  const [editor, setEditor] = useState<ExpenseEditor>(null)
  const [amountInput, setAmountInput] = useState('')
  const [amountInputInvalid, setAmountInputInvalid] = useState(false)
  const [reloadKey, setReloadKey] = useState(0)
  const lastLoadedWalletId = useRef<string | null>(null)
  const range = useMemo(() => getMonthRange(month), [month])

  useEffect(() => {
    const controller = new AbortController()
    Promise.all([
      categoriesApi.list('expense', controller.signal),
      paymentMethodsApi.list(controller.signal),
      creditCardsApi.list(controller.signal),
      expensesApi.list(range.from, range.to, controller.signal),
    ])
      .then(([categoryResponse, paymentMethodResponse, creditCardResponse, expenseResponse]) => {
        if (controller.signal.aborted) return
        if (lastLoadedWalletId.current !== activeWalletId) {
          setEditor(null)
          setAmountInput('')
          setAmountInputInvalid(false)
          setFormError('')
          setSuccessMessage('')
        }
        lastLoadedWalletId.current = activeWalletId
        setCategories(categoryResponse.items)
        setPaymentMethods(paymentMethodResponse.items)
        setCreditCards(creditCardResponse.items)
        setExpenses(expenseResponse.items)
        setLoadedWalletId(activeWalletId)
        setLoadError('')
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted || error instanceof Error && error.name === 'AbortError') return
        setLoadedWalletId(activeWalletId)
        setLoadError(getErrorMessage(error, 'load'))
      })
      .finally(() => {
        if (!controller.signal.aborted) setIsLoading(false)
      })

    return () => controller.abort()
  }, [activeWalletId, range.from, range.to, reloadKey])

  const isWalletLoading = loadedWalletId !== activeWalletId

  const selectedCategory = categories.find((category) => category.id === editor?.categoryId)
  const availableSubcategories = selectedCategory?.subcategories ?? []
  const total = expenses.reduce((sum, expense) => addDecimalAmounts(sum, expense.amount), '0.00')

  function resetMessages() {
    setFormError('')
    setSuccessMessage('')
  }

  function startCreate() {
    resetMessages()
    setAmountInput('')
    setAmountInputInvalid(false)
    const day = Math.min(new Date().getDate(), Number(range.to.slice(-2)))
    setEditor({
      expenseId: null,
      amount: '',
      date: `${month}-${String(day).padStart(2, '0')}`,
      description: '',
      categoryId: categories[0]?.id ?? '',
      subcategoryId: '',
      paymentMethodId: '',
      creditCardId: '',
    })
  }

  function startEdit(expense: Expense) {
    resetMessages()
    setAmountInput(formatBrazilianCurrencyInput(expense.amount))
    setAmountInputInvalid(false)
    setEditor({
      expenseId: expense.id,
      amount: expense.amount,
      date: expense.date,
      description: expense.description ?? '',
      categoryId: expense.categoryId,
      subcategoryId: expense.subcategoryId ?? '',
      paymentMethodId: expense.paymentMethodId ?? '',
      creditCardId: expense.creditCardId ?? '',
    })
  }

  function closeEditor() {
    setEditor(null)
    setAmountInput('')
    setAmountInputInvalid(false)
    resetMessages()
  }

  async function reloadExpenses() {
    try {
      const { items } = await expensesApi.list(range.from, range.to)
      setExpenses(items)
      setLoadError('')
    } catch {
      setLoadError('A alteração da despesa foi concluída, mas não foi possível atualizar a lista. Use Tentar novamente para consultar os registros.')
    }
  }

  async function handleSave(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!editor) return
    if (amountInputInvalid) {
      setFormError('')
      return
    }
    const amount = parseBrazilianCurrencyInput(amountInput)
    if (!amount) {
      setFormError('Informe um valor maior que zero, usando o formato 1.234,56.')
      return
    }
    if (!editor.date || !editor.categoryId) {
      setFormError('Informe a data e a categoria da despesa.')
      return
    }
    const selectedPaymentMethod = paymentMethods.find((method) => method.id === editor.paymentMethodId)
    if (selectedPaymentMethod?.nature === 'credit_card' && !editor.creditCardId) {
      setFormError('Selecione o cartão de crédito usado nesta despesa.')
      return
    }

    const input: ExpenseInput = {
      amount,
      date: editor.date,
      description: editor.description.trim() || null,
      categoryId: editor.categoryId,
      subcategoryId: editor.subcategoryId || null,
      paymentMethodId: editor.paymentMethodId || null,
      ...(selectedPaymentMethod?.nature === 'credit_card' ? { creditCardId: editor.creditCardId } : {}),
    }
    resetMessages()
    setPendingAction('save')
    try {
      if (editor.expenseId) {
        await expensesApi.update(editor.expenseId, input)
        setSuccessMessage('Despesa atualizada.')
      } else {
        await expensesApi.create(input)
        setSuccessMessage('Despesa registrada.')
      }
      setEditor(null)
      setAmountInput('')
      setAmountInputInvalid(false)
      await reloadExpenses()
    } catch (error) {
      setFormError(getErrorMessage(error, 'save'))
    } finally {
      setPendingAction(null)
    }
  }

  async function handleDelete(expense: Expense) {
    if (!window.confirm(`Excluir a despesa de ${formatAmount(expense.amount)} em ${formatDate(expense.date)}?`)) return
    resetMessages()
    setPendingAction('delete')
    try {
      await expensesApi.remove(expense.id)
      if (editor?.expenseId === expense.id) closeEditor()
      setSuccessMessage('Despesa excluída.')
      await reloadExpenses()
    } catch (error) {
      setFormError(getErrorMessage(error, 'delete'))
    } finally {
      setPendingAction(null)
    }
  }

  function retryLoad() {
    setLoadError('')
    setIsLoading(true)
    setReloadKey((previous) => previous + 1)
  }

  function selectMonth(selectedMonth: string) {
    if (selectedMonth === month) return
    setIsLoading(true)
    setLoadError('')
    setMonth(selectedMonth)
    closeEditor()
  }

  return (
    <>
    <FinancialSidebar activePage="expenses" userEmail={userEmail} isLoggingOut={isLoggingOut} onLogout={onLogout} />
    <main className="expenses-page">
      <div className="expenses-shell">
        <section className="expenses-content" aria-labelledby="expenses-title">
          <div className="expenses-heading">
            <div>
              <p className="expenses-eyebrow">ORGANIZAÇÃO FINANCEIRA</p>
              <h1 id="expenses-title">Despesas</h1>
              <p>Registre e acompanhe o dinheiro que saiu no período.</p>
            </div>
            <button className="expenses-primary-button" type="button" onClick={startCreate} disabled={isSaving || isLoading || isWalletLoading || !!loadError || categories.length === 0} aria-describedby={categories.length === 0 && !isLoading && !isWalletLoading && !loadError ? 'expense-category-prerequisite' : undefined}>
              <span aria-hidden="true">＋</span> Nova despesa
            </button>
          </div>

          {categories.length === 0 && !isLoading && !isWalletLoading && !loadError && (
            <p className="expenses-prerequisite" id="expense-category-prerequisite" role="note">
              Para registrar uma despesa, primeiro <a href="/categories">cadastre uma categoria de despesa</a> nesta carteira.
            </p>
          )}

          {isSaving && <p className="expenses-operation-status" role="note" aria-live="polite">{pendingMessage} Aguarde a confirmação antes de iniciar outra ação.</p>}

          <MonthYearSelector month={month} onMonthChange={selectMonth} />

          {!isWalletLoading && formError && <p className="expenses-alert expenses-alert--error" role="alert">{formError}</p>}
          {!isWalletLoading && successMessage && <p className="expenses-alert expenses-alert--success" role="status">{successMessage}</p>}

          {editor && !isWalletLoading && (
            <form className="expense-editor" onSubmit={handleSave} aria-labelledby="expense-editor-title">
              <div className="expense-editor__heading">
                <h2 id="expense-editor-title">{editor.expenseId ? 'Editar despesa' : 'Nova despesa'}</h2>
                <p>Os campos marcados com * são obrigatórios.</p>
              </div>
              <div className="expense-editor__grid">
                <div className="expense-field">
                  <label htmlFor="expense-amount">Valor *</label>
                  <div className="expense-amount-input">
                    <span aria-hidden="true">R$</span>
                    <input
                      id="expense-amount"
                      type="text"
                      inputMode="decimal"
                      autoComplete="off"
                      placeholder="0,00"
                      value={amountInput}
                      onChange={(event) => {
                        setAmountInputInvalid(hasInvalidBrazilianCurrencyInput(event.target.value))
                        setAmountInput(maskBrazilianCurrencyInput(event.target.value))
                      }}
                      aria-invalid={amountInputInvalid}
                      aria-describedby={amountInputInvalid ? 'expense-amount-hint expense-amount-error' : 'expense-amount-hint'}
                      required
                    />
                  </div>
                  <small id="expense-amount-hint">Use vírgula para os centavos, por exemplo 1.234,56.</small>
                  {amountInputInvalid && <small id="expense-amount-error" role="alert">Use apenas números, até duas casas decimais e respeite o limite de R$ 999.999.999.999,99.</small>}
                </div>
                <div className="expense-field">
                  <label htmlFor="expense-date">Data *</label>
                  <input id="expense-date" type="date" value={editor.date} onChange={(event) => setEditor({ ...editor, date: event.target.value })} required />
                </div>
                <div className="expense-field">
                  <label htmlFor="expense-category">Categoria *</label>
                  <select
                    id="expense-category"
                    value={editor.categoryId}
                    onChange={(event) => setEditor({ ...editor, categoryId: event.target.value, subcategoryId: '' })}
                    required
                  >
                    <option value="" disabled>Selecione uma categoria</option>
                    {categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}
                  </select>
                  {categories.length === 0 && <small>Cadastre uma categoria de despesa antes de registrar movimentos.</small>}
                </div>
                <div className="expense-field">
                  <label htmlFor="expense-subcategory">Subcategoria</label>
                  <select
                    id="expense-subcategory"
                    value={editor.subcategoryId}
                    onChange={(event) => setEditor({ ...editor, subcategoryId: event.target.value })}
                    disabled={!editor.categoryId || availableSubcategories.length === 0}
                    aria-describedby="expense-subcategory-hint"
                  >
                    <option value="">Sem subcategoria</option>
                    {availableSubcategories.map((subcategory) => <option key={subcategory.id} value={subcategory.id}>{subcategory.name}</option>)}
                  </select>
                  <small id="expense-subcategory-hint">{!editor.categoryId ? 'Selecione uma categoria para consultar as subcategorias.' : availableSubcategories.length === 0 ? 'Esta categoria não possui subcategorias; este campo é opcional.' : 'Escolha uma subcategoria ou mantenha sem subcategoria.'}</small>
                </div>
                <div className="expense-field">
                  <label htmlFor="expense-payment-method">Forma de pagamento <span>(opcional)</span></label>
                  <select
                    id="expense-payment-method"
                    value={editor.paymentMethodId}
                    onChange={(event) => {
                      const paymentMethodId = event.target.value
                      const method = paymentMethods.find((item) => item.id === paymentMethodId)
                      setEditor({ ...editor, paymentMethodId, creditCardId: method?.nature === 'credit_card' ? editor.creditCardId : '' })
                    }}
                  >
                    <option value="">Não informada</option>
                    {editor.paymentMethodId && !paymentMethods.some((method) => method.id === editor.paymentMethodId) && (
                      <option value={editor.paymentMethodId} disabled>
                        {expenses.find((expense) => expense.id === editor.expenseId)?.paymentMethodName ?? 'Forma inativa'} (inativa)
                      </option>
                    )}
                    {paymentMethods.filter((method) => method.isActive).map((method) => (
                      <option key={method.id} value={method.id}>{method.name} · {getPaymentMethodNatureLabel(method.nature)}</option>
                    ))}
                  </select>
                  {paymentMethods.filter((method) => method.isActive).length === 0 && <small>Não há formas de pagamento ativas. Cadastre ou ative uma em <a href="/payment-methods">Formas de pagamento</a>, ou mantenha este campo opcional sem preenchimento.</small>}
                </div>
                {paymentMethods.find((method) => method.id === editor.paymentMethodId)?.nature === 'credit_card' && (
                  <div className="expense-field">
                    <label htmlFor="expense-credit-card">Cartão de crédito *</label>
                    <select
                      id="expense-credit-card"
                      aria-describedby={creditCards.some((card) => card.isActive) ? undefined : 'expense-credit-card-hint'}
                      value={editor.creditCardId}
                      onChange={(event) => setEditor({ ...editor, creditCardId: event.target.value })}
                      required
                    >
                      <option value="">Selecione um cartão</option>
                      {editor.creditCardId && !creditCards.some((card) => card.id === editor.creditCardId && card.isActive) && (
                        <option value={editor.creditCardId} disabled>{creditCards.find((card) => card.id === editor.creditCardId)?.nickname ?? 'Cartão'} (inativo)</option>
                      )}
                      {creditCards.filter((card) => card.isActive).map((card) => (
                        <option key={card.id} value={card.id}>{card.nickname}</option>
                      ))}
                    </select>
                    {creditCards.filter((card) => card.isActive).length === 0 && <small id="expense-credit-card-hint">Cadastre e ative um cartão em <a href="/credit-cards">Cartões e faturas</a> para registrar uma nova compra no crédito.</small>}
                  </div>
                )}
                <div className="expense-field expense-field--wide">
                  <label htmlFor="expense-description">Descrição <span>(opcional)</span></label>
                  <input
                    id="expense-description"
                    type="text"
                    maxLength={500}
                    value={editor.description}
                    onChange={(event) => setEditor({ ...editor, description: event.target.value })}
                    placeholder="Ex.: mercado, transporte ou conta de luz"
                  />
                </div>
              </div>
              <div className="expense-editor__actions">
                <button className="expenses-secondary-button" type="button" onClick={closeEditor} disabled={isSaving}>Cancelar</button>
                <button className="expenses-primary-button" type="submit" disabled={isSaving || categories.length === 0}>
                  {isSaving ? pendingAction === 'delete' ? 'Excluindo…' : 'Salvando…' : editor.expenseId ? 'Salvar alterações' : 'Registrar despesa'}
                </button>
              </div>
            </form>
          )}

          {loadError && !isWalletLoading ? (
            <div className="expenses-state-card" role="alert">
              <span className="expenses-state-icon" aria-hidden="true">!</span>
              <h2>Não foi possível carregar</h2>
              <p>{loadError}</p>
              <button type="button" className="expenses-secondary-button" onClick={retryLoad}>Tentar novamente</button>
            </div>
          ) : isLoading || isWalletLoading ? (
            <div className="expenses-loading" role="status"><span className="expenses-spinner" aria-hidden="true" />Carregando despesas…</div>
          ) : expenses.length === 0 ? (
            <div className="expenses-state-card">
              <span className="expenses-state-icon" aria-hidden="true">↗</span>
              <h2>Nenhuma despesa neste mês</h2>
              <p>Quando você registrar uma despesa, ela aparecerá aqui para facilitar o acompanhamento do período.</p>
              <button type="button" className="expenses-secondary-button" onClick={startCreate} disabled={isSaving || categories.length === 0} aria-describedby={categories.length === 0 ? 'expense-category-prerequisite' : undefined}>Registrar primeira despesa</button>
            </div>
          ) : (
            <>
              <div className="expenses-summary" aria-live="polite">
                <span>{expenses.length === 1 ? '1 despesa no mês' : `${expenses.length} despesas no mês`}</span>
                <strong>Total <b>{formatAmount(total)}</b></strong>
              </div>
              <ul className="expense-list" aria-label={`Despesas de ${formatMonth(month)}`}>
                {expenses.map((expense) => (
                  <li className="expense-card" key={expense.id}>
                    <div className="expense-card__main">
                      <span className="expense-card__marker" aria-hidden="true" />
                      <div className="expense-card__details">
                        <h2>{expense.description?.trim() || expense.categoryName}</h2>
                  <p>{formatDate(expense.date)} <span aria-hidden="true">·</span> {expense.categoryName}{expense.subcategoryName ? ` / ${expense.subcategoryName}` : ''}{expense.paymentMethodName ? ` · ${expense.paymentMethodName}${expense.paymentMethodNature ? ` (${getPaymentMethodNatureLabel(expense.paymentMethodNature)})` : ''}` : ''}</p>
                      </div>
                    </div>
                    <div className="expense-card__side">
                      <strong>{formatAmount(expense.amount)}</strong>
                      <div className="expense-card__actions">
                        <button type="button" className="expense-text-action" onClick={() => startEdit(expense)} disabled={isSaving} aria-label={`Editar despesa ${expense.description || expense.categoryName}`}>Editar</button>
                        <button type="button" className="expense-text-action expense-text-action--danger" onClick={() => void handleDelete(expense)} disabled={isSaving} aria-label={`Excluir despesa ${expense.description || expense.categoryName}`}>Excluir</button>
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>

        <footer className="expenses-footer">
          <span>Saldo Certo · seu espaço de organização financeira</span>
          <span>Período: {range.from.split('-').reverse().join('/')} a {range.to.split('-').reverse().join('/')}</span>
        </footer>
      </div>
    </main>
    </>
  )
}

function addDecimalAmounts(first: string, second: string) {
  const [firstInteger, firstFraction = '00'] = first.split('.')
  const [secondInteger, secondFraction = '00'] = second.split('.')
  const fractionTotal = BigInt(firstFraction) + BigInt(secondFraction)
  const fraction = String(fractionTotal % 100n).padStart(2, '0')
  const carry = fractionTotal / 100n
  const integerTotal = BigInt(firstInteger) + BigInt(secondInteger) + carry
  return `${integerTotal}.${fraction}`
}
