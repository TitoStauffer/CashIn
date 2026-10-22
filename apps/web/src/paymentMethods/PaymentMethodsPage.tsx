import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { FinancialSidebar } from '../layout/FinancialSidebar'
import { useWallet } from '../wallets/useWallet'
import {
  getPaymentMethodNatureLabel,
  paymentMethodNatures,
  paymentMethodsApi,
} from './paymentMethodsApi'
import type { PaymentMethod, PaymentMethodNature } from './paymentMethodsApi'
import './PaymentMethodsPage.css'

type Editor = { id: string | null; name: string; nature: PaymentMethodNature } | null

type PaymentMethodsPageProps = {
  userEmail: string
  isLoggingOut: boolean
  onLogout: () => void
}

function getErrorMessage(error: unknown, action: 'load' | 'save') {
  if (error instanceof Error && 'status' in error) {
    const status = Number(error.status)
    if (status === 401 || status === 403) {
      window.location.assign('/login')
      return 'Sua sessão expirou. Entre novamente para continuar.'
    }
    if (error.message.trim()) return error.message
    if (status === 409) return 'Já existe uma forma de pagamento com esse nome.'
    if (status === 400) return 'Confira os dados informados e tente novamente.'
  }
  return action === 'load'
    ? 'Não foi possível carregar as formas de pagamento. Tente novamente.'
    : 'Não foi possível salvar a forma de pagamento. Tente novamente.'
}

