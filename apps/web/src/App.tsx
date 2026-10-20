import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { AuthApiError, authApi } from './authApi'
import type { User } from './authApi'
import { CategoriesPage } from './categories/CategoriesPage'
import { ExpensesPage } from './expenses/ExpensesPage'
import { PaymentMethodsPage } from './paymentMethods/PaymentMethodsPage'
import { IncomesPage } from './incomes/IncomesPage'
import { GoalsPage } from './goals/GoalsPage'
import { DashboardPage } from './dashboard/DashboardPage'
import { WalletProvider } from './wallets/WalletContext'
import { WalletInvitationPage } from './wallets/WalletInvitationPage'
import { WalletAccessRequestPage } from './wallets/WalletAccessRequestPage'
import { WalletSharingPage } from './wallets/WalletSharingPage'
import { getPendingInviteToken, storePendingInviteToken } from './wallets/walletApi'
import './App.css'

type Page = 'login' | 'register' | 'verify-email' | 'wallet-invite' | 'wallet-access-request' | 'wallet-sharing' | 'dashboard' | 'categories' | 'incomes' | 'expenses' | 'goals' | 'payment-methods'
const pendingVerifications = new Map<string, Promise<unknown>>()
const passwordPolicyMessage =
  'A senha deve ter pelo menos 8 caracteres, incluindo uma letra maiúscula, uma letra minúscula, um número e um caractere especial.'
const passwordRequirements = [
  {
    id: 'length',
    label: 'Pelo menos 8 caracteres',
    isSatisfied: (value: string) => [...value].length >= 8,
  },
  {
    id: 'uppercase',
    label: 'Uma letra maiúscula',
    isSatisfied: (value: string) => /\p{Lu}/u.test(value),
  },
  {
    id: 'lowercase',
    label: 'Uma letra minúscula',
    isSatisfied: (value: string) => /\p{Ll}/u.test(value),
  },
  {
    id: 'number',
    label: 'Um número',
    isSatisfied: (value: string) => /\p{N}/u.test(value),
  },
  {
    id: 'special-character',
    label: 'Um caractere especial',
    isSatisfied: (value: string) => /[\p{P}\p{S}]/u.test(value),
  },
] as const

function isPasswordPolicyValid(value: string) {
  return passwordRequirements.every((requirement) => requirement.isSatisfied(value))
}

function verifyEmailOnce(token: string) {
  let verificationRequest = pendingVerifications.get(token)
  if (!verificationRequest) {
    verificationRequest = authApi.verifyEmail(token)
    pendingVerifications.set(token, verificationRequest)
    void verificationRequest.then(
      () => pendingVerifications.delete(token),
      () => pendingVerifications.delete(token),
    )
  }
  return verificationRequest
}

function getPage(): Page {
  const path = window.location.pathname.replace(/\/$/, '')
  if (path.endsWith('/register')) return 'register'
  if (path.endsWith('/verify-email')) return 'verify-email'
  if (path.endsWith('/wallet-invite')) return 'wallet-invite'
  if (path.endsWith('/wallet-access-request')) return 'wallet-access-request'
  if (path.endsWith('/wallet-sharing')) return 'wallet-sharing'
  if (path.endsWith('/dashboard')) return 'dashboard'
  if (path.endsWith('/categories')) return 'categories'
  if (path.endsWith('/payment-methods')) return 'payment-methods'
  if (path.endsWith('/incomes')) return 'incomes'
  if (path.endsWith('/expenses')) return 'expenses'
  if (path.endsWith('/goals')) return 'goals'
  return 'login'
}

