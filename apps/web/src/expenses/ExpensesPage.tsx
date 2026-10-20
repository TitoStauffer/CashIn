import { useEffect, useMemo, useState } from 'react'
import type { FormEvent } from 'react'
import type { Category } from '../categories/categoriesApi'
import { categoriesApi } from '../categories/categoriesApi'
import type { Expense, ExpenseInput } from './expensesApi'
import { ExpenseApiError, expensesApi } from './expensesApi'
import './ExpensesPage.css'

type ExpenseEditor = {
  expenseId: string | null
  amount: string
  date: string
  description: string
  categoryId: string
  subcategoryId: string
} | null

function getCurrentMonth() {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
}

function getMonthRange(month: string) {
  const [year, monthNumber] = month.split('-').map(Number)
  const lastDay = new Date(year, monthNumber, 0).getDate()
  return {
    from: `${month}-${'01'}`,
    to: `${month}-${String(lastDay).padStart(2, '0')}`,
  }
}

function shiftMonth(month: string, offset: number) {
  const [year, monthNumber] = month.split('-').map(Number)
  const shifted = new Date(year, monthNumber - 1 + offset, 1)
  return `${shifted.getFullYear()}-${String(shifted.getMonth() + 1).padStart(2, '0')}`
}

function formatMonth(month: string) {
  const [year, monthNumber] = month.split('-').map(Number)
  return new Intl.DateTimeFormat('pt-BR', { month: 'long', year: 'numeric' }).format(
    new Date(year, monthNumber - 1, 1),
  )
}

function formatDate(date: string) {
  const [year, month, day] = date.split('-')
  return `${day}/${month}/${year}`
}

function formatAmount(amount: string) {
  const [integerPart, fraction = '00'] = amount.split('.')
  const groupedInteger = integerPart.replace(/\B(?=(\d{3})+(?!\d))/g, '.')
  return `R$ ${groupedInteger},${fraction.padEnd(2, '0')}`
}

function parseBrazilianAmount(value: string) {
  const normalized = value.trim().replace(/^R\$\s*/i, '').replace(/\s/g, '')
  if (!normalized || !/^\d+(?:\.\d{3})*(?:,\d{0,2})?$/.test(normalized)) return null

  const [integerPart, fractionPart = ''] = normalized.replace(/\./g, '').split(',')
  const cleanInteger = integerPart.replace(/^0+(?=\d)/, '')
  const fraction = fractionPart.padEnd(2, '0')
  const canonical = `${cleanInteger}.${fraction}`
  if (/^0+\.0{2}$/.test(canonical)) return null
  return canonical
}

function getErrorMessage(error: unknown, action: 'load' | 'save' | 'delete') {
  if (!(error instanceof ExpenseApiError)) {
    return 'Não foi possível conectar ao serviço. Verifique sua conexão e tente novamente.'
  }
  if (error.status === 401 || error.status === 403) {
    window.location.assign('/login')
    return 'Sua sessão expirou. Entre novamente para continuar.'
  }
  if (error.message.trim()) return error.message
  if (error.status === 400) return 'Confira os dados informados e tente novamente.'
  if (error.status === 404) return 'Esta despesa não foi encontrada. Atualize a lista e tente novamente.'
  if (action === 'delete' && error.status === 409) return 'Esta despesa não pode ser excluída agora.'
  return action === 'load'
    ? 'Não foi possível carregar as despesas. Tente novamente.'
    : 'Não foi possível concluir a operação. Tente novamente.'
}

type ExpensesPageProps = {
  userEmail: string
  isLoggingOut: boolean
  onLogout: () => void
}

