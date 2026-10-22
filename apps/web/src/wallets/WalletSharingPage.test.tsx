import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WalletApiError, walletApi } from './walletApi'
import { WalletProvider } from './WalletContext'
import { WalletSharingPage } from './WalletSharingPage'

const ownerWallet = { id: 'wallet-owner', name: 'Casa', isPersonal: false, role: 'owner' as const }

function renderPage() {
  return render(
    <WalletProvider userId="user-owner">
      <WalletSharingPage userEmail="owner@example.com" isLoggingOut={false} onLogout={vi.fn()} />
    </WalletProvider>,
  )
}

describe('wallet sharing management', () => {
  beforeEach(() => {
    window.localStorage.clear()
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
    vi.spyOn(walletApi, 'list').mockResolvedValue({ items: [ownerWallet] })
    vi.spyOn(walletApi, 'listInvitations').mockResolvedValue({ items: [
      { id: 'invite-pending', email: 'guest@example.com', status: 'pending', expiresAt: '2026-10-30T12:00:00Z', createdAt: '2026-10-20T12:00:00Z' },
      { id: 'invite-old', email: 'old@example.com', status: 'cancelled', expiresAt: '2026-10-20T12:00:00Z', createdAt: '2026-10-10T12:00:00Z' },
    ] })
    vi.spyOn(walletApi, 'listMembers').mockResolvedValue({ items: [
      { id: 'owner-id', email: 'owner@example.com', role: 'owner', createdAt: '2026-10-01T12:00:00Z' },
      { id: 'member-id', email: 'member@example.com', role: 'member', createdAt: '2026-10-12T12:00:00Z' },
    ] })
    vi.spyOn(walletApi, 'listAccessRequests').mockResolvedValue({ items: [
      { id: 'request-pending', email: 'requester@example.com', status: 'pending', createdAt: '2026-10-20T12:00:00Z' },
      { id: 'request-old', email: 'old-requester@example.com', status: 'rejected', createdAt: '2026-10-19T12:00:00Z' },
      { id: 'request-approved', email: 'approved@example.com', status: 'approved', createdAt: '2026-10-18T12:00:00Z' },
      { id: 'request-cancelled', email: 'cancelled@example.com', status: 'cancelled', createdAt: '2026-10-17T12:00:00Z' },
      { id: 'request-expired', email: 'expired@example.com', status: 'expired', createdAt: '2026-10-16T12:00:00Z' },
      { id: 'request-accepted', email: 'accepted@example.com', status: 'accepted', createdAt: '2026-10-15T12:00:00Z' },
    ] })
    vi.spyOn(walletApi, 'createInvitation').mockResolvedValue({ invitation: { id: 'new-invite', email: 'new@example.com', status: 'pending', expiresAt: '2026-10-30T12:00:00Z', createdAt: '2026-10-20T12:00:00Z' }, message: 'Convite enviado.' })
    vi.spyOn(walletApi, 'cancelInvitation').mockResolvedValue(undefined)
    vi.spyOn(walletApi, 'removeMember').mockResolvedValue(undefined)
    vi.spyOn(walletApi, 'createAccessLink').mockResolvedValue({ link: { id: 'link-1', url: 'https://example.test/wallet-access-request?token=secret-token', expiresAt: '2026-10-27T12:00:00Z' } })
    vi.spyOn(walletApi, 'decideAccessRequest').mockResolvedValue(undefined)
    vi.spyOn(walletApi, 'cancelAccessRequest').mockResolvedValue(undefined)
    vi.spyOn(window, 'confirm').mockReturnValue(true)
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('invites by email and shows pending invites and members', async () => {
    const user = userEvent.setup()
    renderPage()

    expect(await screen.findByText('member@example.com')).toBeVisible()
    expect(screen.getByText('guest@example.com')).toBeVisible()
    expect(screen.getByText('old@example.com')).not.toBeVisible()

    await user.type(screen.getByLabelText('E-mail'), 'new@example.com')
    await user.click(screen.getByRole('button', { name: 'Enviar convite' }))

    await waitFor(() => expect(walletApi.createInvitation).toHaveBeenCalledWith('wallet-owner', 'new@example.com'))
    expect(await screen.findByRole('status')).toHaveTextContent('Convite enviado para new@example.com.')
    expect(walletApi.listInvitations).toHaveBeenCalledTimes(2)
  })

  it('lets the owner cancel a pending invitation and remove a member', async () => {
    const user = userEvent.setup()
    renderPage()
    await screen.findByText('guest@example.com')

    await user.click(screen.getByRole('button', { name: 'Cancelar' }))
    await waitFor(() => expect(walletApi.cancelInvitation).toHaveBeenCalledWith('wallet-owner', 'invite-pending'))
    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining('guest@example.com'))

    await user.click(screen.getByRole('button', { name: 'Remover' }))
    await waitFor(() => expect(walletApi.removeMember).toHaveBeenCalledWith('wallet-owner', 'member-id'))
    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining('member@example.com'))
  })

  it('shows the invitation history when expanded', async () => {
    const user = userEvent.setup()
    renderPage()

    await user.click(await screen.findByText('guest@example.com'))
    await user.click(screen.getByText('Histórico de convites'))

    expect(screen.getByText('old@example.com')).toBeVisible()
    expect(screen.getByText(/Cancelado · enviado em/)).toBeVisible()
  })

  it('does not cancel or remove when the owner declines the confirmation', async () => {
    const user = userEvent.setup()
    vi.mocked(window.confirm).mockReturnValue(false)
    renderPage()
    await screen.findByText('guest@example.com')

    await user.click(screen.getByRole('button', { name: 'Cancelar' }))
    await user.click(screen.getByRole('button', { name: 'Remover' }))

    expect(walletApi.cancelInvitation).not.toHaveBeenCalled()
    expect(walletApi.removeMember).not.toHaveBeenCalled()
  })

  it('reports a conflict when the invitation cannot be created', async () => {
    const user = userEvent.setup()
    vi.mocked(walletApi.createInvitation).mockRejectedValueOnce(new WalletApiError('Já existe convite.', 409))
    renderPage()
    await screen.findByText('guest@example.com')

    await user.type(screen.getByLabelText('E-mail'), 'guest@example.com')
    await user.click(screen.getByRole('button', { name: 'Enviar convite' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Já existe um convite pendente')
  })

  it('explains that a member cannot manage wallet invitations', async () => {
    vi.mocked(walletApi.list).mockResolvedValueOnce({
      items: [{ id: 'wallet-shared', name: 'Casa', isPersonal: false, role: 'member' }],
    })
    renderPage()

    expect(await screen.findByRole('heading', { name: 'Apenas o dono pode gerenciar o acesso' })).toBeVisible()
    expect(walletApi.listMembers).not.toHaveBeenCalled()
  })

  it('explains that personal wallets cannot be shared', async () => {
    vi.mocked(walletApi.list).mockResolvedValueOnce({
      items: [{ id: 'wallet-personal', name: 'Pessoal', isPersonal: true, role: 'owner' }],
    })
    renderPage()

    expect(await screen.findByRole('heading', { name: 'Escolha uma carteira compartilhada' })).toBeVisible()
    expect(walletApi.listMembers).not.toHaveBeenCalled()
  })

  it('shows a retry action when the invitation list fails to load', async () => {
    const user = userEvent.setup()
    vi.mocked(walletApi.listInvitations)
      .mockRejectedValueOnce(new WalletApiError('Falha de rede', 500))
      .mockResolvedValueOnce({ items: [] })
    renderPage()

    expect(await screen.findByRole('alert')).toHaveTextContent('Falha de rede')
    await user.click(screen.getByRole('button', { name: 'Tentar novamente' }))
    expect(await screen.findByText('Não há convites pendentes.')).toBeVisible()
  })

  it('creates and displays a shareable access request link', async () => {
    const user = userEvent.setup()
    renderPage()

    await user.click(await screen.findByRole('button', { name: 'Gerar link de acesso' }))

    expect(await screen.findByLabelText(/Link compartilhável/)).toHaveValue('https://example.test/wallet-access-request?token=secret-token')
    expect(walletApi.createAccessLink).toHaveBeenCalledWith('wallet-owner')
    expect(await screen.findByRole('status')).toHaveTextContent('Link de solicitação criado')
  })

  it('copies the generated link and shows the access request history', async () => {
    const user = userEvent.setup()
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    renderPage()

    await user.click(await screen.findByRole('button', { name: 'Gerar link de acesso' }))
    await user.click(await screen.findByRole('button', { name: 'Copiar link' }))
    expect(writeText).toHaveBeenCalledWith('https://example.test/wallet-access-request?token=secret-token')
    expect(await screen.findByRole('status')).toHaveTextContent('Link copiado')

    await user.click(screen.getByText('Histórico de solicitações'))
    expect(screen.getByText('old-requester@example.com')).toBeVisible()
    expect(screen.getByText(/Recusada · solicitada em/)).toBeVisible()
    expect(screen.getByText(/Aprovada · solicitada em/)).toBeVisible()
    expect(screen.getByText(/Cancelada · solicitada em/)).toBeVisible()
    expect(screen.getByText(/Expirada · solicitada em/)).toBeVisible()
    expect(screen.getByText(/Aceita · solicitada em/)).toBeVisible()
  })

  it('approves, rejects, and cancels pending access requests', async () => {
    const user = userEvent.setup()
    renderPage()

    expect(await screen.findByText('requester@example.com')).toBeVisible()
    await user.click(within(screen.getByText('requester@example.com').closest('li') as HTMLElement).getByRole('button', { name: 'Aprovar' }))
    await waitFor(() => expect(walletApi.decideAccessRequest).toHaveBeenCalledWith('wallet-owner', 'request-pending', 'approve'))

    await user.click(within(screen.getByText('requester@example.com').closest('li') as HTMLElement).getByRole('button', { name: 'Recusar' }))
    await waitFor(() => expect(walletApi.decideAccessRequest).toHaveBeenCalledWith('wallet-owner', 'request-pending', 'reject'))

    await user.click(within(screen.getByText('requester@example.com').closest('li') as HTMLElement).getByRole('button', { name: 'Cancelar pedido' }))
    await waitFor(() => expect(walletApi.cancelAccessRequest).toHaveBeenCalledWith('wallet-owner', 'request-pending'))
  })

  it('does not reject or cancel an access request when the owner declines confirmation', async () => {
    const user = userEvent.setup()
    vi.mocked(window.confirm).mockReturnValue(false)
    renderPage()
    const getRequestButton = (name: string) => within(screen.getByText('requester@example.com').closest('li') as HTMLElement).getByRole('button', { name })

    await screen.findByText('requester@example.com')
    await user.click(getRequestButton('Recusar'))
    await user.click(getRequestButton('Cancelar pedido'))

    expect(walletApi.decideAccessRequest).not.toHaveBeenCalled()
    expect(walletApi.cancelAccessRequest).not.toHaveBeenCalled()
  })

  it('allows generating a replacement link and explains clipboard errors', async () => {
    const user = userEvent.setup()
    vi.spyOn(walletApi, 'createAccessLink')
      .mockResolvedValueOnce({ link: { id: 'link-1', url: 'https://example.test/one', expiresAt: '2026-10-27T12:00:00Z' } })
      .mockResolvedValueOnce({ link: { id: 'link-2', url: 'https://example.test/two', expiresAt: '2026-10-27T12:00:00Z' } })
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: vi.fn().mockRejectedValue(new Error('blocked')) }, configurable: true })
    renderPage()

    await user.click(await screen.findByRole('button', { name: 'Gerar link de acesso' }))
    await user.click(screen.getByRole('button', { name: 'Gerar novo link' }))
    expect(await screen.findByLabelText(/Link compartilhável/)).toHaveValue('https://example.test/two')
    await user.click(screen.getByRole('button', { name: 'Copiar link' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Selecione e copie o link exibido')
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('identifies the pending invitation without claiming that an access link is being generated', async () => {
    let complete!: (response: Awaited<ReturnType<typeof walletApi.createInvitation>>) => void
    vi.mocked(walletApi.createInvitation).mockReturnValueOnce(new Promise((resolve) => { complete = resolve }))
    const user = userEvent.setup()
    renderPage()
    await screen.findByText('member@example.com')
    await user.type(screen.getByLabelText('E-mail'), 'new@example.com')
    await user.click(screen.getByRole('button', { name: 'Enviar convite' }))
    expect(screen.getByRole('note')).toHaveTextContent('Enviando o convite.')
    expect(screen.getByRole('button', { name: 'Gerar link de acesso' })).toBeDisabled()
    expect(screen.queryByRole('button', { name: 'Gerando link…' })).not.toBeInTheDocument()
    complete({ invitation: { id: 'new', email: 'new@example.com', status: 'pending', expiresAt: '2026-10-30T12:00:00Z', createdAt: '2026-10-20T12:00:00Z' }, message: 'Convite enviado.' })
    expect(await screen.findByRole('status')).toHaveTextContent('Convite enviado')
  })
})
