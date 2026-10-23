import { getApiErrorFeedback } from '../feedback/apiErrorFeedback'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import type { Category } from '../categories/categoriesApi'
import { categoriesApi } from '../categories/categoriesApi'
import type { Income, IncomeBalanceType, IncomeInput } from './incomesApi'
import { incomesApi } from './incomesApi'
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
  food_meal_benefit: 'Cartão de benefícios (VA/VR)',
  home_office_benefit: 'Auxílio home office (AHO)',
}

const selectableBalanceTypes: IncomeBalanceType[] = ['cash', 'food_meal_benefit', 'home_office_benefit']

function formatDate(date: string) {
  const [year, month, day] = date.split('-')
  return `${day}/${month}/${year}`
}

function formatAmount(amount: string) {
  return formatBrazilianCurrency(amount)
}

function getErrorMessage(error: unknown, action: 'load' | 'save' | 'delete') {
  const actionLabel = { load: 'carregar as entradas', save: 'salvar a entrada', delete: 'excluir a entrada' }[action]
  return getApiErrorFeedback(error, `Não foi possível ${actionLabel}. Verifique sua conexão e tente novamente.`, {
    404: 'Esta entrada não foi encontrada. Atualize a lista e tente novamente.',
    409: 'Esta entrada não pode ser alterada agora. Atualize a lista e confira os dados antes de tentar novamente.',
  })
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
  const [pendingAction, setPendingAction] = useState<'save' | 'delete' | null>(null)
  const isSaving = pendingAction !== null
  const pendingMessage = pendingAction ? {"save":"Salvando a entrada.","delete":"Excluindo a entrada."}[pendingAction] : ''
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
        setIncomes(incomeResponse.items)
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
    } catch {
      setLoadError('A alteração da entrada foi concluída, mas não foi possível atualizar a lista. Use Tentar novamente para consultar os registros.')
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
    setPendingAction('save')
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
      setPendingAction(null)
    }
  }

  async function handleDelete(income: Income) {
    if (!window.confirm(`Excluir a entrada de ${formatAmount(income.amount)} em ${formatDate(income.date)}?`)) return
    resetMessages()
    setPendingAction('delete')
    try {
      await incomesApi.remove(income.id)
      if (editor?.incomeId === income.id) closeEditor()
      setSuccessMessage('Entrada excluída.')
      await reloadIncomes()
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
            <button className="incomes-primary-button" type="button" onClick={startCreate} disabled={isSaving || isLoading || isWalletLoading || !!loadError || categories.length === 0} aria-describedby={categories.length === 0 && !isLoading && !isWalletLoading && !loadError ? 'income-category-prerequisite' : undefined}>
              <span aria-hidden="true">＋</span> Nova entrada
            </button>
          </div>

          {categories.length === 0 && !isLoading && !isWalletLoading && !loadError && (
            <p className="incomes-prerequisite" id="income-category-prerequisite" role="note">
              Para registrar uma entrada, primeiro <a href="/categories">cadastre uma categoria de entrada</a> nesta carteira.
            </p>
          )}

          {isSaving && <p className="incomes-operation-status" role="note" aria-live="polite">{pendingMessage} Aguarde a confirmação antes de iniciar outra ação.</p>}

          <MonthYearSelector month={month} onMonthChange={selectMonth} />

          {!isWalletLoading && formError && <p className="incomes-alert incomes-alert--error" role="alert">{formError}</p>}
          {!isWalletLoading && successMessage && <p className="incomes-alert incomes-alert--success" role="status">{successMessage}</p>}

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
                    aria-describedby="income-subcategory-hint"
                  >
                    <option value="">Sem subcategoria</option>
                    {availableSubcategories.map((subcategory) => <option key={subcategory.id} value={subcategory.id}>{subcategory.name}</option>)}
                  </select>
                  <small id="income-subcategory-hint">{!editor.categoryId ? 'Selecione uma categoria para consultar as subcategorias.' : availableSubcategories.length === 0 ? 'Esta categoria não possui subcategorias; este campo é opcional.' : 'Escolha uma subcategoria ou mantenha sem subcategoria.'}</small>
                </div>
                <div className="income-field">
                  <label htmlFor="income-balance-type">Destino do valor *</label>
                  <select
                    id="income-balance-type"
                    aria-describedby="income-balance-type-hint"
                    value={editor.balanceType}
                    onChange={(event) => setEditor({ ...editor, balanceType: event.target.value as IncomeBalanceType })}
                    required
                  >
                    {selectableBalanceTypes.map((value) => (
                      <option key={value} value={value}>{balanceTypeLabels[value]}</option>
                    ))}
                    {(editor.balanceType === 'food_benefit' || editor.balanceType === 'meal_benefit') && (
                      <option value={editor.balanceType}>{balanceTypeLabels[editor.balanceType]} (histórico)</option>
                    )}
                  </select>
                  <small id="income-balance-type-hint">{editor.balanceType === 'food_benefit' || editor.balanceType === 'meal_benefit' ? 'Este registro mantém seu destino histórico. Para novas entradas de VA ou VR, use Cartão de benefícios (VA/VR).' : 'VA e VR usam um único saldo no cartão de benefícios. Benefícios ficam separados do saldo em dinheiro.'}</small>
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
                  {isSaving ? pendingAction === 'delete' ? 'Excluindo…' : 'Salvando…' : editor.incomeId ? 'Salvar alterações' : 'Registrar entrada'}
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
              <button type="button" className="incomes-secondary-button" onClick={startCreate} disabled={isSaving || categories.length === 0} aria-describedby={categories.length === 0 ? 'income-category-prerequisite' : undefined}>Registrar primeira entrada</button>
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
