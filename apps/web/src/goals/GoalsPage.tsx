import { useEffect, useMemo, useState } from 'react'
import type { FormEvent } from 'react'
import type { Category } from '../categories/categoriesApi'
import { categoriesApi } from '../categories/categoriesApi'
import type { InvestmentContribution, InvestmentGoal, InvestmentGoalInput } from './goalsApi'
import { GoalApiError, goalsApi } from './goalsApi'
import { FinancialSidebar } from '../layout/FinancialSidebar'
import { formatBrazilianCurrency, formatBrazilianCurrencyInput, hasInvalidBrazilianCurrencyInput, isPositiveCurrencyAmount, maskBrazilianCurrencyInput, parseBrazilianCurrencyInput } from '../money/currency'
import './GoalsPage.css'

type GoalEditor = {
  id: string | null
  title: string
  description: string
  targetAmount: string
  dueDate: string
  categoryId: string
  subcategoryId: string
}

type ContributionEditor = {
  id: string | null
  amount: string
  date: string
  description: string
}

type GoalsPageProps = { userEmail: string; isLoggingOut: boolean; onLogout: () => void }

function formatAmount(value: string) {
  return formatBrazilianCurrency(value)
}

function formatDate(value: string | null) {
  if (!value) return 'Sem prazo definido'
  const [year, month, day] = value.slice(0, 10).split('-')
  return `${day}/${month}/${year}`
}

function getToday() {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}

function getErrorMessage(error: unknown, action: string) {
  if (error instanceof GoalApiError) {
    if (error.status === 401 || error.status === 403) {
      window.location.assign('/login')
      return 'Sua sessão expirou. Entre novamente para continuar.'
    }
    if (error.status === 404) return 'Este registro não está mais disponível.'
    if (error.message.trim()) return error.message
    if (error.status === 400) return 'Confira os dados informados e tente novamente.'
    if (error.status === 409) return 'Não foi possível concluir a operação por causa dos dados vinculados.'
  }
  return `Não foi possível ${action}. Verifique sua conexão e tente novamente.`
}

function emptyGoal(): GoalEditor {
  return { id: null, title: '', description: '', targetAmount: '', dueDate: '', categoryId: '', subcategoryId: '' }
}

