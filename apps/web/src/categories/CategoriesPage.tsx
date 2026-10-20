import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import type { Category, CategoryNature } from './categoriesApi'
import { CategoryApiError, categoriesApi } from './categoriesApi'
import './CategoriesPage.css'

type CategoryEditor = {
  categoryId: string | null
  name: string
} | null

type SubcategoryEditor = {
  categoryId: string
  subcategoryId: string | null
  name: string
} | null

type MutationAction =
  | 'save-category'
  | 'delete-category'
  | 'save-subcategory'
  | 'delete-subcategory'

const natureOptions: { value: CategoryNature; label: string }[] = [
  { value: 'income', label: 'Entradas' },
  { value: 'expense', label: 'Saídas' },
  { value: 'investment', label: 'Metas de investimento' },
  { value: 'investment_goal', label: 'Metas de investimento (legado)' },
]

function normalizeName(value: string) {
  return value.trim().toLowerCase()
}

function getErrorMessage(error: unknown, action?: MutationAction) {
  if (!(error instanceof CategoryApiError)) {
    return 'Não foi possível conectar ao serviço. Verifique sua conexão e tente novamente.'
  }

  if (error.status === 401 || error.status === 403) {
    window.location.assign('/login')
    return 'Sua sessão expirou. Entre novamente para continuar.'
  }

  if (error.status === 409) {
    if (action === 'delete-category') {
      return 'A categoria ou uma de suas subcategorias está associada a movimentos ou metas. A exclusão foi recusada e nenhum registro financeiro foi removido.'
    }
    if (action === 'delete-subcategory') {
      return 'Esta subcategoria está associada a movimentos ou metas. A exclusão foi recusada e nenhum registro financeiro foi removido.'
    }
    if (action === 'save-category') {
      return 'Já existe uma categoria com esse nome para esta natureza.'
    }
    if (action === 'save-subcategory') {
      return 'Já existe uma subcategoria com esse nome nesta categoria.'
    }
    return error.message.trim() || 'A operação não pôde ser concluída por causa de um conflito com os dados existentes.'
  }

  if (error.message.trim()) return error.message
  if (error.status === 400) return 'Confira os dados informados e tente novamente.'
  return 'Ocorreu um erro ao processar sua solicitação. Tente novamente.'
}

type CategoriesPageProps = {
  userEmail: string
  isLoggingOut: boolean
  onLogout: () => void
}

