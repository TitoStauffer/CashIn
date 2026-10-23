import { useState } from 'react'
import type { FormEvent } from 'react'
import { WalletApiError, walletApi } from './walletApi'
import './WalletInvitationPage.css'

type WalletAccessRequestPageProps = { token: string | null }

function getErrorMessage(error: unknown) {
  if (error instanceof WalletApiError) {
    if (error.status === 429) return 'Muitas tentativas. Aguarde um pouco e tente novamente.'
  }
  return 'Não foi possível enviar a solicitação. Verifique sua conexão e tente novamente.'
}

export function WalletAccessRequestPage({ token }: WalletAccessRequestPageProps) {
  const [email, setEmail] = useState('')
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [error, setError] = useState('')
  const [submitted, setSubmitted] = useState(false)

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!token) return
    setError('')
    setIsSubmitting(true)
    try {
      await walletApi.submitAccessRequest(token, email.trim())
      setSubmitted(true)
    } catch (cause) {
      setError(getErrorMessage(cause))
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <main className="wallet-invitation-page">
      <a className="wallet-invitation-page__brand" href="/" aria-label="Saldo Certo">
        <span className="wallet-invitation-page__brand-mark" aria-hidden="true">SC</span>
        <span>saldo<span>certo</span></span>
      </a>
      <section className="wallet-invitation-card" aria-labelledby="wallet-access-request-title">
        {!token ? (
          <>
            <div className="wallet-invitation-card__icon" aria-hidden="true">!</div>
            <p className="wallet-invitation-card__eyebrow">SOLICITAÇÃO DE ACESSO</p>
            <h1 id="wallet-access-request-title">Link incompleto.</h1>
            <p>Peça à pessoa que administra a carteira para compartilhar um link válido.</p>
          </>
        ) : submitted ? (
          <>
            <div className="wallet-invitation-card__icon" aria-hidden="true">✓</div>
            <p className="wallet-invitation-card__eyebrow">SOLICITAÇÃO ENVIADA</p>
            <h1 id="wallet-access-request-title">Recebemos sua solicitação.</h1>
            <p role="status">Se o link estiver válido, a solicitação será analisada por quem administra a carteira. Caso seja aprovada, você receberá um e-mail com os próximos passos.</p>
            <a className="wallet-invitation-button wallet-invitation-button--secondary" href="/login">Ir para o login</a>
          </>
        ) : (
          <>
            <div className="wallet-invitation-card__icon" aria-hidden="true">↗</div>
            <p className="wallet-invitation-card__eyebrow">CARTEIRA COMPARTILHADA</p>
            <h1 id="wallet-access-request-title">Solicite acesso.</h1>
            <p>Informe seu e-mail. A pessoa que administra a carteira poderá aprovar ou recusar o pedido. Nenhuma informação financeira será exibida antes da aprovação.</p>
            {error && <p className="wallet-invitation-alert" role="alert">{error}</p>}
            <form onSubmit={(event) => void handleSubmit(event)}>
              <label className="wallet-access-request-label" htmlFor="wallet-access-request-email">E-mail</label>
              <input className="wallet-access-request-input" id="wallet-access-request-email" type="email" autoComplete="email" maxLength={254} required value={email} onChange={(event) => setEmail(event.target.value)} placeholder="voce@exemplo.com" />
              <button className="wallet-invitation-button" type="submit" disabled={isSubmitting}>
                {isSubmitting ? 'Enviando solicitação…' : 'Solicitar acesso'}
              </button>
            </form>
          </>
        )}
      </section>
      <footer className="wallet-invitation-footer">© 2026 Saldo Certo</footer>
    </main>
  )
}
