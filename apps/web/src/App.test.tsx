import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AuthApiError, authApi } from './authApi'
import { walletApi } from './wallets/walletApi'
import App from './App'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

describe('authentication forms', () => {
  beforeEach(() => {
    window.history.replaceState({}, '', '/login')
    vi.spyOn(authApi, 'me').mockRejectedValue(new AuthApiError('', 401))
    vi.spyOn(authApi, 'login').mockRejectedValue(new AuthApiError('', 401))
    vi.spyOn(authApi, 'register').mockResolvedValue({ message: 'Email enviado, favor confirmar seu cadastro' })
    vi.spyOn(authApi, 'verifyEmail').mockResolvedValue({ message: 'E-mail confirmado.' })
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('requires a valid email and password before login', async () => {
    const user = userEvent.setup()
    render(<App />)
    await screen.findByRole('heading', { name: 'Entre na sua conta' })

    const email = screen.getByLabelText('E-mail') as HTMLInputElement
    const password = screen.getByLabelText('Senha') as HTMLInputElement
    const form = screen.getByRole('button', { name: 'Entrar' }).closest('form')
    expect(form).not.toBeNull()
    expect(email).toBeRequired()
    expect(password).toBeRequired()
    expect(form).not.toBeValid()

    await user.type(email, 'invalido')
    await user.type(password, 'senha')
    expect(email).not.toBeValid()
    expect(form).not.toBeValid()
    expect(authApi.login).not.toHaveBeenCalled()
  })

  it('enforces password rules and submits registration through the mocked API', async () => {
    const user = userEvent.setup()
    window.history.replaceState({}, '', '/register')
    render(<App />)
    await screen.findByRole('heading', { name: 'Crie sua conta' })

    await user.type(screen.getByLabelText('E-mail'), 'tito@example.com')
    const password = screen.getByLabelText('Senha')
    fireEvent.change(password, { target: { value: 'weak' } })
    const form = screen.getByRole('button', { name: 'Criar conta' }).closest('form')
    expect(form).not.toBeNull()
    fireEvent.submit(form as HTMLFormElement)

    expect(await screen.findByRole('alert')).toHaveTextContent('A senha deve ter pelo menos 8 caracteres')
    expect(authApi.register).not.toHaveBeenCalled()
    expect(screen.getByText('Pelo menos 8 caracteres')).toBeVisible()

    const registrationRequest = deferred<{ message: string }>()
    vi.mocked(authApi.register).mockReturnValueOnce(registrationRequest.promise)
    fireEvent.change(password, { target: { value: 'SenhaForte1!' } })
    await user.click(screen.getByRole('button', { name: 'Criar conta' }))

    await waitFor(() => expect(authApi.register).toHaveBeenCalledWith('tito@example.com', 'SenhaForte1!'))
    expect(screen.getByRole('button', { name: 'Criando sua conta…' })).toBeVisible()
    registrationRequest.resolve({ message: 'Email enviado, favor confirmar seu cadastro' })
    expect(await screen.findByRole('status')).toHaveTextContent('Email enviado, favor confirmar seu cadastro')
  })

  it('shows a clear registration error from the mocked API', async () => {
    const user = userEvent.setup()
    window.history.replaceState({}, '', '/register')
    vi.mocked(authApi.register).mockRejectedValueOnce(new AuthApiError('Este e-mail já possui uma conta.', 409))
    render(<App />)
    await screen.findByRole('heading', { name: 'Crie sua conta' })

    await user.type(screen.getByLabelText('E-mail'), 'tito@example.com')
    await user.type(screen.getByLabelText('Senha'), 'SenhaForte1!')
    await user.click(screen.getByRole('button', { name: 'Criar conta' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Este e-mail já possui uma conta.')
  })

  it('shows the pending and authenticated states while logging in', async () => {
    const user = userEvent.setup()
    const loginRequest = deferred<{ user: { id: string; email: string } }>()
    vi.mocked(authApi.login).mockReturnValueOnce(loginRequest.promise)
    render(<App />)
    await screen.findByRole('heading', { name: 'Entre na sua conta' })

    await user.type(screen.getByLabelText('E-mail'), 'tito@example.com')
    await user.type(screen.getByLabelText('Senha'), 'SenhaForte1!')
    await user.click(screen.getByRole('button', { name: 'Entrar' }))

    expect(screen.getByRole('button', { name: 'Entrando…' })).toBeVisible()
    loginRequest.resolve({ user: { id: 'user-1', email: 'tito@example.com' } })
    expect(await screen.findByRole('heading', { name: 'Olá, que bom ter você por aqui.' })).toBeVisible()
    expect(screen.getByText('tito@example.com')).toBeVisible()
    expect(screen.getByRole('link', { name: /Abrir visão geral/ })).toBeVisible()
  })

  it('shows a clear login error from the mocked API', async () => {
    const user = userEvent.setup()
    vi.mocked(authApi.login).mockRejectedValueOnce(new AuthApiError('', 401))
    render(<App />)
    await screen.findByRole('heading', { name: 'Entre na sua conta' })

    await user.type(screen.getByLabelText('E-mail'), 'tito@example.com')
    await user.type(screen.getByLabelText('Senha'), 'SenhaForte1!')
    await user.click(screen.getByRole('button', { name: 'Entrar' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('E-mail ou senha inválidos')
  })

  it('shows the email confirmation loading and success states for the link token', async () => {
    const confirmationRequest = deferred<{ message: string }>()
    vi.mocked(authApi.verifyEmail).mockReturnValueOnce(confirmationRequest.promise)
    window.history.replaceState({}, '', '/verify-email?token=confirmation-token')
    render(<App />)

    expect(await screen.findByRole('heading', { name: 'Estamos confirmando seu e-mail.' })).toBeVisible()
    await waitFor(() => expect(authApi.verifyEmail).toHaveBeenCalledWith('confirmation-token'))
    confirmationRequest.resolve({ message: 'E-mail confirmado.' })

    expect(await screen.findByRole('heading', { name: 'Seu e-mail foi confirmado.' })).toBeVisible()
    expect(screen.getByRole('link', { name: 'Ir para o login' })).toBeVisible()
  })

  it('shows a recoverable error when email confirmation fails', async () => {
    vi.mocked(authApi.verifyEmail).mockRejectedValueOnce(new AuthApiError('', 400))
    window.history.replaceState({}, '', '/verify-email?token=expired-token')
    render(<App />)

    expect(await screen.findByRole('alert')).toHaveTextContent('Este link é inválido, expirou ou já foi utilizado')
    expect(screen.getByRole('heading', { name: 'Não foi possível confirmar.' })).toBeVisible()
    expect(authApi.verifyEmail).toHaveBeenCalledWith('expired-token')
  })

  it('propagates the invite token through signup and a separate email confirmation tab', async () => {
    const user = userEvent.setup()
    window.sessionStorage.clear()
    window.history.replaceState({}, '', '/register?invite=single-use-token')
    render(<App />)
    await screen.findByRole('heading', { name: 'Crie sua conta' })

    await user.type(screen.getByLabelText('E-mail'), 'guest@example.com')
    await user.type(screen.getByLabelText('Senha'), 'SenhaForte1!')
    await user.click(screen.getByRole('button', { name: 'Criar conta' }))

    expect(await screen.findByRole('status')).toHaveTextContent('volte a este convite')
    await waitFor(() => expect(authApi.register).toHaveBeenCalledWith('guest@example.com', 'SenhaForte1!', 'single-use-token'))
    expect(window.sessionStorage.getItem('saldocerto.pending-wallet-invite')).toBe('single-use-token')

    cleanup()
    window.sessionStorage.clear()
    window.history.replaceState({}, '', '/verify-email?token=email-confirmation-token&invite=single-use-token')
    render(<App />)
    expect(await screen.findByRole('heading', { name: 'Seu e-mail foi confirmado.' })).toBeVisible()
    expect(screen.getByRole('link', { name: 'Ir para o login' })).toHaveAttribute('href', '/login?invite=single-use-token')
  })
})

describe('authenticated financial routes', () => {
  beforeEach(() => {
    vi.stubGlobal('matchMedia', vi.fn((media: string) => ({
      matches: false,
      media,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })))
    vi.spyOn(authApi, 'me').mockResolvedValue({ user: { id: 'user-1', email: 'tito@example.com' } })
    vi.spyOn(walletApi, 'list').mockResolvedValue({
      items: [{ id: 'wallet-personal', name: 'Pessoal', isPersonal: true, role: 'owner' }],
    })
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    window.localStorage.clear()
  })

  it.each(['/categories', '/dashboard', '/incomes', '/expenses', '/goals'])(
    'loads the active wallet before rendering %s', async (path) => {
      window.history.replaceState({}, '', path)
      render(<App />)

      await waitFor(() => expect(walletApi.list).toHaveBeenCalledTimes(1))
      await waitFor(() => expect(window.localStorage.getItem('saldocerto.active-wallet.user-1')).toBe('wallet-personal'))
    },
  )
})

describe('wallet invitation routes', () => {
  beforeEach(() => {
    window.sessionStorage.clear()
    vi.spyOn(authApi, 'me').mockRejectedValue(new AuthApiError('', 401))
    vi.spyOn(walletApi, 'acceptInvitation').mockResolvedValue({
      wallet: { id: 'wallet-shared', name: 'Família', isPersonal: false, role: 'member' },
      message: 'Convite aceito.',
    })
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    window.localStorage.clear()
    window.sessionStorage.clear()
  })

  it('offers account login or registration without losing the invite token', async () => {
    window.history.replaceState({}, '', '/wallet-invite?token=invite-token')
    render(<App />)

    expect(await screen.findByRole('heading', { name: 'Entre ou crie uma conta para continuar.' })).toBeVisible()
    expect(screen.getByRole('link', { name: /Entrar para aceitar/ })).toHaveAttribute('href', '/login?invite=invite-token')
    expect(screen.getByRole('link', { name: 'Criar conta' })).toHaveAttribute('href', '/register?invite=invite-token')
  })

  it('accepts an invite for the authenticated account and remembers the shared wallet', async () => {
    const user = userEvent.setup()
    vi.mocked(authApi.me).mockResolvedValueOnce({ user: { id: 'user-2', email: 'guest@example.com' } })
    window.history.replaceState({}, '', '/wallet-invite?token=invite-token')
    render(<App />)

    await user.click(await screen.findByRole('button', { name: 'Aceitar convite' }))

    await waitFor(() => expect(walletApi.acceptInvitation).toHaveBeenCalledWith('invite-token'))
    expect(await screen.findByRole('status')).toHaveTextContent('Convite aceito.')
    expect(window.localStorage.getItem('saldocerto.active-wallet.user-2')).toBe('wallet-shared')
  })
})