export function PaymentMethodsPage({ userEmail, isLoggingOut, onLogout }: PaymentMethodsPageProps) {
  const { activeWalletId } = useWallet()
  const [items, setItems] = useState<PaymentMethod[]>([])
  const [editor, setEditor] = useState<Editor>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [isSaving, setIsSaving] = useState(false)
  const [loadedWalletId, setLoadedWalletId] = useState<string | null>(null)
  const [loadError, setLoadError] = useState('')
  const [formError, setFormError] = useState('')
  const [successMessage, setSuccessMessage] = useState('')
  const [reloadKey, setReloadKey] = useState(0)

  useEffect(() => {
    const controller = new AbortController()
    paymentMethodsApi.list(controller.signal)
      .then(({ items: methods }) => {
        setItems(methods)
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
  }, [activeWalletId, reloadKey])

  const isWalletLoading = loadedWalletId !== activeWalletId

  function openCreate() {
    setFormError('')
    setSuccessMessage('')
    setEditor({ id: null, name: '', nature: 'immediate' })
  }

  function openEdit(method: PaymentMethod) {
    setFormError('')
    setSuccessMessage('')
    setEditor({ id: method.id, name: method.name, nature: method.nature })
  }

  async function handleSave(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!editor) return
    const name = editor.name.trim()
    if (!name) {
      setFormError('Informe o nome da forma de pagamento.')
      return
    }

    setFormError('')
    setSuccessMessage('')
    setIsSaving(true)
    try {
      if (editor.id) {
        await paymentMethodsApi.update(editor.id, { name, nature: editor.nature })
        setSuccessMessage('Forma de pagamento atualizada.')
      } else {
        await paymentMethodsApi.create({ name, nature: editor.nature })
        setSuccessMessage('Forma de pagamento cadastrada.')
      }
      setEditor(null)
      setIsLoading(true)
      setReloadKey((previous) => previous + 1)
    } catch (error) {
      setFormError(getErrorMessage(error, 'save'))
    } finally {
      setIsSaving(false)
    }
  }

  async function toggleActive(method: PaymentMethod) {
    setFormError('')
    setSuccessMessage('')
    setIsSaving(true)
    try {
      await paymentMethodsApi.update(method.id, { isActive: !method.isActive })
      setSuccessMessage(method.isActive ? 'Forma de pagamento desativada.' : 'Forma de pagamento ativada.')
      setIsLoading(true)
      setReloadKey((previous) => previous + 1)
    } catch (error) {
      setFormError(getErrorMessage(error, 'save'))
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <>
      <FinancialSidebar activePage="payment-methods" userEmail={userEmail} isLoggingOut={isLoggingOut} onLogout={onLogout} />
      <main className="payment-methods-page">
        <div className="payment-methods-shell">
          <section className="payment-methods-content" aria-labelledby="payment-methods-title">
            <div className="payment-methods-heading">
              <div>
                <p className="payment-methods-eyebrow">ORGANIZAÇÃO FINANCEIRA</p>
                <h1 id="payment-methods-title">Formas de pagamento</h1>
                <p>Organize como as despesas são pagas nesta carteira.</p>
              </div>
              <button className="payment-methods-primary-button" type="button" onClick={openCreate} disabled={isSaving}>
                <span aria-hidden="true">＋</span> Nova forma
              </button>
            </div>

            {formError && <p className="payment-methods-alert payment-methods-alert--error" role="alert">{formError}</p>}
            {successMessage && <p className="payment-methods-alert payment-methods-alert--success" role="status">{successMessage}</p>}
            {isSaving && <p className="payment-methods-operation-status" role="note" aria-live="polite">Salvando alterações da forma de pagamento. Aguarde a confirmação antes de iniciar outra ação.</p>}

            {editor && !isWalletLoading && (
              <form className="payment-method-editor" onSubmit={handleSave} aria-labelledby="payment-method-editor-title">
                <div className="payment-method-editor__heading">
                  <h2 id="payment-method-editor-title">{editor.id ? 'Editar forma de pagamento' : 'Nova forma de pagamento'}</h2>
                  <p>Defina um nome e a natureza usada para classificar as despesas.</p>
                </div>
                <div className="payment-method-editor__grid">
                  <div className="payment-method-field">
                    <label htmlFor="payment-method-name">Nome *</label>
                    <input
                      id="payment-method-name"
                      value={editor.name}
                      onChange={(event) => setEditor({ ...editor, name: event.target.value })}
                      maxLength={100}
                      autoComplete="off"
                      required
                    />
                  </div>
                  <div className="payment-method-field">
                    <label htmlFor="payment-method-nature">Natureza *</label>
                    <select
                      id="payment-method-nature"
                      aria-describedby="payment-method-nature-hint"
                      value={editor.nature}
                      onChange={(event) => setEditor({ ...editor, nature: event.target.value as PaymentMethodNature })}
                      required
                    >
                      {paymentMethodNatures.map((nature) => <option key={nature.value} value={nature.value}>{nature.label}</option>)}
                      {(editor.nature === 'food_benefit' || editor.nature === 'meal_benefit') && (
                        <option value={editor.nature}>{getPaymentMethodNatureLabel(editor.nature)} (legado)</option>
                      )}
                    </select>
                    <small id="payment-method-nature-hint">{editor.nature === 'food_benefit' || editor.nature === 'meal_benefit' ? 'Esta forma mantém sua natureza histórica. Para novos cadastros de VA ou VR, use Cartão de benefícios (VA/VR).' : 'VA e VR usam um único saldo de benefícios, separado do dinheiro.'}</small>
                  </div>
                </div>
                <div className="payment-method-editor__actions">
                  <button className="payment-methods-secondary-button" type="button" onClick={() => setEditor(null)} disabled={isSaving}>Cancelar</button>
                  <button className="payment-methods-primary-button" type="submit" disabled={isSaving}>{isSaving ? 'Salvando…' : 'Salvar forma'}</button>
                </div>
              </form>
            )}

            {loadError && !isWalletLoading ? (
              <div className="payment-methods-state" role="alert">
                <span className="payment-methods-state__icon" aria-hidden="true">!</span>
                <h2>Não foi possível carregar</h2>
                <p>{loadError}</p>
                <button className="payment-methods-secondary-button" type="button" onClick={() => { setLoadError(''); setIsLoading(true); setReloadKey((previous) => previous + 1) }}>Tentar novamente</button>
              </div>
            ) : isLoading || isWalletLoading ? (
              <div className="payment-methods-loading" role="status">Carregando formas de pagamento…</div>
            ) : items.length === 0 ? (
              <div className="payment-methods-state">
                <span className="payment-methods-state__icon" aria-hidden="true">↘</span>
                <h2>Nenhuma forma cadastrada</h2>
                <p>Cadastre como você paga suas despesas, como cartão de crédito, Pix ou benefícios.</p>
                <button className="payment-methods-secondary-button" type="button" onClick={openCreate}>Cadastrar primeira forma</button>
              </div>
            ) : (
              <ul className="payment-method-list" aria-label="Formas de pagamento cadastradas">
                {items.map((method) => (
                  <li className={`payment-method-card${method.isActive ? '' : ' payment-method-card--inactive'}`} key={method.id}>
                    <div className="payment-method-card__main">
                      <span className="payment-method-card__marker" aria-hidden="true" />
                      <div>
                        <h2>{method.name}</h2>
                        <p>{getPaymentMethodNatureLabel(method.nature)}</p>
                      </div>
                    </div>
                    <div className="payment-method-card__actions">
                      <span className={`payment-method-status${method.isActive ? ' payment-method-status--active' : ''}`}>{method.isActive ? 'Ativa' : 'Inativa'}</span>
                      <button type="button" className="payment-method-text-action" onClick={() => openEdit(method)} disabled={isSaving} aria-label={`Editar ${method.name}`}>Editar</button>
                      <button
                        type="button"
                        className="payment-method-text-action"
                        onClick={() => void toggleActive(method)}
                        disabled={isSaving}
                        aria-label={`${method.isActive ? 'Desativar' : 'Ativar'} ${method.name}`}
                      >
                        {method.isActive ? 'Desativar' : 'Ativar'}
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
          <footer className="payment-methods-footer">
            <span>Saldo Certo · seu espaço de organização financeira</span>
            <span>As formas inativas permanecem no histórico das despesas.</span>
          </footer>
        </div>
      </main>
    </>
  )
}
