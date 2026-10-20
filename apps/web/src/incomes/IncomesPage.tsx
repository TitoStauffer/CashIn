import { useEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import type { Category } from '../categories/categoriesApi'
import { categoriesApi } from '../categories/categoriesApi'
import type { Income, IncomeBalanceType, IncomeInput } from './incomesApi'
import { IncomeApiError, incomesApi } from './incomesApi'
import { FinancialSidebar } from '../layout/FinancialSidebar'
import { useWallet } from '../wallets/useWallet'
import { MonthYearSelector } from '../period/MonthYearSelector'
import { formatMonth, getCurrentMonth, getMonthRange } from '../period/month'
import { formatBrazilianCurrency, formatBrazilianCurrencyInput, hasInvalidBrazilianCurrencyInput, maskBrazilianCurrencyInput, parseBrazilianCurrencyInput } from '../money/currency'
import './IncomesPage.css'

type IncomeEditor = {
  incomeId: string | null
  amount: string
  date: string
  description: string
  categoryId: string
  subcategoryId: string
  balanceType: IncomeBalanceType
} | null

const balanceTypeLabels: Record<IncomeBalanceType, string> = {
  cash: 'Dinheiro',
  food_benefit: 'Vale-alimentação (VA)',
  meal_benefit: 'Vale-refeição (VR)',
  home_office_benefit: 'Auxílio home office (AHO)',
}

function formatDate(date: string) {
  const [year, month, day] = date.split('-')
  return `${day}/${month}/${year}`
}

function formatAmount(amount: string) {
  return formatBrazilianCurrency(amount)
}

function getErrorMessage(error: unknown, action: 'load' | 'save' | 'delete') {
  if (!(error instanceof IncomeApiError)) {
    return 'Não foi possível conectar ao serviço. Verifique sua conexão e tente novamente.'
  }
  if (error.status === 401 || error.status === 403) {
    window.location.assign('/login')
    return 'Sua sessão expirou. Entre novamente para continuar.'
  }
  if (error.message.trim()) return error.message
  if (error.status === 400) return 'Confira os dados informados e tente novamente.'
  if (error.status === 404) return 'Esta entrada não foi encontrada. Atualize a lista e tente novamente.'
  if (action === 'delete' && error.status === 409) return 'Esta entrada não pode ser excluída agora.'
  return action === 'load'
    ? 'Não foi possível carregar as entradas. Tente novamente.'
    : 'Não foi possível concluir a operação. Tente novamente.'
}

type IncomesPageProps = {
  userEmail: string
  isLoggingOut: boolean
  onLogout: () => void
}

export function IncomesPage({ userEmail, isLoggingOut, onLogout }: IncomesPageProps) {
  const { activeWalletId } = useWallet()
  const [month, setMonth] = useState(getCurrentMonth)
  const [categories, setCategories] = useState<Category[]>([])
  const [incomes, setIncomes] = useState<Income[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [loadedWalletId, setLoadedWalletId] = useState<string | null>(null)
  const [isSaving, setIsSaving] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [formError, setFormError] = useState('')
  const [successMessage, setSuccessMessage] = useState('')
  const [editor, setEditor] = useState<IncomeEditor>(null)
  const [amountInput, setAmountInput] = useState('')
  const [amountInputInvalid, setAmountInputInvalid] = useState(false)
  const [reloadKey, setReloadKey] = useState(0)
  const lastLoadedWalletId = useRef<string | null>(null)
  const range = useMemo(() => getMonthRange(month), [month])

  useEffect(() => {
    const controller = new AbortController()
    Promise.all([
      categoriesApi.list('income', controller.signal),
      incomesApi.list(range.from, range.to, controller.signal),
    ])
      .then(([categoryResponse, incomeResponse]) => {
        if (lastLoadedWalletId.current !== activeWalletId) {
          setEditor(null)
          setAmountInput('')
          setAmountInputInvalid(false)
          setFormError('')
          setSuccessMessage('')
        }
        lastLoadedWalletId.current = activeWalletId
        setCategories(categoryResponse.items)
        setIncomes(incomeResponse.items)
        setLoadedWalletId(activeWalletId)
        setLoadError('')
      })
      .catch((error: unknown) => {
        if (error instanceof Error && error.name === 'AbortError') return
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
  const total = incomes.reduce((sum, income) => addDecimalAmounts(sum, income.amount), '0.00')

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
      incomeId: null,
      amount: '',
      date: `${month}-${String(day).padStart(2, '0')}`,
      description: '',
      categoryId: categories[0]?.id ?? '',
      subcategoryId: '',
      balanceType: 'cash',
    })
  }

  function startEdit(income: Income) {
    resetMessages()
    setAmountInput(formatBrazilianCurrencyInput(income.amount))
    setAmountInputInvalid(false)
    setEditor({
      incomeId: income.id,
      amount: income.amount,
      date: income.date,
      description: income.description ?? '',
      categoryId: income.categoryId,
      subcategoryId: income.subcategoryId ?? '',
      balanceType: income.balanceType ?? 'cash',
    })
  }

  function closeEditor() {
    setEditor(null)
    setAmountInput('')
    setAmountInputInvalid(false)
    resetMessages()
  }

  async function reloadIncomes() {
    try {
      const { items } = await incomesApi.list(range.from, range.to)
      setIncomes(items)
      setLoadError('')
    } catch (error) {
      setLoadError(getErrorMessage(error, 'load'))
    }
  }

  async function handleSave(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!editor) return
    if (amountInputInvalid) {
      setFormError('Use apenas números, até duas casas decimais e respeite o limite de R$ 999.999.999.999,99.')
      return
    }
    const amount = parseBrazilianCurrencyInput(amountInput)
    if (!amount) {
      setFormError('Informe um valor maior que zero, usando o formato 1.234,56.')
      return
    }
    if (!editor.date || !editor.categoryId) {
      setFormError('Informe a data e a categoria da entrada.')
      return
    }

    const input: IncomeInput = {
      amount,
      date: editor.date,
      description: editor.description.trim() || null,
      categoryId: editor.categoryId,
      subcategoryId: editor.subcategoryId || null,
      balanceType: editor.balanceType,
    }
    resetMessages()
    setIsSaving(true)
    try {
      if (editor.incomeId) {
        await incomesApi.update(editor.incomeId, input)
        setSuccessMessage('Entrada atualizada.')
      } else {
        await incomesApi.create(input)
        setSuccessMessage('Entrada registrada.')
      }
      setEditor(null)
      setAmountInput('')
      setAmountInputInvalid(false)
      await reloadIncomes()
    } catch (error) {
      setFormError(getErrorMessage(error, 'save'))
    } finally {
      setIsSaving(false)
    }
  }

  async function handleDelete(income: Income) {
    if (!window.confirm(`Excluir a entrada de ${formatAmount(income.amount)} em ${formatDate(income.date)}?`)) return
    resetMessages()
    setIsSaving(true)
    try {
      await incomesApi.remove(income.id)
      setSuccessMessage('Entrada excluída.')
      if (editor?.incomeId === income.id) closeEditor()
      await reloadIncomes()
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

  function selectMonth(selectedMonth: string) {
    if (selectedMonth === month) return
    setIsLoading(true)
    setLoadError('')
    setMonth(selectedMonth)
    closeEditor()
  }

  return (
    <>
    <FinancialSidebar activePage="incomes" userEmail={userEmail} isLoggingOut={isLoggingOut} onLogout={onLogout} />
    <main className="incomes-page">
      <div className="incomes-shell">
        <section className="incomes-content" aria-labelledby="incomes-title">
          <div className="incomes-heading">
            <div>
              <p className="incomes-eyebrow">ORGANIZAÇÃO FINANCEIRA</p>
              <h1 id="incomes-title">Entradas</h1>
              <p>Registre e acompanhe o dinheiro que entrou no período.</p>
            </div>
            <button className="incomes-primary-button" type="button" onClick={startCreate} disabled={isSaving || categories.length === 0}>
              <span aria-hidden="true">＋</span> Nova entrada
            </button>
          </div>

          <MonthYearSelector month={month} onMonthChange={selectMonth} />

          {formError && <p className="incomes-alert incomes-alert--error" role="alert">{formError}</p>}
          {successMessage && <p className="incomes-alert incomes-alert--success" role="status">{successMessage}</p>}

          {editor && !isWalletLoading && (
            <form className="income-editor" onSubmit={handleSave} aria-labelledby="income-editor-title">
              <div className="income-editor__heading">
                <h2 id="income-editor-title">{editor.incomeId ? 'Editar entrada' : 'Nova entrada'}</h2>
                <p>Os campos marcados com * são obrigatórios.</p>
              </div>
              <div className="income-editor__grid">
                <div className="income-field">
                  <label htmlFor="income-amount">Valor *</label>
                  <div className="income-amount-input">
                    <span aria-hidden="true">R$</span>
                    <input
                      id="income-amount"
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
                      aria-describedby={amountInputInvalid ? 'income-amount-hint income-amount-error' : 'income-amount-hint'}
                      required
                    />
                  </div>
                  <small id="income-amount-hint">Use vírgula para os centavos, por exemplo 1.234,56.</small>
                  {amountInputInvalid && <small id="income-amount-error" role="alert">Use apenas números, até duas casas decimais e respeite o limite de R$ 999.999.999.999,99.</small>}
                </div>
                <div className="income-field">
                  <label htmlFor="income-date">Data *</label>
                  <input id="income-date" type="date" value={editor.date} onChange={(event) => setEditor({ ...editor, date: event.target.value })} required />
                </div>
                <div className="income-field">
                  <label htmlFor="income-category">Categoria *</label>
                  <select
                    id="income-category"
                    value={editor.categoryId}
                    onChange={(event) => setEditor({ ...editor, categoryId: event.target.value, subcategoryId: '' })}
                    required
                  >
                    <option value="" disabled>Selecione uma categoria</option>
                    {categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}
                  </select>
                  {categories.length === 0 && <small>Cadastre uma categoria de entrada antes de registrar movimentos.</small>}
                </div>
                <div className="income-field">
                  <label htmlFor="income-subcategory">Subcategoria</label>
                  <select
                    id="income-subcategory"
                    value={editor.subcategoryId}
                    onChange={(event) => setEditor({ ...editor, subcategoryId: event.target.value })}
                    disabled={!editor.categoryId || availableSubcategories.length === 0}
                  >
                    <option value="">Sem subcategoria</option>
                    {availableSubcategories.map((subcategory) => <option key={subcategory.id} value={subcategory.id}>{subcategory.name}</option>)}
                  </select>
                </div>
                <div className="income-field">
                  <label htmlFor="income-balance-type">Destino do valor *</label>
                  <select
                    id="income-balance-type"
                    value={editor.balanceType}
                    onChange={(event) => setEditor({ ...editor, balanceType: event.target.value as IncomeBalanceType })}
                    required
                  >
                    {Object.entries(balanceTypeLabels).map(([value, label]) => (
                      <option key={value} value={value}>{label}</option>
                    ))}
                  </select>
                  <small>Benefícios ficam separados do saldo em dinheiro.</small>
                </div>
                <div className="income-field income-field--wide">
                  <label htmlFor="income-description">Descrição <span>(opcional)</span></label>
                  <input
                    id="income-description"
                    type="text"
                    maxLength={500}
                    value={editor.description}
                    onChange={(event) => setEditor({ ...editor, description: event.target.value })}
                    placeholder="Ex.: salário, venda ou reembolso"
                  />
                </div>
              </div>
              <div className="income-editor__actions">
                <button className="incomes-secondary-button" type="button" onClick={closeEditor} disabled={isSaving}>Cancelar</button>
                <button className="incomes-primary-button" type="submit" disabled={isSaving || categories.length === 0}>
                  {isSaving ? 'Salvando…' : editor.incomeId ? 'Salvar alterações' : 'Registrar entrada'}
                </button>
              </div>
            </form>
          )}

          {loadError && !isWalletLoading ? (
            <div className="incomes-state-card" role="alert">
              <span className="incomes-state-icon" aria-hidden="true">!</span>
              <h2>Não foi possível carregar</h2>
              <p>{loadError}</p>
              <button type="button" className="incomes-secondary-button" onClick={retryLoad}>Tentar novamente</button>
            </div>
          ) : isLoading || isWalletLoading ? (
            <div className="incomes-loading" role="status"><span className="incomes-spinner" aria-hidden="true" />Carregando entradas…</div>
          ) : incomes.length === 0 ? (
            <div className="incomes-state-card">
              <span className="incomes-state-icon" aria-hidden="true">↗</span>
              <h2>Nenhuma entrada neste mês</h2>
              <p>Quando você registrar uma entrada, ela aparecerá aqui para facilitar o acompanhamento do período.</p>
              <button type="button" className="incomes-secondary-button" onClick={startCreate} disabled={categories.length === 0}>Registrar primeira entrada</button>
              {categories.length === 0 && <p className="incomes-state-note">Antes, crie uma categoria de entrada em <a href="/categories">Categorias</a>.</p>}
            </div>
          ) : (
            <>
              <div className="incomes-summary" aria-live="polite">
                <span>{incomes.length === 1 ? '1 entrada no mês' : `${incomes.length} entradas no mês`}</span>
                <strong>Total <b>{formatAmount(total)}</b></strong>
              </div>
              <ul className="income-list" aria-label={`Entradas de ${formatMonth(month)}`}>
                {incomes.map((income) => (
                  <li className="income-card" key={income.id}>
                    <div className="income-card__main">
                      <span className="income-card__marker" aria-hidden="true" />
                      <div className="income-card__details">
                        <h2>{income.description?.trim() || income.categoryName}</h2>
                        <p>{formatDate(income.date)} <span aria-hidden="true">·</span> {income.categoryName}{income.subcategoryName ? ` / ${income.subcategoryName}` : ''} <span aria-hidden="true">·</span> {balanceTypeLabels[income.balanceType ?? 'cash']}</p>
                      </div>
                    </div>
                    <div className="income-card__side">
                      <strong>{formatAmount(income.amount)}</strong>
                      <div className="income-card__actions">
                        <button type="button" className="income-text-action" onClick={() => startEdit(income)} disabled={isSaving} aria-label={`Editar entrada ${income.description || income.categoryName}`}>Editar</button>
                        <button type="button" className="income-text-action income-text-action--danger" onClick={() => void handleDelete(income)} disabled={isSaving} aria-label={`Excluir entrada ${income.description || income.categoryName}`}>Excluir</button>
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>

        <footer className="incomes-footer">
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