export function GoalsPage({ userEmail, isLoggingOut, onLogout }: GoalsPageProps) {
  const [goals, setGoals] = useState<InvestmentGoal[]>([])
  const [categories, setCategories] = useState<Category[]>([])
  const [contributions, setContributions] = useState<Record<string, InvestmentContribution[]>>({})
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [filter, setFilter] = useState<'active' | 'closed' | 'all'>('active')
  const [editor, setEditor] = useState<GoalEditor | null>(null)
  const [contributionEditor, setContributionEditor] = useState<ContributionEditor | null>(null)
  const [goalAmountInvalid, setGoalAmountInvalid] = useState(false)
  const [contributionAmountInvalid, setContributionAmountInvalid] = useState(false)
  const [contributionGoalId, setContributionGoalId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [reloadKey, setReloadKey] = useState(0)

  useEffect(() => {
    const controller = new AbortController()
    Promise.all([
      goalsApi.list(controller.signal),
      Promise.all([
        categoriesApi.list('investment', controller.signal),
        categoriesApi.list('investment_goal', controller.signal),
      ]),
    ])
      .then(([goalResponse, categoryResponses]) => {
        setGoals(goalResponse.items)
        setCategories(categoryResponses.flatMap((response) => response.items))
        setLoadError('')
      })
      .catch((cause: unknown) => {
        if (cause instanceof Error && cause.name === 'AbortError') return
        setLoadError(getErrorMessage(cause, 'carregar suas metas'))
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [reloadKey])

  const visibleGoals = useMemo(() => goals.filter((goal) => filter === 'all' || goal.status === filter), [filter, goals])
  const selectedCategory = categories.find((category) => category.id === editor?.categoryId)

  async function refreshGoals() {
    const response = await goalsApi.list()
    setGoals(response.items)
  }

  function createGoal() {
    setError('')
    setMessage('')
    setGoalAmountInvalid(false)
    setEditor(emptyGoal())
  }

  function editGoal(goal: InvestmentGoal) {
    setError('')
    setMessage('')
    setGoalAmountInvalid(false)
    setEditor({
      id: goal.id,
      title: goal.title,
      description: goal.description,
      targetAmount: formatBrazilianCurrencyInput(goal.targetAmount),
      dueDate: goal.dueDate?.slice(0, 10) ?? '',
      categoryId: goal.categoryId ?? '',
      subcategoryId: goal.subcategoryId ?? '',
    })
  }

  async function saveGoal(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!editor) return
    if (goalAmountInvalid) {
      setError('Use apenas números, até duas casas decimais e respeite o limite de R$ 999.999.999.999,99.')
      return
    }
    const amount = parseBrazilianCurrencyInput(editor.targetAmount)
    if (!amount || !isPositiveCurrencyAmount(amount)) {
      setError('Informe um valor-alvo maior que zero, usando até duas casas decimais.')
      return
    }
    const input: InvestmentGoalInput = {
      title: editor.title.trim(),
      description: editor.description.trim(),
      targetAmount: amount,
      dueDate: editor.dueDate || null,
      categoryId: editor.categoryId || null,
      subcategoryId: editor.subcategoryId || null,
    }
    setSaving(true)
    setError('')
    setMessage('')
    try {
      if (editor.id) {
        await goalsApi.update(editor.id, input)
        setMessage('Meta atualizada.')
      } else {
        await goalsApi.create(input)
        setMessage('Meta criada.')
      }
      setEditor(null)
      setGoalAmountInvalid(false)
      await refreshGoals()
    } catch (cause) {
      setError(getErrorMessage(cause, 'salvar a meta'))
    } finally { setSaving(false) }
  }

  async function closeGoal(goal: InvestmentGoal) {
    if (!window.confirm(`Encerrar a meta “${goal.title}”? Os aportes registrados serão preservados.`)) return
    setSaving(true)
    setError('')
    setMessage('')
    try {
      await goalsApi.close(goal.id)
      await refreshGoals()
      setMessage('Meta encerrada. Os aportes foram preservados.')
    } catch (cause) {
      setError(getErrorMessage(cause, 'encerrar a meta'))
    } finally { setSaving(false) }
  }

  async function loadContributions(goalId: string) {
    if (contributions[goalId]) return
    setSaving(true)
    setError('')
    try {
      const response = await goalsApi.contributions(goalId)
      setContributions((previous) => ({ ...previous, [goalId]: response.items }))
    } catch (cause) {
      setError(getErrorMessage(cause, 'carregar os aportes'))
    } finally { setSaving(false) }
  }

  async function showContributions(goalId: string) {
    if (expandedId === goalId) {
      setExpandedId(null)
      setContributionEditor(null)
      return
    }
    setExpandedId(goalId)
    setContributionEditor(null)
    await loadContributions(goalId)
  }

  function createContribution(goalId: string) {
    setError('')
    setMessage('')
    if (expandedId !== goalId) {
      setExpandedId(goalId)
      void loadContributions(goalId)
    }
    setContributionGoalId(goalId)
    setContributionAmountInvalid(false)
    setContributionEditor({ id: null, amount: '', date: getToday(), description: '' })
  }

  function editContribution(goalId: string, item: InvestmentContribution) {
    setError('')
    setMessage('')
    setContributionGoalId(goalId)
    setContributionAmountInvalid(false)
    setContributionEditor({ id: item.id, amount: formatBrazilianCurrencyInput(item.amount), date: item.date.slice(0, 10), description: item.description ?? '' })
  }

  async function refreshContributionData(goalId: string) {
    const [goalResponse, contributionResponse] = await Promise.all([goalsApi.list(), goalsApi.contributions(goalId)])
    setGoals(goalResponse.items)
    setContributions((previous) => ({ ...previous, [goalId]: contributionResponse.items }))
  }

  async function saveContribution(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!contributionEditor || !contributionGoalId) return
    if (contributionAmountInvalid) {
      setError('Use apenas números, até duas casas decimais e respeite o limite de R$ 999.999.999.999,99.')
      return
    }
    const amount = parseBrazilianCurrencyInput(contributionEditor.amount)
    if (!amount || !isPositiveCurrencyAmount(amount)) {
      setError('Informe um aporte maior que zero, usando até duas casas decimais.')
      return
    }
    const input = { amount, date: contributionEditor.date, description: contributionEditor.description.trim() || null }
    setSaving(true)
    setError('')
    setMessage('')
    try {
      if (contributionEditor.id) {
        await goalsApi.updateContribution(contributionGoalId, contributionEditor.id, input)
        setMessage('Aporte atualizado.')
      } else {
        await goalsApi.createContribution(contributionGoalId, input)
        setMessage('Aporte registrado.')
      }
      await refreshContributionData(contributionGoalId)
      setContributionEditor(null)
      setContributionGoalId(null)
      setContributionAmountInvalid(false)
    } catch (cause) {
      setError(getErrorMessage(cause, 'salvar o aporte'))
    } finally { setSaving(false) }
  }

  async function deleteContribution(goalId: string, item: InvestmentContribution) {
    if (!window.confirm(`Excluir o aporte de ${formatAmount(item.amount)}?`)) return
    setSaving(true)
    setError('')
    setMessage('')
    try {
      await goalsApi.removeContribution(goalId, item.id)
      await refreshContributionData(goalId)
      setMessage('Aporte excluído. O progresso foi atualizado.')
    } catch (cause) {
      setError(getErrorMessage(cause, 'excluir o aporte'))
    } finally { setSaving(false) }
  }

  return (
    <>
    <FinancialSidebar activePage="goals" userEmail={userEmail} isLoggingOut={isLoggingOut} onLogout={onLogout} />
    <main className="goals-page">
      <div className="goals-shell">
        <section className="goals-content" aria-labelledby="goals-title">
          <div className="goals-heading"><div><p className="goals-eyebrow">PLANOS PARA O FUTURO</p><h1 id="goals-title">Metas de investimento</h1><p>Defina objetivos e acompanhe cada valor destinado a eles.</p></div><button className="goals-primary-button" type="button" onClick={createGoal} disabled={saving}><span aria-hidden="true">＋</span> Nova meta</button></div>
          <div className="goals-filters" role="group" aria-label="Filtrar metas">
            {([['active', 'Em andamento'], ['closed', 'Encerradas'], ['all', 'Todas']] as const).map(([value, label]) => <button type="button" className={`goals-filter${filter === value ? ' goals-filter--active' : ''}`} key={value} onClick={() => setFilter(value)} aria-pressed={filter === value}>{label}</button>)}
          </div>
          {error && <p className="goals-alert goals-alert--error" role="alert">{error}</p>}
          {message && <p className="goals-alert goals-alert--success" role="status">{message}</p>}

          {editor && <form className="goal-editor" onSubmit={(event) => void saveGoal(event)} aria-labelledby="goal-editor-title">
            <div className="goal-editor__heading"><h2 id="goal-editor-title">{editor.id ? 'Editar meta' : 'Criar meta'}</h2><p>O prazo e a categoria são opcionais. Aportes ficam separados das despesas.</p></div>
            <div className="goal-editor__grid">
              <div className="goal-field"><label htmlFor="goal-title">Título *</label><input id="goal-title" maxLength={120} value={editor.title} onChange={(event) => setEditor({ ...editor, title: event.target.value })} placeholder="Ex.: Reserva de emergência" required /></div>
              <div className="goal-field"><label htmlFor="goal-target">Valor-alvo *</label><div className="goal-amount-input"><span aria-hidden="true">R$</span><input id="goal-target" type="text" inputMode="decimal" autoComplete="off" value={editor.targetAmount} onChange={(event) => { setGoalAmountInvalid(hasInvalidBrazilianCurrencyInput(event.target.value)); setEditor({ ...editor, targetAmount: maskBrazilianCurrencyInput(event.target.value) }) }} aria-invalid={goalAmountInvalid} aria-describedby={goalAmountInvalid ? 'goal-target-hint goal-target-error' : 'goal-target-hint'} placeholder="0,00" required /></div><small id="goal-target-hint">Use vírgula para os centavos, por exemplo 1.234,56.</small>{goalAmountInvalid && <small id="goal-target-error" role="alert">Use apenas números, até duas casas decimais e respeite o limite de R$ 999.999.999.999,99.</small>}</div>
              <div className="goal-field goal-field--wide"><label htmlFor="goal-description">Descrição *</label><textarea id="goal-description" rows={3} maxLength={1000} value={editor.description} onChange={(event) => setEditor({ ...editor, description: event.target.value })} placeholder="Descreva o que você pretende alcançar" required /></div>
              <div className="goal-field"><label htmlFor="goal-date">Prazo <span>(opcional)</span></label><input id="goal-date" type="date" value={editor.dueDate} onChange={(event) => setEditor({ ...editor, dueDate: event.target.value })} /></div>
              <div className="goal-field"><label htmlFor="goal-category">Categoria <span>(opcional)</span></label><select id="goal-category" value={editor.categoryId} onChange={(event) => setEditor({ ...editor, categoryId: event.target.value, subcategoryId: '' })}><option value="">Sem categoria</option>{categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}</select>{categories.length === 0 && <small>Cadastre categorias de metas em <a href="/categories">Categorias</a>.</small>}</div>
              <div className="goal-field"><label htmlFor="goal-subcategory">Subcategoria <span>(opcional)</span></label><select id="goal-subcategory" value={editor.subcategoryId} onChange={(event) => setEditor({ ...editor, subcategoryId: event.target.value })} disabled={!selectedCategory}><option value="">Sem subcategoria</option>{selectedCategory?.subcategories.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></div>
            </div>
            <div className="goal-editor__actions"><button className="goals-secondary-button" type="button" onClick={() => setEditor(null)} disabled={saving}>Cancelar</button><button className="goals-primary-button" type="submit" disabled={saving}>{saving ? 'Salvando…' : editor.id ? 'Salvar alterações' : 'Criar meta'}</button></div>
          </form>}

          {loadError ? <div className="goals-state-card" role="alert"><span className="goals-state-icon" aria-hidden="true">!</span><h2>Não foi possível carregar</h2><p>{loadError}</p><button className="goals-secondary-button" type="button" onClick={() => { setLoading(true); setReloadKey((key) => key + 1) }}>Tentar novamente</button></div>
            : loading ? <div className="goals-loading" role="status"><span className="goals-spinner" aria-hidden="true" />Carregando metas…</div>
              : visibleGoals.length === 0 ? <div className="goals-state-card"><span className="goals-state-icon" aria-hidden="true">◎</span><h2>{filter === 'closed' ? 'Nenhuma meta encerrada' : filter === 'all' ? 'Nenhuma meta cadastrada' : 'Você ainda não tem metas'}</h2><p>{filter === 'active' ? 'Crie uma meta para acompanhar seus aportes e seu progresso.' : 'Quando houver metas neste filtro, elas aparecerão aqui.'}</p>{filter === 'active' && <button type="button" className="goals-secondary-button" onClick={createGoal}>Criar primeira meta</button>}</div>
                : <ul className="goal-list" aria-label="Metas de investimento">{visibleGoals.map((goal) => {
                  const items = contributions[goal.id]
                  const categoryLabel = [goal.categoryName, goal.subcategoryName].filter(Boolean).join(' / ')
                  const progress = Math.max(0, Math.min(100, goal.progressPercentage))
                  return <li className={`goal-card${goal.status === 'closed' ? ' goal-card--closed' : ''}`} key={goal.id}><article>
                    <div className="goal-card__top"><div className="goal-card__title-wrap"><span className="goal-card__marker" aria-hidden="true" /><div><h2>{goal.title}</h2><p>{goal.description}</p></div></div><span className={`goal-status${goal.status === 'closed' ? ' goal-status--closed' : ''}`}>{goal.status === 'closed' ? 'Encerrada' : 'Em andamento'}</span></div>
                    <div className="goal-card__meta"><span>Prazo: {formatDate(goal.dueDate)}</span>{categoryLabel && <span>Categoria: {categoryLabel}</span>}</div>
                    <div className="goal-progress-summary"><strong>{formatAmount(goal.contributedAmount)}</strong><span>de {formatAmount(goal.targetAmount)}</span><b>{Math.round(goal.progressPercentage)}%</b></div>
                    <div className="goal-progress" role="progressbar" aria-label={`Progresso da meta ${goal.title}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress)}><span style={{ width: `${progress}%` }} /></div>
                    <div className="goal-card__actions"><button className="goal-text-action" type="button" onClick={() => void showContributions(goal.id)} disabled={saving}>{expandedId === goal.id ? 'Ocultar aportes' : 'Ver aportes'}</button>{goal.status === 'active' && <><button className="goal-text-action" type="button" onClick={() => editGoal(goal)} disabled={saving}>Editar meta</button><button className="goal-text-action" type="button" onClick={() => createContribution(goal.id)} disabled={saving}>＋ Registrar aporte</button><button className="goal-text-action goal-text-action--danger" type="button" onClick={() => void closeGoal(goal)} disabled={saving}>Encerrar meta</button></>}</div>
                    {expandedId === goal.id && <div className="goal-contributions"><div className="goal-contributions__heading"><h3>Aportes</h3>{goal.status === 'active' && <button className="goal-text-action" type="button" onClick={() => createContribution(goal.id)} disabled={saving}>＋ Novo aporte</button>}</div>
                      {contributionEditor && contributionGoalId === goal.id && <form className="contribution-editor" onSubmit={(event) => void saveContribution(event)}><div className="goal-editor__grid"><div className="goal-field"><label htmlFor="contribution-amount">Valor *</label><div className="goal-amount-input"><span aria-hidden="true">R$</span><input id="contribution-amount" type="text" inputMode="decimal" autoComplete="off" value={contributionEditor.amount} onChange={(event) => { setContributionAmountInvalid(hasInvalidBrazilianCurrencyInput(event.target.value)); setContributionEditor({ ...contributionEditor, amount: maskBrazilianCurrencyInput(event.target.value) }) }} aria-invalid={contributionAmountInvalid} aria-describedby={contributionAmountInvalid ? 'contribution-amount-hint contribution-amount-error' : 'contribution-amount-hint'} placeholder="0,00" required /></div><small id="contribution-amount-hint">Use vírgula para os centavos, por exemplo 1.234,56.</small>{contributionAmountInvalid && <small id="contribution-amount-error" role="alert">Use apenas números, até duas casas decimais e respeite o limite de R$ 999.999.999.999,99.</small>}</div><div className="goal-field"><label htmlFor="contribution-date">Data *</label><input id="contribution-date" type="date" value={contributionEditor.date} onChange={(event) => setContributionEditor({ ...contributionEditor, date: event.target.value })} required /></div><div className="goal-field goal-field--wide"><label htmlFor="contribution-description">Descrição <span>(opcional)</span></label><input id="contribution-description" maxLength={500} value={contributionEditor.description} onChange={(event) => setContributionEditor({ ...contributionEditor, description: event.target.value })} placeholder="Ex.: aporte mensal" /></div></div><div className="goal-editor__actions"><button className="goals-secondary-button" type="button" onClick={() => setContributionEditor(null)} disabled={saving}>Cancelar</button><button className="goals-primary-button" type="submit" disabled={saving}>{saving ? 'Salvando…' : contributionEditor.id ? 'Salvar aporte' : 'Registrar aporte'}</button></div></form>}
                      {items === undefined ? <p className="goal-contribution-note">Carregando aportes…</p> : items.length === 0 ? <p className="goal-contribution-note">Nenhum aporte registrado nesta meta.</p> : <ul className="contribution-list">{items.map((item) => <li className="contribution-row" key={item.id}><div><strong>{formatAmount(item.amount)}</strong><span>{formatDate(item.date)}{item.description ? ` · ${item.description}` : ''}</span></div>{goal.status === 'active' && <div className="contribution-row__actions"><button className="goal-text-action" type="button" onClick={() => editContribution(goal.id, item)} disabled={saving}>Editar</button><button className="goal-text-action goal-text-action--danger" type="button" onClick={() => void deleteContribution(goal.id, item)} disabled={saving}>Excluir</button></div>}</li>)}</ul>}
                    </div>}
                  </article></li>
                })}</ul>}
        </section>
        <footer className="goals-footer"><span>Saldo Certo · seus objetivos, no seu ritmo</span><a href="/categories">Gerenciar categorias</a></footer>
      </div>
    </main>
    </>
  )
}
