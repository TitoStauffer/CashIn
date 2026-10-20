import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WalletAccessRequestPage } from './WalletAccessRequestPage'
import { walletApi, WalletApiError } from './walletApi'

describe('wallet access request page', () => {
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('submits the email and token without disclosing wallet information', async () => {
    const user = userEvent.setup()
    vi.spyOn(walletApi, 'submitAccessRequest').mockResolvedValue({ message: 'Se aplicável, o pedido será encaminhado.' })
    render(<WalletAccessRequestPage token="access-token" />)

    expect(screen.getByText(/Nenhuma informação financeira será exibida antes da aprovação/)).toBeVisible()
    await user.type(screen.getByLabelText('E-mail'), 'person@example.com')
    await user.click(screen.getByRole('button', { name: 'Solicitar acesso' }))

    await waitFor(() => expect(walletApi.submitAccessRequest).toHaveBeenCalledWith('access-token', 'person@example.com'))
    expect(await screen.findByRole('heading', { name: 'Recebemos sua solicitação.' })).toBeVisible()
    expect(screen.getByText(/Se o link estiver válido/)).toBeVisible()
  })

  it('shows the same safe confirmation for any successful response', async () => {
    const user = userEvent.setup()
    vi.spyOn(walletApi, 'submitAccessRequest').mockResolvedValue({ message: 'Se aplicável, o pedido será encaminhado.' })
    render(<WalletAccessRequestPage token="invalid-or-valid-token" />)
    await user.type(screen.getByLabelText('E-mail'), 'person@example.com')
    await user.click(screen.getByRole('button', { name: 'Solicitar acesso' }))

    expect(await screen.findByRole('status')).toBeVisible()
  })

  it('reports temporary rate limiting', async () => {
    const user = userEvent.setup()
    vi.spyOn(walletApi, 'submitAccessRequest').mockRejectedValue(new WalletApiError('', 429))
    render(<WalletAccessRequestPage token="access-token" />)
    await user.type(screen.getByLabelText('E-mail'), 'person@example.com')
    await user.click(screen.getByRole('button', { name: 'Solicitar acesso' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Muitas tentativas')
  })

  it('shows a recoverable message when the request fails unexpectedly', async () => {
    const user = userEvent.setup()
    vi.spyOn(walletApi, 'submitAccessRequest').mockRejectedValue(new Error('network failure'))
    render(<WalletAccessRequestPage token="access-token" />)
    await user.type(screen.getByLabelText('E-mail'), 'person@example.com')
    await user.click(screen.getByRole('button', { name: 'Solicitar acesso' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Não foi possível enviar a solicitação')
  })

  it('explains when the shared link is missing', () => {
    render(<WalletAccessRequestPage token={null} />)
    expect(screen.getByRole('heading', { name: 'Link incompleto.' })).toBeVisible()
  })
})