export function ExpensesPage({ userEmail, isLoggingOut, onLogout }: ExpensesPageProps) {
  const [month, setMonth] = useState(getCurrentMonth)
  const [categories, setCategories] = useState<Category[]>([])
  const [expenses, setExpenses] = useState<Expense[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [isSaving, setIsSaving] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [formError, setFormError] = useState('')
  const [successMessage, setSuccessMessage] = useState('')
  const [editor, setEditor] = useState<ExpenseEditor>(null)
  const [amountInput, setAmountInput] = useState('')
  const [reloadKey, setReloadKey] = useState(0)
  const range = useMemo(() => getMonthRange(month), [month])

  useEffect(() => {
    const controller = new AbortController()
    Promise.all([
      categoriesApi.list('expense', controller.signal),
      expensesApi.list(range.from, range.to, controller.signal),
    ])
      .then(([categoryResponse, expenseResponse]) => {
        setCategories(categoryResponse.items)
        setExpenses(expenseResponse.items)
      })
      .catch((error: unknown) => {
        if (error instanceof Error && error.name === 'AbortError') return
        setLoadError(getErrorMessage(error, 'load'))
      })
      .finally(() => {
        if (!controller.signal.aborted) setIsLoading(false)
      })

    return () => controller.abort()
  }, [range.from, range.to, reloadKey])

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
    const day = Math.min(new Date().getDate(), Number(range.to.slice(-2)))
    setEditor({
      expenseId: null,
      amount: '',
      date: `${month}-${String(day).padStart(2, '0')}`,
      description: '',
      categoryId: categories[0]?.id ?? '',
      subcategoryId: '',
    })
  }

  function startEdit(expense: Expense) {
    resetMessages()
    setAmountInput(formatInputAmount(expense.amount))
    setEditor({
      expenseId: expense.id,
      amount: expense.amount,
      date: expense.date,
      description: expense.description ?? '',
      categoryId: expense.categoryId,
      subcategoryId: expense.subcategoryId ?? '',
    })
  }

  function closeEditor() {
    setEditor(null)
    setAmountInput('')
    resetMessages()
  }

  async function reloadExpenses() {
    try {
      const { items } = await expensesApi.list(range.from, range.to)
      setExpenses(items)
      setLoadError('')
    } catch (error) {
      setLoadError(getErrorMessage(error, 'load'))
    }
  }

  async function handleSave(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!editor) return
    const amount = parseBrazilianAmount(amountInput)
    if (!amount) {
      setFormError('Informe um valor maior que zero, usando o formato 1.234,56.')
      return
    }
    if (!editor.date || !editor.categoryId) {
      setFormError('Informe a data e a categoria da despesa.')
      return
    }

    const input: ExpenseInput = {
      amount,
      date: editor.date,
      description: editor.description.trim() || null,
      categoryId: editor.categoryId,
      subcategoryId: editor.subcategoryId || null,
    }
    resetMessages()
    setIsSaving(true)
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
      await reloadExpenses()
    } catch (error) {
      setFormError(getErrorMessage(error, 'save'))
    } finally {
      setIsSaving(false)
    }
  }

  async function handleDelete(expense: Expense) {
    if (!window.confirm(`Excluir a despesa de ${formatAmount(expense.amount)} em ${formatDate(expense.date)}?`)) return
    resetMessages()
    setIsSaving(true)
    try {
      await expensesApi.remove(expense.id)
      setSuccessMessage('Despesa excluída.')
      if (editor?.expenseId === expense.id) closeEditor()
      await reloadExpenses()
    } catch (error) {
      setFormError(getErrorMessage(error, 'delete'))
    } finally {
      setIsSaving(false)
    }
  }

  function retryLoad() {
    setLoadError('')
    setIsLoading(true)
    setReloadKey((previous) => previous + 1)
  }

  function changeMonth(offset: number) {
    setIsLoading(true)
    setLoadError('')
    setMonth((current) => shiftMonth(current, offset))
    closeEditor()
  }

  return (
    <main className="expenses-page">
      <div className="expenses-shell">
        <header className="expenses-topbar">
          <a className="expenses-brand" href="/categories" aria-label="Saldo Certo, área financeira">
            <span className="expenses-brand__mark" aria-hidden="true">SC</span>
            <span>saldo<span>certo</span></span>
          </a>
          <nav className="expenses-account" aria-label="Navegação da área financeira">
            <a className="expenses-account__link" href="/incomes">Entradas</a>
            <a className="expenses-account__link" href="/expenses" aria-current="page">Despesas</a>
            <a className="expenses-account__link" href="/goals">Metas</a>
            <a className="expenses-account__link" href="/categories">Categorias</a>
            <span className="expenses-account__email">{userEmail}</span>
            <button className="expenses-signout" type="button" onClick={onLogout} disabled={isLoggingOut}>
              {isLoggingOut ? 'Saindo…' : 'Sair'}
            </button>
          </nav>
        </header>

        <section className="expenses-content" aria-labelledby="expenses-title">
          <div className="expenses-heading">
            <div>
              <p className="expenses-eyebrow">ORGANIZAÇÃO FINANCEIRA</p>
              <h1 id="expenses-title">Despesas</h1>
              <p>Registre e acompanhe o dinheiro que saiu no período.</p>
            </div>
            <button className="expenses-primary-button" type="button" onClick={startCreate} disabled={isSaving || categories.length === 0}>
              <span aria-hidden="true">＋</span> Nova despesa
            </button>
          </div>

          <div className="expenses-period" aria-label="Selecionar mês">
            <button type="button" className="expenses-period__arrow" onClick={() => changeMonth(-1)} aria-label="Mês anterior">‹</button>
            <h2 aria-live="polite">{formatMonth(month)}</h2>
            <button type="button" className="expenses-period__arrow" onClick={() => changeMonth(1)} aria-label="Próximo mês">›</button>
          </div>

          {formError && <p className="expenses-alert expenses-alert--error" role="alert">{formError}</p>}
          {successMessage && <p className="expenses-alert expenses-alert--success" role="status">{successMessage}</p>}

          {editor && (
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
                      onChange={(event) => setAmountInput(event.target.value)}
                      aria-describedby="expense-amount-hint"
                      required
                    />
                  </div>
                  <small id="expense-amount-hint">Use vírgula para os centavos, por exemplo 1.234,56.</small>
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
                  >
                    <option value="">Sem subcategoria</option>
                    {availableSubcategories.map((subcategory) => <option key={subcategory.id} value={subcategory.id}>{subcategory.name}</option>)}
                  </select>
                </div>
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
                  {isSaving ? 'Salvando…' : editor.expenseId ? 'Salvar alterações' : 'Registrar despesa'}
                </button>
              </div>
            </form>
          )}

          {loadError ? (
            <div className="expenses-state-card" role="alert">
              <span className="expenses-state-icon" aria-hidden="true">!</span>
              <h2>Não foi possível carregar</h2>
              <p>{loadError}</p>
              <button type="button" className="expenses-secondary-button" onClick={retryLoad}>Tentar novamente</button>
            </div>
          ) : isLoading ? (
            <div className="expenses-loading" role="status"><span className="expenses-spinner" aria-hidden="true" />Carregando despesas…</div>
          ) : expenses.length === 0 ? (
            <div className="expenses-state-card">
              <span className="expenses-state-icon" aria-hidden="true">↗</span>
              <h2>Nenhuma despesa neste mês</h2>
              <p>Quando você registrar uma despesa, ela aparecerá aqui para facilitar o acompanhamento do período.</p>
              <button type="button" className="expenses-secondary-button" onClick={startCreate} disabled={categories.length === 0}>Registrar primeira despesa</button>
              {categories.length === 0 && <p className="expenses-state-note">Antes, crie uma categoria de despesa em <a href="/categories">Categorias</a>.</p>}
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
                        <p>{formatDate(expense.date)} <span aria-hidden="true">·</span> {expense.categoryName}{expense.subcategoryName ? ` / ${expense.subcategoryName}` : ''}</p>
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
  )
}

function formatInputAmount(amount: string) {
  const [integerPart, fraction = '00'] = amount.split('.')
  return `${integerPart.replace(/\B(?=(\d{3})+(?!\d))/g, '.')},${fraction.padEnd(2, '0')}`
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