export function CategoriesPage({ userEmail, isLoggingOut, onLogout }: CategoriesPageProps) {
  const [nature, setNature] = useState<CategoryNature>('income')
  const [categories, setCategories] = useState<Category[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [formError, setFormError] = useState('')
  const [successMessage, setSuccessMessage] = useState('')
  const [categoryEditor, setCategoryEditor] = useState<CategoryEditor>(null)
  const [subcategoryEditor, setSubcategoryEditor] = useState<SubcategoryEditor>(null)
  const [isSaving, setIsSaving] = useState(false)
  const [reloadKey, setReloadKey] = useState(0)

  useEffect(() => {
    const controller = new AbortController()
    categoriesApi
      .list(nature, controller.signal)
      .then(({ items }) => {
        setCategories(items)
        setLoadError('')
      })
      .catch((error: unknown) => {
        if (error instanceof Error && error.name === 'AbortError') return
        setLoadError(getErrorMessage(error))
      })
      .finally(() => {
        if (!controller.signal.aborted) setIsLoading(false)
      })

    return () => controller.abort()
  }, [nature, reloadKey])

  async function refreshCategories() {
    try {
      const { items } = await categoriesApi.list(nature)
      setCategories(items)
      setLoadError('')
    } catch (error) {
      setLoadError(getErrorMessage(error))
    }
  }

  function selectNature(nextNature: CategoryNature) {
    if (nextNature === nature) return
    setNature(nextNature)
    setIsLoading(true)
    setLoadError('')
    setFormError('')
    setSuccessMessage('')
    setCategoryEditor(null)
    setSubcategoryEditor(null)
  }

  function startCreateCategory() {
    setFormError('')
    setSuccessMessage('')
    setSubcategoryEditor(null)
    setCategoryEditor({ categoryId: null, name: '' })
  }

  function startEditCategory(category: Category) {
    setFormError('')
    setSuccessMessage('')
    setSubcategoryEditor(null)
    setCategoryEditor({ categoryId: category.id, name: category.name })
  }

  function startCreateSubcategory(categoryId: string) {
    setFormError('')
    setSuccessMessage('')
    setCategoryEditor(null)
    setSubcategoryEditor({ categoryId, subcategoryId: null, name: '' })
  }

  function startEditSubcategory(categoryId: string, subcategoryId: string, name: string) {
    setFormError('')
    setSuccessMessage('')
    setCategoryEditor(null)
    setSubcategoryEditor({ categoryId, subcategoryId, name })
  }

  async function handleSaveCategory(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!categoryEditor) return

    const name = categoryEditor.name.trim()
    if (!name) {
      setFormError('Informe o nome da categoria.')
      return
    }

    const isDuplicate = categories.some(
      (category) =>
        category.id !== categoryEditor.categoryId &&
        normalizeName(category.name) === normalizeName(name),
    )
    if (isDuplicate) {
      setFormError('Já existe uma categoria com esse nome para esta natureza.')
      return
    }

    setFormError('')
    setSuccessMessage('')
    setIsSaving(true)
    try {
      if (categoryEditor.categoryId) {
        await categoriesApi.update(categoryEditor.categoryId, name)
        setSuccessMessage('Categoria atualizada.')
      } else {
        await categoriesApi.create(name, nature)
        setSuccessMessage('Categoria criada.')
      }
      setCategoryEditor(null)
      await refreshCategories()
    } catch (error) {
      setFormError(getErrorMessage(error, 'save-category'))
    } finally {
      setIsSaving(false)
    }
  }

  async function handleDeleteCategory(category: Category) {
    const confirmed = window.confirm(
      `Excluir a categoria “${category.name}”? As subcategorias sem uso também serão removidas. Se alguma estiver vinculada a movimentos ou metas, a API recusará a exclusão e preservará os dados.`,
    )
    if (!confirmed) return

    setFormError('')
    setSuccessMessage('')
    setIsSaving(true)
    try {
      await categoriesApi.remove(category.id)
      setSuccessMessage('Categoria excluída.')
      if (categoryEditor?.categoryId === category.id) setCategoryEditor(null)
      if (subcategoryEditor?.categoryId === category.id) setSubcategoryEditor(null)
      await refreshCategories()
    } catch (error) {
      setFormError(getErrorMessage(error, 'delete-category'))
    } finally {
      setIsSaving(false)
    }
  }

  async function handleSaveSubcategory(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!subcategoryEditor) return

    const name = subcategoryEditor.name.trim()
    if (!name) {
      setFormError('Informe o nome da subcategoria.')
      return
    }

    const category = categories.find((item) => item.id === subcategoryEditor.categoryId)
    const isDuplicate = category?.subcategories.some(
      (subcategory) =>
        subcategory.id !== subcategoryEditor.subcategoryId &&
        normalizeName(subcategory.name) === normalizeName(name),
    )
    if (isDuplicate) {
      setFormError('Já existe uma subcategoria com esse nome nesta categoria.')
      return
    }

    setFormError('')
    setSuccessMessage('')
    setIsSaving(true)
    try {
      if (subcategoryEditor.subcategoryId) {
        await categoriesApi.updateSubcategory(
          subcategoryEditor.categoryId,
          subcategoryEditor.subcategoryId,
          name,
        )
        setSuccessMessage('Subcategoria atualizada.')
      } else {
        await categoriesApi.createSubcategory(subcategoryEditor.categoryId, name)
        setSuccessMessage('Subcategoria criada.')
      }
      setSubcategoryEditor(null)
      await refreshCategories()
    } catch (error) {
      setFormError(getErrorMessage(error, 'save-subcategory'))
    } finally {
      setIsSaving(false)
    }
  }

  async function handleDeleteSubcategory(
    categoryId: string,
    subcategoryId: string,
    name: string,
  ) {
    const confirmed = window.confirm(
      `Excluir a subcategoria “${name}”? Se ela estiver vinculada a movimentos ou metas, a exclusão será recusada e o histórico será preservado.`,
    )
    if (!confirmed) return

    setFormError('')
    setSuccessMessage('')
    setIsSaving(true)
    try {
      await categoriesApi.removeSubcategory(categoryId, subcategoryId)
      setSuccessMessage('Subcategoria excluída.')
      if (subcategoryEditor?.subcategoryId === subcategoryId) setSubcategoryEditor(null)
      await refreshCategories()
    } catch (error) {
      setFormError(getErrorMessage(error, 'delete-subcategory'))
    } finally {
      setIsSaving(false)
    }
  }

  function retryLoad() {
    setLoadError('')
    setIsLoading(true)
    setReloadKey((previous) => previous + 1)
  }

  const activeNatureLabel = natureOptions.find((option) => option.value === nature)?.label ?? ''

  return (
    <main className="categories-page">
      <div className="categories-shell">
        <header className="categories-topbar">
          <a className="categories-brand" href="/" aria-label="Saldo Certo, página inicial">
            <span className="categories-brand__mark" aria-hidden="true">SC</span>
            <span>saldo<span>certo</span></span>
          </a>
          <nav className="categories-account" aria-label="Conta">
            <a className="categories-account__link" href="/incomes">Entradas</a>
            <a className="categories-account__link" href="/expenses">Despesas</a>
            <a className="categories-account__link" href="/goals">Metas</a>
            <a className="categories-account__link" href="/categories" aria-current="page">Categorias</a>
            <span className="categories-account__email">{userEmail}</span>
            <button className="categories-signout" type="button" onClick={onLogout} disabled={isLoggingOut}>
              {isLoggingOut ? 'Saindo…' : 'Sair'}
            </button>
          </nav>
        </header>

        <section className="categories-content" aria-labelledby="categories-title">
          <div className="categories-heading">
            <div>
              <p className="categories-eyebrow">ORGANIZAÇÃO FINANCEIRA</p>
              <h1 id="categories-title">Categorias e subcategorias</h1>
              <p>Personalize como você classifica suas entradas, saídas e metas.</p>
            </div>
            <button className="categories-primary-button" type="button" onClick={startCreateCategory} disabled={isSaving}>
              <span aria-hidden="true">＋</span> Nova categoria
            </button>
          </div>

          <div className="nature-tabs" role="group" aria-label="Natureza das categorias">
            {natureOptions.map((option) => (
              <button
                className={nature === option.value ? 'nature-tab nature-tab--active' : 'nature-tab'}
                key={option.value}
                type="button"
                aria-pressed={nature === option.value}
                onClick={() => selectNature(option.value)}
                disabled={isSaving}
              >
                {option.label}
              </button>
            ))}
          </div>

          {formError && <p className="categories-alert categories-alert--error" role="alert">{formError}</p>}
          {successMessage && <p className="categories-alert categories-alert--success" role="status">{successMessage}</p>}

          {categoryEditor?.categoryId === null && (
            <CategoryForm
              title="Nova categoria"
              name={categoryEditor.name}
              isSaving={isSaving}
              onNameChange={(name) => setCategoryEditor({ ...categoryEditor, name })}
              onCancel={() => setCategoryEditor(null)}
              onSubmit={handleSaveCategory}
            />
          )}

          {isLoading ? (
            <div className="categories-loading" role="status" aria-live="polite">
              <span className="categories-spinner" /> Carregando categorias de {activeNatureLabel.toLowerCase()}…
            </div>
          ) : loadError ? (
            <div className="categories-state-card">
              <div className="categories-state-icon" aria-hidden="true">!</div>
              <h2>Não foi possível carregar suas categorias.</h2>
              <p className="categories-state-error" role="alert">{loadError}</p>
              <button className="categories-secondary-button" type="button" onClick={retryLoad}>Tentar novamente</button>
            </div>
          ) : categories.length === 0 && !categoryEditor ? (
            <div className="categories-state-card">
              <div className="categories-state-icon" aria-hidden="true">＋</div>
              <h2>Nenhuma categoria de {activeNatureLabel.toLowerCase()} ainda.</h2>
              <p>Crie sua primeira categoria para começar a organizar seus registros.</p>
              <button className="categories-secondary-button" type="button" onClick={startCreateCategory} disabled={isSaving}>
                Criar categoria
              </button>
            </div>
          ) : (
            <div className="category-list" aria-label={`Categorias de ${activeNatureLabel.toLowerCase()}`}>
              {categories.map((category) => (
                <CategoryCard
                  category={category}
                  key={category.id}
                  categoryEditor={categoryEditor}
                  subcategoryEditor={subcategoryEditor}
                  isSaving={isSaving}
                  onEditCategory={startEditCategory}
                  onDeleteCategory={handleDeleteCategory}
                  onCreateSubcategory={startCreateSubcategory}
                  onEditSubcategory={startEditSubcategory}
                  onDeleteSubcategory={handleDeleteSubcategory}
                  onCategoryNameChange={(name) => setCategoryEditor((editor) => editor && { ...editor, name })}
                  onSubcategoryNameChange={(name) => setSubcategoryEditor((editor) => editor && { ...editor, name })}
                  onCancelCategory={() => setCategoryEditor(null)}
                  onCancelSubcategory={() => setSubcategoryEditor(null)}
                  onSaveCategory={handleSaveCategory}
                  onSaveSubcategory={handleSaveSubcategory}
                />
              ))}
            </div>
          )}
        </section>

        <footer className="categories-footer">
          <span>© 2026 Saldo Certo</span>
          <span>Seus dados são privados e pertencem à sua conta.</span>
        </footer>
      </div>
    </main>
  )
}