function getErrorMessage(error: unknown, action: Page | 'logout') {
  if (!(error instanceof AuthApiError)) {
    return 'Não foi possível conectar ao serviço. Verifique sua conexão e tente novamente.'
  }

  if (error.message.trim()) return error.message

  if (action === 'login') {
    if (error.status === 401 || error.status === 403) {
      return 'E-mail ou senha inválidos, ou sua conta ainda não foi confirmada.'
    }
    if (error.status === 400) return 'Confira o e-mail e a senha informados.'
  }

  if (action === 'register') {
    if (error.status === 409) return 'Este e-mail já possui uma conta.'
    if (error.status === 400) return 'Confira o e-mail e a senha informados.'
  }

  if (action === 'verify-email') {
    return 'Este link é inválido, expirou ou já foi utilizado. Solicite um novo link de confirmação.'
  }

  if (action === 'logout') return 'Não foi possível encerrar sua sessão. Tente novamente.'
  return 'Ocorreu um erro. Tente novamente.'
}

function App() {
  const page = getPage()
  const [verificationToken] = useState(() =>
    new URLSearchParams(window.location.search).get('token'),
  )
  const [emailVerificationInviteToken] = useState(() =>
    new URLSearchParams(window.location.search).get('invite'),
  )
  const invitationToken = new URLSearchParams(window.location.search).get('token')
  const accessRequestToken = new URLSearchParams(window.location.search).get('token')
  const requestedWalletId = page === 'wallet-sharing'
    ? new URLSearchParams(window.location.search).get('walletId')
    : null
  const pendingInviteToken = emailVerificationInviteToken || getPendingInviteToken()
  const [user, setUser] = useState<User | null>(null)
  const [checkingSession, setCheckingSession] = useState(true)
  const [sessionError, setSessionError] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [formError, setFormError] = useState('')
  const [formMessage, setFormMessage] = useState('')
  const [verification, setVerification] = useState<'loading' | 'success' | 'error'>('loading')

  useEffect(() => {
    const controller = new AbortController()
    authApi
      .me(controller.signal)
      .then((result) => {
        if (result) setUser(result.user)
      })
      .catch((error: unknown) => {
        if (error instanceof Error && error.name === 'AbortError') return
        if (error instanceof AuthApiError && (error.status === 401 || error.status === 403)) return
        setSessionError('Não foi possível verificar sua sessão. Você ainda pode entrar novamente.')
      })
      .finally(() => setCheckingSession(false))

    return () => controller.abort()
  }, [])

  useEffect(() => {
    if (page !== 'verify-email' || !verificationToken) return

    window.history.replaceState(null, '', window.location.pathname)
    let active = true
    verifyEmailOnce(verificationToken)
      .then(() => {
        if (active) setVerification('success')
      })
      .catch((error: unknown) => {
        if (!active) return
        setVerification('error')
        setFormError(getErrorMessage(error, 'verify-email'))
      })

    return () => {
      active = false
    }
  }, [page, verificationToken])

  async function handleLogin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setFormError('')
    setIsSubmitting(true)
    try {
      const response = await authApi.login(email.trim(), password)
      setUser(response.user)
      setPassword('')
      const token = new URLSearchParams(window.location.search).get('invite') || getPendingInviteToken()
      window.location.assign(token ? `/wallet-invite?token=${encodeURIComponent(token)}` : '/dashboard')
    } catch (error) {
      setFormError(getErrorMessage(error, 'login'))
    } finally {
      setIsSubmitting(false)
    }
  }

  async function handleRegister(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setFormError('')
    setFormMessage('')
    if (!isPasswordPolicyValid(password)) {
      setFormError(passwordPolicyMessage)
      return
    }

    setIsSubmitting(true)
    try {
      const inviteToken = new URLSearchParams(window.location.search).get('invite')
      if (inviteToken) storePendingInviteToken(inviteToken)
      const response = inviteToken
        ? await authApi.register(email.trim(), password, inviteToken)
        : await authApi.register(email.trim(), password)
      setFormMessage(inviteToken
        ? `${response.message || 'Email enviado, favor confirmar seu cadastro'} Depois de confirmar, volte a este convite, entre na sua conta e aceite o acesso.`
        : response.message || 'Email enviado, favor confirmar seu cadastro')
      setPassword('')
    } catch (error) {
      setFormError(getErrorMessage(error, 'register'))
    } finally {
      setIsSubmitting(false)
    }
  }

  async function handleLogout() {
    setFormError('')
    setIsSubmitting(true)
    try {
      await authApi.logout()
      setUser(null)
      window.location.assign('/login')
    } catch (error) {
      setFormError(getErrorMessage(error, 'logout'))
    } finally {
      setIsSubmitting(false)
    }
  }

  if (!checkingSession && user && page === 'categories') {
    return (
      <WalletProvider userId={user.id}>
        <CategoriesPage userEmail={user.email} isLoggingOut={isSubmitting} onLogout={handleLogout} />
      </WalletProvider>
    )
  }

  if (!checkingSession && user && page === 'dashboard') {
    return (
      <WalletProvider userId={user.id}>
        <DashboardPage userEmail={user.email} isLoggingOut={isSubmitting} onLogout={handleLogout} />
      </WalletProvider>
    )
  }

  if (!checkingSession && user && page === 'incomes') {
    return (
      <WalletProvider userId={user.id}>
        <IncomesPage userEmail={user.email} isLoggingOut={isSubmitting} onLogout={handleLogout} />
      </WalletProvider>
    )
  }

  if (!checkingSession && user && page === 'expenses') {
    return (
      <WalletProvider userId={user.id}>
        <ExpensesPage userEmail={user.email} isLoggingOut={isSubmitting} onLogout={handleLogout} />
      </WalletProvider>
    )
  }

  if (!checkingSession && user && page === 'payment-methods') {
    return (
      <WalletProvider userId={user.id}>
        <PaymentMethodsPage userEmail={user.email} isLoggingOut={isSubmitting} onLogout={handleLogout} />
      </WalletProvider>
    )
  }

  if (!checkingSession && user && page === 'goals') {
    return (
      <WalletProvider userId={user.id}>
        <GoalsPage userEmail={user.email} isLoggingOut={isSubmitting} onLogout={handleLogout} />
      </WalletProvider>
    )
  }

  if (!checkingSession && page === 'wallet-invite') {
    return <WalletInvitationPage token={invitationToken} user={user} />
  }

  if (!checkingSession && page === 'wallet-access-request') {
    return <WalletAccessRequestPage token={accessRequestToken} />
  }

  if (!checkingSession && user && page === 'wallet-sharing') {
    return (
      <WalletProvider userId={user.id} preferredWalletId={requestedWalletId}>
        <WalletSharingPage userEmail={user.email} isLoggingOut={isSubmitting} onLogout={handleLogout} />
      </WalletProvider>
    )
  }

  return (
    <main className="auth-page">
      <div className="auth-shell">
        <header className="topbar">
          <a className="brand" href="/" aria-label="Saldo Certo, página inicial">
            <span className="brand-mark" aria-hidden="true">SC</span>
            <span>saldo<span className="brand-light">certo</span></span>
          </a>
          {!user && page !== 'verify-email' && (
            <nav className="topbar-nav" aria-label="Acesso à conta">
              <a className={page === 'login' ? 'nav-link nav-link--active' : 'nav-link'} href="/login">
                Entrar
              </a>
              <a className="nav-cta" href="/register">Criar conta</a>
            </nav>
          )}
        </header>

        <div className="auth-layout">
          <section className="intro-panel" aria-label="Sobre o Saldo Certo">
            <div className="intro-copy">
              <span className="kicker"><span className="kicker-dot" /> SUAS FINANÇAS, EM EQUILÍBRIO</span>
              <h1>Mais clareza para cuidar do seu dinheiro.</h1>
              <p>Organize suas finanças com tranquilidade e acompanhe seus planos, um passo de cada vez.</p>
            </div>
            <div className="balance-art" aria-hidden="true">
              <div className="art-orbit art-orbit--outer" />
              <div className="art-orbit art-orbit--inner" />
              <div className="art-card art-card--back">
                <span className="art-mini-line" />
                <span className="art-mini-dot" />
                <span className="art-bar art-bar--one" />
                <span className="art-bar art-bar--two" />
                <span className="art-bar art-bar--three" />
                <span className="art-bar art-bar--four" />
              </div>
              <div className="art-card art-card--front">
                <span className="art-label">VISÃO DO MÊS</span>
                <span className="art-sparkle">✳</span>
                <span className="art-amount-line" />
                <span className="art-small-line" />
                <span className="art-chart"><i /><i /><i /><i /><i /><i /><i /></span>
              </div>
              <span className="art-leaf art-leaf--one" />
              <span className="art-leaf art-leaf--two" />
              <span className="art-sun" />
            </div>
            <p className="intro-footnote">Um dia de cada vez. Um objetivo de cada vez.</p>
          </section>

          <section className="form-panel" aria-label="Acesso à conta">
            {checkingSession && page !== 'verify-email' ? (
              <div className="loading-state" role="status" aria-live="polite">
                <span className="spinner" />
                Verificando sua sessão…
              </div>
            ) : page === 'verify-email' ? (
              <div className="session-card" aria-live="polite">
                {!verificationToken || verification === 'error' ? (
                  <>
                    <div className="error-icon" aria-hidden="true">!</div>
                    <p className="form-eyebrow">LINK NÃO VALIDADO</p>
                    <h2 id="form-title">Não foi possível confirmar.</h2>
                    <p className="alert alert--error" role="alert">
                      {verificationToken
                        ? formError
                        : 'O link não contém um token de confirmação.'}
                    </p>
                    <a className="button button--secondary" href={pendingInviteToken ? `/login?invite=${encodeURIComponent(pendingInviteToken)}` : '/login'}>Voltar para o login</a>
                  </>
                ) : verification === 'success' ? (
                  <>
                    <div className="success-icon" aria-hidden="true">✓</div>
                    <p className="form-eyebrow">TUDO CERTO</p>
                    <h2 id="form-title">Seu e-mail foi confirmado.</h2>
                    <p className="form-description">Agora você já pode entrar na sua conta.</p>
                    <a className="button" href={pendingInviteToken ? `/login?invite=${encodeURIComponent(pendingInviteToken)}` : '/login'}>Ir para o login</a>
                  </>
                ) : (
                  <>
                    <span className="spinner spinner--large" />
                    <p className="form-eyebrow">CONFIRMAÇÃO DE E-MAIL</p>
                    <h2 id="form-title">Estamos confirmando seu e-mail.</h2>
                    <p className="form-description">Isso deve levar só um instante.</p>
                  </>
                )}
              </div>
            ) : user ? (
              <div className="session-card">
                <div className="success-icon" aria-hidden="true">✓</div>
                <p className="form-eyebrow">SESSÃO ATIVA</p>
                <h2 id="form-title">Olá, que bom ter você por aqui.</h2>
                <p className="form-description">Você entrou como <strong>{user.email}</strong>.</p>
                {formError && <p className="alert alert--error" role="alert">{formError}</p>}
                <a className="button" href="/dashboard">Abrir visão geral <span aria-hidden="true">→</span></a>
                <button className="button button--secondary" type="button" onClick={handleLogout} disabled={isSubmitting}>
                  {isSubmitting ? 'Encerrando sessão…' : 'Sair da conta'}
                </button>
              </div>
            ) : (
              <>
                <div className="form-heading">
                  <p className="form-eyebrow">{page === 'register' ? 'COMECE POR AQUI' : 'BEM-VINDO DE VOLTA'}</p>
                  <h2 id="form-title">
                    {page === 'register'
                      ? 'Crie sua conta'
                      : page === 'categories'
                        ? 'Entre para acessar suas categorias'
                        : page === 'goals'
                          ? 'Entre para acessar suas metas'
                        : page === 'dashboard'
                          ? 'Entre para acessar sua visão geral'
                        : 'Entre na sua conta'}
                  </h2>
                  <p className="form-description">
                    {page === 'register'
                      ? 'Seus próximos passos financeiros começam aqui.'
                      : page === 'categories'
                        ? 'Acesse sua conta para organizar categorias e subcategorias.'
                        : page === 'goals'
                          ? 'Acesse sua conta para organizar suas metas de investimento.'
                        : page === 'dashboard'
                          ? 'Acesse sua conta para acompanhar seu fluxo financeiro e suas metas.'
                        : 'Acesse seu espaço para continuar de onde parou.'}
                  </p>
                </div>

                {sessionError && <p className="alert alert--info" role="status">{sessionError}</p>}
                {page === 'categories' && (
                  <p className="alert alert--info" role="status">Entre com sua conta para acessar suas categorias pessoais.</p>
                )}
                {page === 'goals' && (
                  <p className="alert alert--info" role="status">Entre com sua conta para acessar suas metas pessoais.</p>
                )}
                {page === 'dashboard' && (
                  <p className="alert alert--info" role="status">Entre com sua conta para visualizar seus dados financeiros pessoais.</p>
                )}
                {formError && <p className="alert alert--error" role="alert">{formError}</p>}
                {formMessage && <p className="alert alert--success" role="status">{formMessage}</p>}

                <form className="auth-form" onSubmit={page === 'register' ? handleRegister : handleLogin}>
                  <label htmlFor="email">E-mail</label>
                  <input
                    id="email"
                    name="email"
                    type="email"
                    autoComplete="email"
                    placeholder="voce@exemplo.com"
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                    required
                  />

                  <label htmlFor="password">Senha</label>
                  <input
                    id="password"
                    name="password"
                    type="password"
                    autoComplete={page === 'register' ? 'new-password' : 'current-password'}
                    placeholder="Digite sua senha"
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    minLength={page === 'register' ? 8 : 1}
                    maxLength={128}
                    aria-describedby={page === 'register' ? 'password-requirements' : undefined}
                    required
                  />
                  {page === 'register' && (
                    <ul className="password-requirements" id="password-requirements" aria-label="Requisitos da senha">
                      {passwordRequirements.map((requirement) => {
                        const isSatisfied = requirement.isSatisfied(password)
                        return (
                          <li
                            className={`password-requirement${isSatisfied ? ' password-requirement--satisfied' : ''}`}
                            key={requirement.id}
                          >
                            <span className="password-requirement__icon" aria-hidden="true">
                              {isSatisfied ? '✓' : '○'}
                            </span>
                            <span>{requirement.label}</span>
                          </li>
                        )
                      })}
                    </ul>
                  )}

                  <button className="button" type="submit" disabled={isSubmitting}>
                    {isSubmitting
                      ? page === 'register' ? 'Criando sua conta…' : 'Entrando…'
                      : page === 'register' ? 'Criar conta' : 'Entrar'}
                    {!isSubmitting && <span aria-hidden="true">→</span>}
                  </button>
                </form>

                <p className="switch-form">
                  {page === 'register' ? 'Já tem uma conta?' : 'Ainda não tem uma conta?'}{' '}
                  <a href={page === 'register'
                    ? new URLSearchParams(window.location.search).get('invite')
                      ? `/login?invite=${encodeURIComponent(new URLSearchParams(window.location.search).get('invite')!)}`
                      : '/login'
                    : '/register'}>
                    {page === 'register' ? 'Entrar' : 'Criar conta'}
                  </a>
                </p>
                {page === 'register' && (
                  <p className="privacy-note">Ao criar sua conta, você receberá um link para confirmar seu e-mail.</p>
                )}
              </>
            )}
          </section>
        </div>

        <footer className="page-footer">
          <span>© 2026 Saldo Certo</span>
          <span>Um jeito mais leve de organizar a vida financeira.</span>
        </footer>
      </div>
    </main>
  )
}

export default App
