import { useState } from 'react'
import type { User } from '../authApi'
import { WalletApiError, walletApi, storePendingInviteToken, storeWalletId } from './walletApi'
import './WalletInvitationPage.css'

type WalletInvitationPageProps = {
  token: string | null
  user: User | null
}

function getErrorMessage(error: unknown) {
  if (error instanceof WalletApiError) {
    if (error.status === 401 || error.status === 403) return 'Entre na conta que recebeu este convite para continuar.'
    if (error.status === 404 || error.status === 410) return 'Este convite é inválido, expirou ou já foi cancelado.'
    if (error.status === 409) return 'Este convite já foi aceito ou sua conta já pertence a esta carteira.'
    if (error.message.trim()) return error.message
  }
  return 'Não foi possível aceitar o convite. Verifique sua conexão e tente novamente.'
}

export function WalletInvitationPage({ token, user }: WalletInvitationPageProps) {
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')

  const inviteQuery = token ? '?invite=' + encodeURIComponent(token) : ''

  async function handleAccept() {
    if (!token || !user) return
    setError('')
    setSuccess('')
    setIsSubmitting(true)
    try {
      const { wallet, message } = await walletApi.acceptInvitation(token)
      storeWalletId(user.id, wallet.id)
      storePendingInviteToken(null)
      setSuccess(message || 'Você agora tem acesso à carteira ' + wallet.name + '.')
    } catch (cause) {
      setError(getErrorMessage(cause))
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <main className="wallet-invitation-page">
      <a className="wallet-invitation-page__brand" href="/dashboard" aria-label="Saldo Certo">
        <span className="wallet-invitation-page__brand-mark" aria-hidden="true">SC</span>
        <span>saldo<span>certo</span></span>
      </a>
      <section className="wallet-invitation-card" aria-labelledby="wallet-invitation-title">
        {!token ? (
          <>
            <div className="wallet-invitation-card__icon" aria-hidden="true">!</div>
            <p className="wallet-invitation-card__eyebrow">CONVITE NÃO ENCONTRADO</p>
            <h1 id="wallet-invitation-title">Este link não contém um convite.</h1>
            <p>Peça à pessoa que administra a carteira para enviar um novo convite.</p>
            <a className="wallet-invitation-button wallet-invitation-button--secondary" href="/login">Ir para o login</a>
          </>
        ) : user ? (
          <>
            <div className="wallet-invitation-card__icon" aria-hidden="true">↗</div>
            <p className="wallet-invitation-card__eyebrow">CONVITE PARA CARTEIRA</p>
            <h1 id="wallet-invitation-title">Acesse uma carteira compartilhada.</h1>
            <p>Você está conectado como <strong>{user.email}</strong>. Ao aceitar, poderá consultar e registrar dados financeiros nessa carteira.</p>
            {error && <p className="wallet-invitation-alert" role="alert">{error}</p>}
            {success && <p className="wallet-invitation-success" role="status">{success}</p>}
            {success ? (
              <a className="wallet-invitation-button" href="/dashboard">Abrir carteira compartilhada <span aria-hidden="true">→</span></a>
            ) : (
              <button className="wallet-invitation-button" type="button" onClick={() => void handleAccept()} disabled={isSubmitting}>
                {isSubmitting ? 'Aceitando convite…' : 'Aceitar convite'} <span aria-hidden="true">→</span>
              </button>
            )}
            <a className="wallet-invitation-card__back" href="/dashboard">Voltar à minha carteira</a>
          </>
        ) : (
          <>
            <div className="wallet-invitation-card__icon" aria-hidden="true">↗</div>
            <p className="wallet-invitation-card__eyebrow">CONVITE PARA CARTEIRA</p>
            <h1 id="wallet-invitation-title">Entre ou crie uma conta para continuar.</h1>
            <p>Para proteger os dados financeiros, você precisa entrar com o e-mail que recebeu este convite. Se ainda não tem conta, crie uma e confirme seu e-mail antes de aceitar.</p>
            <a className="wallet-invitation-button" href={'/login' + inviteQuery}>Entrar para aceitar <span aria-hidden="true">→</span></a>
            <a className="wallet-invitation-button wallet-invitation-button--secondary" href={'/register' + inviteQuery}>Criar conta</a>
          </>
        )}
      </section>
      <footer className="wallet-invitation-footer">© 2026 Saldo Certo</footer>
    </main>
  )
}