type CategoryFormProps = {
  title: string
  name: string
  isSaving: boolean
  onNameChange: (name: string) => void
  onCancel: () => void
  onSubmit: (event: FormEvent<HTMLFormElement>) => void
}

function CategoryForm({ title, name, isSaving, onNameChange, onCancel, onSubmit }: CategoryFormProps) {
  return (
    <form className="category-editor" onSubmit={onSubmit}>
      <div className="category-editor__heading">
        <div>
          <h2>{title}</h2>
          <p>A natureza da categoria é definida pela aba selecionada.</p>
        </div>
      </div>
      <label htmlFor="category-name">Nome da categoria</label>
      <input
        id="category-name"
        autoFocus
        value={name}
        onChange={(event) => onNameChange(event.target.value)}
        placeholder="Ex.: Salário"
        maxLength={100}
        required
      />
      <div className="category-editor__actions">
        <button className="categories-secondary-button" type="button" onClick={onCancel} disabled={isSaving}>Cancelar</button>
        <button className="categories-primary-button" type="submit" disabled={isSaving}>
          {isSaving ? 'Salvando…' : 'Salvar categoria'}
        </button>
      </div>
    </form>
  )
}

type CategoryCardProps = {
  category: Category
  categoryEditor: CategoryEditor
  subcategoryEditor: SubcategoryEditor
  isSaving: boolean
  onEditCategory: (category: Category) => void
  onDeleteCategory: (category: Category) => void
  onCreateSubcategory: (categoryId: string) => void
  onEditSubcategory: (categoryId: string, subcategoryId: string, name: string) => void
  onDeleteSubcategory: (categoryId: string, subcategoryId: string, name: string) => void
  onCategoryNameChange: (name: string) => void
  onSubcategoryNameChange: (name: string) => void
  onCancelCategory: () => void
  onCancelSubcategory: () => void
  onSaveCategory: (event: FormEvent<HTMLFormElement>) => void
  onSaveSubcategory: (event: FormEvent<HTMLFormElement>) => void
}

