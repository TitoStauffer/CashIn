import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WalletInvitationPage } from './WalletInvitationPage'
import { getStoredWalletId, storePendingInviteToken, walletApi, WalletApiError } from './walletApi'

describe('wallet invitation flow', () => {
  beforeEach(() => {
    window.localStorage.clear()
    window.sessionStorage.clear()
    vi.spyOn(walletApi, 'acceptInvitation').mockResolvedValue({
      wallet: { id: 'wallet-shared', name: 'Casa', isPersonal: false, role: 'member' },
      message: 'Convite aceito.',
    })
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('preserves the invitation token when an unauthenticated recipient chooses login or registration', () => {
    render(<WalletInvitationPage token="invite-token" user={null} />)

    expect(screen.getByRole('link', { name: /Entrar para aceitar/ })).toHaveAttribute('href', '/login?invite=invite-token')
    expect(screen.getByRole('link', { name: 'Criar conta' })).toHaveAttribute('href', '/register?invite=invite-token')
  })

  it('accepts for the authenticated account and selects the shared wallet', async () => {
    const user = userEvent.setup()
    storePendingInviteToken('invite-token')
    render(<WalletInvitationPage token="invite-token" user={{ id: 'user-2', email: 'guest@example.com' }} />)

    await user.click(screen.getByRole('button', { name: 'Aceitar convite' }))

    await waitFor(() => expect(walletApi.acceptInvitation).toHaveBeenCalledWith('invite-token'))
    expect(await screen.findByRole('status')).toHaveTextContent('Convite aceito.')
    expect(getStoredWalletId('user-2')).toBe('wallet-shared')
    expect(window.sessionStorage.getItem('saldocerto.pending-wallet-invite')).toBeNull()
    expect(screen.getByRole('link', { name: /Abrir carteira compartilhada/ })).toHaveAttribute('href', '/dashboard')
  })

  it('explains when the invitation is expired or invalid', async () => {
    const user = userEvent.setup()
    vi.mocked(walletApi.acceptInvitation).mockRejectedValueOnce(new WalletApiError('', 410))
    render(<WalletInvitationPage token="expired-token" user={{ id: 'user-2', email: 'guest@example.com' }} />)

    await user.click(screen.getByRole('button', { name: 'Aceitar convite' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Este convite é inválido, expirou ou já foi cancelado.')
  })

  it('shows a recoverable state when the link does not include a token', () => {
    render(<WalletInvitationPage token={null} user={null} />)

    expect(screen.getByRole('heading', { name: 'Este link não contém um convite.' })).toBeVisible()
    expect(screen.getByRole('link', { name: 'Ir para o login' })).toHaveAttribute('href', '/login')
  })

  it('explains when the signed-in account does not match the invitation', async () => {
    const user = userEvent.setup()
    vi.mocked(walletApi.acceptInvitation).mockRejectedValueOnce(new WalletApiError('', 401))
    render(<WalletInvitationPage token="invite-token" user={{ id: 'user-2', email: 'other@example.com' }} />)

    await user.click(screen.getByRole('button', { name: 'Aceitar convite' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Entre na conta que recebeu este convite')
  })

  it('reports when an invitation has already been consumed', async () => {
    const user = userEvent.setup()
    vi.mocked(walletApi.acceptInvitation).mockRejectedValueOnce(new WalletApiError('', 409))
    render(<WalletInvitationPage token="invite-token" user={{ id: 'user-2', email: 'guest@example.com' }} />)

    await user.click(screen.getByRole('button', { name: 'Aceitar convite' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Este convite já foi aceito')
  })
})
