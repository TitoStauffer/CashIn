import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { FinancialSidebar } from '../layout/FinancialSidebar'
import { useWallet } from './useWallet'
import { WalletApiError, walletApi } from './walletApi'
import type { WalletAccessLink, WalletAccessRequest, WalletInvitation, WalletMember } from './walletApi'
import './WalletSharingPage.css'

type WalletSharingPageProps = {
  userEmail: string
  isLoggingOut: boolean
  onLogout: () => void
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(value))
}

function getErrorMessage(error: unknown, action: 'load' | 'invite' | 'cancel' | 'remove') {
  if (error instanceof WalletApiError) {
    if (error.status === 401 || error.status === 403) {
      window.location.assign('/login')
      return 'Sua sessão expirou. Entre novamente para continuar.'
    }
    if (error.status === 409) return 'Já existe um convite pendente ou este usuário já faz parte da carteira.'
    if (error.status === 404) return 'Este convite, membro ou carteira não está mais disponível.'
    if (error.message.trim()) return error.message
  }
  return action === 'load'
    ? 'Não foi possível carregar o compartilhamento da carteira. Tente novamente.'
    : 'Não foi possível concluir a operação. Tente novamente.'
}

export function WalletSharingPage({ userEmail, isLoggingOut, onLogout }: WalletSharingPageProps) {
  const { activeWallet, activeWalletId } = useWallet()
  const canManage = activeWallet?.role === 'owner' && !activeWallet.isPersonal
  const [invitations, setInvitations] = useState<WalletInvitation[]>([])
  const [members, setMembers] = useState<WalletMember[]>([])
  const [accessRequests, setAccessRequests] = useState<WalletAccessRequest[]>([])
  const [accessLink, setAccessLink] = useState<{ walletId: string; link: WalletAccessLink } | null>(null)
  const [email, setEmail] = useState('')
  const [isLoading, setIsLoading] = useState(true)
  const [loadedWalletId, setLoadedWalletId] = useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [reloadKey, setReloadKey] = useState(0)

  useEffect(() => {
    const walletId = activeWalletId
    if (!walletId || !canManage) return
    const controller = new AbortController()
    Promise.all([
      walletApi.listInvitations(walletId, controller.signal),
      walletApi.listMembers(walletId, controller.signal),
      walletApi.listAccessRequests(walletId, controller.signal),
    ])
      .then(([invitationResponse, memberResponse, accessRequestResponse]) => {
        setInvitations(invitationResponse.items)
        setMembers(memberResponse.items)
        setAccessRequests(accessRequestResponse.items)
        setLoadedWalletId(walletId)
        setError('')
      })
      .catch((cause: unknown) => {
        if (cause instanceof Error && cause.name === 'AbortError') return
        setLoadedWalletId(walletId)
        setError(getErrorMessage(cause, 'load'))
      })
      .finally(() => {
        if (!controller.signal.aborted) setIsLoading(false)
      })
    return () => controller.abort()
  }, [activeWalletId, canManage, reloadKey])

  const isWalletLoading = loadedWalletId !== activeWalletId

  async function reload() {
    setIsLoading(true)
    setError('')
    setReloadKey((current) => current + 1)
  }

  async function handleInvite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError('')
    setMessage('')
    const invitedEmail = email.trim()
    if (!invitedEmail) {
      setError('Informe o e-mail de quem deseja convidar.')
      return
    }

    setIsSubmitting(true)
    try {
      if (!activeWalletId) throw new Error('Nenhuma carteira está selecionada.')
      await walletApi.createInvitation(activeWalletId, invitedEmail)
      setEmail('')
      setMessage(`Convite enviado para ${invitedEmail}.`)
      setReloadKey((current) => current + 1)
    } catch (cause) {
      setError(getErrorMessage(cause, 'invite'))
    } finally {
      setIsSubmitting(false)
    }
  }

  async function handleCancel(invitation: WalletInvitation) {
    if (!window.confirm(`Cancelar o convite enviado para ${invitation.email}?`)) return
    setError('')
    setMessage('')
    setIsSubmitting(true)
    try {
      if (!activeWalletId) throw new Error('Nenhuma carteira está selecionada.')
      await walletApi.cancelInvitation(activeWalletId, invitation.id)
      setMessage(`Convite de ${invitation.email} cancelado.`)
      setReloadKey((current) => current + 1)
    } catch (cause) {
      setError(getErrorMessage(cause, 'cancel'))
    } finally {
      setIsSubmitting(false)
    }
  }

  async function handleRemove(member: WalletMember) {
    if (!window.confirm(`Remover ${member.email} da carteira? Essa pessoa perderá acesso aos dados compartilhados.`)) return
    setError('')
    setMessage('')
    setIsSubmitting(true)
    try {
      if (!activeWalletId) throw new Error('Nenhuma carteira está selecionada.')
      await walletApi.removeMember(activeWalletId, member.id)
      setMessage(`${member.email} removido da carteira.`)
      setReloadKey((current) => current + 1)
    } catch (cause) {
      setError(getErrorMessage(cause, 'remove'))
    } finally {
      setIsSubmitting(false)
    }
  }

  async function handleCreateAccessLink() {
    setError('')
    setMessage('')
    setIsSubmitting(true)
    try {
      if (!activeWalletId) throw new Error('Nenhuma carteira está selecionada.')
      const response = await walletApi.createAccessLink(activeWalletId)
      setAccessLink({ walletId: activeWalletId, link: response.link })
      setMessage('Link de solicitação criado. Compartilhe-o com quem deseja pedir acesso.')
    } catch (cause) {
      setError(getErrorMessage(cause, 'invite'))
    } finally {
      setIsSubmitting(false)
    }
  }

  async function handleCopyAccessLink() {
    if (!accessLink || accessLink.walletId !== activeWalletId) return
    try {
      await navigator.clipboard.writeText(accessLink.link.url)
      setMessage('Link copiado. Compartilhe-o com quem deseja pedir acesso.')
    } catch {
      setError('Não foi possível copiar automaticamente. Selecione e copie o link exibido.')
    }
  }

  async function handleDecideAccessRequest(request: WalletAccessRequest, decision: 'approve' | 'reject') {
    if (decision === 'reject' && !window.confirm(`Recusar a solicitação de ${request.email}?`)) return
    setError('')
    setMessage('')
    setIsSubmitting(true)
    try {
      if (!activeWalletId) throw new Error('Nenhuma carteira está selecionada.')
      await walletApi.decideAccessRequest(activeWalletId, request.id, decision)
      setMessage(decision === 'approve'
        ? `Solicitação de ${request.email} aprovada. Um convite foi enviado por e-mail.`
        : `Solicitação de ${request.email} recusada.`)
      setReloadKey((current) => current + 1)
    } catch (cause) {
      setError(getErrorMessage(cause, 'cancel'))
    } finally {
      setIsSubmitting(false)
    }
  }

  async function handleCancelAccessRequest(request: WalletAccessRequest) {
    if (!window.confirm(`Cancelar a solicitação de ${request.email}?`)) return
    setError('')
    setMessage('')
    setIsSubmitting(true)
    try {
      if (!activeWalletId) throw new Error('Nenhuma carteira está selecionada.')
      await walletApi.cancelAccessRequest(activeWalletId, request.id)
      setMessage(`Solicitação de ${request.email} cancelada.`)
      setReloadKey((current) => current + 1)
    } catch (cause) {
      setError(getErrorMessage(cause, 'cancel'))
    } finally {
      setIsSubmitting(false)
    }
  }

  const pendingInvitations = invitations.filter((invitation) => invitation.status === 'pending')
  const otherInvitations = invitations.filter((invitation) => invitation.status !== 'pending')
  const pendingAccessRequests = accessRequests.filter((request) => request.status === 'pending')
  const otherAccessRequests = accessRequests.filter((request) => request.status !== 'pending')
  const activeAccessLink = accessLink?.walletId === activeWalletId ? accessLink.link : null
  return (
    <>
      <FinancialSidebar activePage="wallet-sharing" userEmail={userEmail} isLoggingOut={isLoggingOut} onLogout={onLogout} />
      <main className="wallet-sharing-page">
        <div className="wallet-sharing-page__content">
          <header className="wallet-sharing-page__heading">
            <div>
              <p className="wallet-sharing-page__eyebrow">CARTEIRA COMPARTILHADA</p>
              <h1>Gerenciar acesso</h1>
              <p>Convide pessoas para consultar e registrar dados em <strong>{activeWallet?.name ?? 'sua carteira'}</strong>.</p>
            </div>
          </header>

          {error && <p className="wallet-sharing-alert wallet-sharing-alert--error" role="alert">{error}</p>}
          {message && <p className="wallet-sharing-alert wallet-sharing-alert--success" role="status">{message}</p>}

          {!canManage ? (
            <section className="wallet-sharing-state" role="alert">
              <h2>{activeWallet?.isPersonal ? 'Escolha uma carteira compartilhada' : 'Apenas o dono pode gerenciar o acesso'}</h2>
              <p>{activeWallet?.isPersonal
                ? 'Convites e membros ficam disponíveis nas carteiras compartilhadas. Crie uma nova carteira no menu lateral ou selecione uma que você administra.'
                : 'Você pode consultar e registrar os dados financeiros desta carteira, mas não pode administrar seus membros.'}</p>
            </section>
          ) : (
            <>
              <section className="wallet-sharing-card" aria-labelledby="wallet-access-link-heading">
                <div className="wallet-sharing-card__heading">
                  <div><h2 id="wallet-access-link-heading">Compartilhar link de solicitação</h2><p>Qualquer pessoa com o link pode pedir acesso. Nenhum dado financeiro é exibido antes da sua aprovação.</p></div>
                </div>
                <button className="wallet-sharing-primary" type="button" onClick={() => void handleCreateAccessLink()} disabled={isSubmitting}>
                  {isSubmitting ? 'Gerando link…' : activeAccessLink ? 'Gerar novo link' : 'Gerar link de acesso'}
                </button>
                {activeAccessLink && <div className="wallet-sharing-access-link">
                  <label htmlFor="wallet-access-link-url">Link compartilhável · expira em {formatDate(activeAccessLink.expiresAt)}</label>
                  <div className="wallet-sharing-invite-form__row">
                    <input id="wallet-access-link-url" type="url" value={activeAccessLink.url} readOnly onFocus={(event) => event.currentTarget.select()} />
                    <button className="wallet-sharing-secondary" type="button" onClick={() => void handleCopyAccessLink()}>Copiar link</button>
                  </div>
                </div>}
              </section>

              <section className="wallet-sharing-card" aria-labelledby="wallet-invite-heading">
                <div className="wallet-sharing-card__heading">
                  <div><h2 id="wallet-invite-heading">Convidar por e-mail</h2><p>A pessoa precisará confirmar o e-mail e aceitar o convite antes de acessar a carteira.</p></div>
                </div>
                <form className="wallet-sharing-invite-form" onSubmit={(event) => void handleInvite(event)}>
                  <label htmlFor="wallet-invite-email">E-mail</label>
                  <div className="wallet-sharing-invite-form__row">
                    <input id="wallet-invite-email" type="email" autoComplete="email" maxLength={254} value={email} onChange={(event) => setEmail(event.target.value)} placeholder="pessoa@exemplo.com" required />
                    <button className="wallet-sharing-primary" type="submit" disabled={isSubmitting}>{isSubmitting ? 'Enviando…' : 'Enviar convite'}</button>
                  </div>
                </form>
              </section>

              {isLoading || isWalletLoading ? (
                <div className="wallet-sharing-loading" role="status">Carregando acessos…</div>
              ) : (
                <>
                  <section className="wallet-sharing-card" aria-labelledby="wallet-members-heading">
                    <div className="wallet-sharing-card__heading">
                      <div><h2 id="wallet-members-heading">Membros</h2><p>Os membros podem consultar e registrar dados financeiros. Apenas você pode administrar o acesso.</p></div>
                      <span className="wallet-sharing-count">{members.length}</span>
                    </div>
                    {members.length === 0 ? <p className="wallet-sharing-empty">Nenhum membro cadastrado.</p> : (
                      <ul className="wallet-sharing-list">
                        {members.map((member) => (
                          <li className="wallet-sharing-list__item" key={member.id}>
                            <div><strong>{member.email}</strong><span>{member.role === 'owner' ? 'Dono da carteira' : 'Membro'} · desde {formatDate(member.createdAt)}</span></div>
                            {member.role !== 'owner' && <button type="button" className="wallet-sharing-text-action wallet-sharing-text-action--danger" onClick={() => void handleRemove(member)} disabled={isSubmitting}>Remover</button>}
                          </li>
                        ))}
                      </ul>
                    )}
                  </section>

                  <section className="wallet-sharing-card" aria-labelledby="wallet-access-requests-heading">
                    <div className="wallet-sharing-card__heading">
                      <div><h2 id="wallet-access-requests-heading">Solicitações de acesso</h2><p>Ao aprovar, a pessoa receberá um convite por e-mail e precisará confirmar a conta antes de acessar os dados.</p></div>
                      <span className="wallet-sharing-count">{pendingAccessRequests.length}</span>
                    </div>
                    {pendingAccessRequests.length === 0 ? <p className="wallet-sharing-empty">Não há solicitações pendentes.</p> : (
                      <ul className="wallet-sharing-list">
                        {pendingAccessRequests.map((request) => (
                          <li className="wallet-sharing-list__item" key={request.id}>
                            <div><strong>{request.email}</strong><span>Solicitado em {formatDate(request.createdAt)}</span></div>
                            <div className="wallet-sharing-request-actions">
                              <button type="button" className="wallet-sharing-text-action" onClick={() => void handleDecideAccessRequest(request, 'approve')} disabled={isSubmitting}>Aprovar</button>
                              <button type="button" className="wallet-sharing-text-action wallet-sharing-text-action--danger" onClick={() => void handleDecideAccessRequest(request, 'reject')} disabled={isSubmitting}>Recusar</button>
                              <button type="button" className="wallet-sharing-text-action wallet-sharing-text-action--danger" onClick={() => void handleCancelAccessRequest(request)} disabled={isSubmitting}>Cancelar pedido</button>
                            </div>
                          </li>
                        ))}
                      </ul>
                    )}
                    {otherAccessRequests.length > 0 && <details className="wallet-sharing-history">
                      <summary>Histórico de solicitações</summary>
                      <ul className="wallet-sharing-list">
                        {otherAccessRequests.map((request) => (
                          <li className="wallet-sharing-list__item" key={request.id}>
                            <div><strong>{request.email}</strong><span>{formatAccessRequestStatus(request.status)} · solicitada em {formatDate(request.createdAt)}</span></div>
                          </li>
                        ))}
                      </ul>
                    </details>}
                  </section>

                  <section className="wallet-sharing-card" aria-labelledby="wallet-pending-heading">
                    <div className="wallet-sharing-card__heading">
                      <div><h2 id="wallet-pending-heading">Convites pendentes</h2><p>Os convites expiram na data indicada.</p></div>
                      <span className="wallet-sharing-count">{pendingInvitations.length}</span>
                    </div>
                    {pendingInvitations.length === 0 ? <p className="wallet-sharing-empty">Não há convites pendentes.</p> : (
                      <ul className="wallet-sharing-list">
                        {pendingInvitations.map((invitation) => (
                          <li className="wallet-sharing-list__item" key={invitation.id}>
                            <div><strong>{invitation.email}</strong><span>Enviado em {formatDate(invitation.createdAt)} · expira em {formatDate(invitation.expiresAt)}</span></div>
                            <button type="button" className="wallet-sharing-text-action wallet-sharing-text-action--danger" onClick={() => void handleCancel(invitation)} disabled={isSubmitting}>Cancelar</button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </section>

                  {otherInvitations.length > 0 && (
                    <details className="wallet-sharing-history">
                      <summary>Histórico de convites</summary>
                      <ul className="wallet-sharing-list">
                        {otherInvitations.map((invitation) => (
                          <li className="wallet-sharing-list__item" key={invitation.id}>
                            <div><strong>{invitation.email}</strong><span>{formatInvitationStatus(invitation.status)} · enviado em {formatDate(invitation.createdAt)}</span></div>
                          </li>
                        ))}
                      </ul>
                    </details>
                  )}
                </>
              )}
            </>
          )}
          {!isLoading && error && <button type="button" className="wallet-sharing-secondary" onClick={() => void reload()}>Tentar novamente</button>}
        </div>
      </main>
    </>
  )
}

function formatInvitationStatus(status: WalletInvitation['status']) {
  if (status === 'accepted') return 'Aceito'
  if (status === 'cancelled') return 'Cancelado'
  if (status === 'expired') return 'Expirado'
  return 'Pendente'
}

function formatAccessRequestStatus(status: WalletAccessRequest['status']) {
  if (status === 'approved') return 'Aprovada'
  if (status === 'rejected') return 'Recusada'
  if (status === 'cancelled') return 'Cancelada'
  if (status === 'expired') return 'Expirada'
  if (status === 'accepted') return 'Aceita'
  return 'Pendente'
}