function CategoryCard({
  category,
  categoryEditor,
  subcategoryEditor,
  isSaving,
  onEditCategory,
  onDeleteCategory,
  onCreateSubcategory,
  onEditSubcategory,
  onDeleteSubcategory,
  onCategoryNameChange,
  onSubcategoryNameChange,
  onCancelCategory,
  onCancelSubcategory,
  onSaveCategory,
  onSaveSubcategory,
}: CategoryCardProps) {
  const isEditing = categoryEditor?.categoryId === category.id
  const hasSubcategoryEditor = subcategoryEditor?.categoryId === category.id
  const isAddingSubcategory = hasSubcategoryEditor && subcategoryEditor.subcategoryId === null

  return (
    <article className="category-card" aria-labelledby={`category-${category.id}`}>
      <div className="category-card__header">
        <div className="category-card__title-wrap">
          <span className="category-card__marker" aria-hidden="true" />
          {isEditing ? (
            <form className="category-inline-editor" onSubmit={onSaveCategory}>
              <label className="visually-hidden" htmlFor={`edit-category-${category.id}`}>Nome da categoria</label>
              <input
                id={`edit-category-${category.id}`}
                autoFocus
                value={categoryEditor.name}
                onChange={(event) => onCategoryNameChange(event.target.value)}
                maxLength={100}
                required
              />
              <button className="category-icon-button category-icon-button--save" type="submit" disabled={isSaving} aria-label="Salvar categoria">✓</button>
              <button className="category-icon-button" type="button" onClick={onCancelCategory} disabled={isSaving} aria-label="Cancelar edição">×</button>
            </form>
          ) : (
            <>
              <h2 id={`category-${category.id}`}>{category.name}</h2>
              <span className="category-count">
                {category.subcategories.length} {category.subcategories.length === 1 ? 'subcategoria' : 'subcategorias'}
              </span>
            </>
          )}
        </div>
        {!isEditing && (
          <div className="category-card__actions" aria-label={`Ações para ${category.name}`}>
            <button className="text-action" type="button" onClick={() => onEditCategory(category)} disabled={isSaving}>
              Editar
            </button>
            <button className="text-action text-action--danger" type="button" onClick={() => onDeleteCategory(category)} disabled={isSaving}>
              Excluir
            </button>
          </div>
        )}
      </div>

      <div className="subcategory-section">
        {category.subcategories.length > 0 ? (
          <ul className="subcategory-list" aria-label={`Subcategorias de ${category.name}`}>
            {category.subcategories.map((subcategory) => (
              <li className="subcategory-row" key={subcategory.id}>
                {subcategoryEditor?.subcategoryId === subcategory.id ? (
                  <form className="subcategory-inline-editor" onSubmit={onSaveSubcategory}>
                    <label className="visually-hidden" htmlFor={`edit-subcategory-${subcategory.id}`}>Nome da subcategoria</label>
                    <input
                      id={`edit-subcategory-${subcategory.id}`}
                      autoFocus
                      value={subcategoryEditor.name}
                      onChange={(event) => onSubcategoryNameChange(event.target.value)}
                      maxLength={100}
                      required
                    />
                    <button className="category-icon-button category-icon-button--save" type="submit" disabled={isSaving} aria-label="Salvar subcategoria">✓</button>
                    <button className="category-icon-button" type="button" onClick={onCancelSubcategory} disabled={isSaving} aria-label="Cancelar edição">×</button>
                  </form>
                ) : (
                  <>
                    <span className="subcategory-row__name">{subcategory.name}</span>
                    <span className="subcategory-row__actions">
                      <button className="text-action" type="button" onClick={() => onEditSubcategory(category.id, subcategory.id, subcategory.name)} disabled={isSaving}>
                        Editar
                      </button>
                      <button className="text-action text-action--danger" type="button" onClick={() => onDeleteSubcategory(category.id, subcategory.id, subcategory.name)} disabled={isSaving}>
                        Excluir
                      </button>
                    </span>
                  </>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p className="subcategory-empty">Nenhuma subcategoria cadastrada.</p>
        )}

        {isAddingSubcategory && (
          <form className="subcategory-inline-editor subcategory-inline-editor--new" onSubmit={onSaveSubcategory}>
            <label className="visually-hidden" htmlFor={`new-subcategory-${category.id}`}>Nome da nova subcategoria</label>
            <input
              id={`new-subcategory-${category.id}`}
              autoFocus
              value={subcategoryEditor.name}
              onChange={(event) => onSubcategoryNameChange(event.target.value)}
              placeholder="Nome da subcategoria"
              maxLength={100}
              required
            />
            <button className="category-icon-button category-icon-button--save" type="submit" disabled={isSaving} aria-label="Salvar subcategoria">✓</button>
            <button className="category-icon-button" type="button" onClick={onCancelSubcategory} disabled={isSaving} aria-label="Cancelar criação">×</button>
          </form>
        )}

        {!hasSubcategoryEditor && (
          <button className="add-subcategory" type="button" onClick={() => onCreateSubcategory(category.id)} disabled={isSaving}>
            <span aria-hidden="true">＋</span> Adicionar subcategoria
          </button>
        )}
      </div>
    </article>
  )
}
