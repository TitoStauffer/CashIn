import { act, fireEvent, render, screen } from '@testing-library/react-native'
import { Alert } from 'react-native'

import { ApiError } from '../api/client'
import type { Wallet, WalletApi } from '../wallets/walletApi'
import { NOT_OWNER_MESSAGE, WalletSharingScreen } from './WalletSharingScreen'

const HOUSE: Wallet = { id: 'house', name: 'Casa', isPersonal: false, role: 'owner' }

function fakeWalletApi(overrides: Partial<WalletApi> = {}): WalletApi {
  return {
    listMembers: jest.fn(async () => ({ items: [
      { id: 'owner-1', email: 'dona@example.com', role: 'owner', createdAt: '2026-11-01T00:00:00Z' },
      { id: 'member-2', email: 'membro@example.com', role: 'member', createdAt: '2026-11-02T00:00:00Z' },
    ] })),
    listInvitations: jest.fn(async () => ({ items: [
      { id: 'inv-1', email: 'convidada@example.com', status: 'pending', expiresAt: '2026-11-24T00:00:00Z', createdAt: '2026-11-17T00:00:00Z' },
      { id: 'inv-2', email: 'antiga@example.com', status: 'expired', expiresAt: '2026-11-01T00:00:00Z', createdAt: '2026-10-25T00:00:00Z' },
    ] })),
    listAccessRequests: jest.fn(async () => ({ items: [
      { id: 'req-1', email: 'pedido@example.com', status: 'pending', createdAt: '2026-11-17T00:00:00Z' },
    ] })),
    invite: jest.fn(async () => ({ invitation: { id: 'inv-3', email: 'nova@example.com', status: 'pending', expiresAt: '', createdAt: '' }, message: 'Convite registrado. O e-mail será enviado em instantes.' })),
    cancelInvitation: jest.fn(async () => undefined),
    removeMember: jest.fn(async () => undefined),
    createAccessLink: jest.fn(async () => ({ link: { id: 'link-1', url: 'https://app.example/wallet-access?token=abc', expiresAt: '2026-11-24T00:00:00Z' } })),
    approveAccessRequest: jest.fn(async () => ({ message: 'Solicitação aprovada. Um convite de aceite será enviado ao e-mail informado.' })),
    rejectAccessRequest: jest.fn(async () => ({ message: 'Solicitação recusada.' })),
    cancelAccessRequest: jest.fn(async () => undefined),
    ...overrides,
  } as unknown as WalletApi
}

async function mount(walletApi = fakeWalletApi(), wallet: Wallet = HOUSE) {
  const onShareLink = jest.fn(async () => undefined)
  await render(<WalletSharingScreen wallet={wallet} walletApi={walletApi} onShareLink={onShareLink} />)
  return { walletApi, onShareLink }
}

describe('WalletSharingScreen', () => {
  it('refuses to manage a wallet the person does not own, without asking the API', async () => {
    const walletApi = fakeWalletApi()
    await mount(walletApi, { ...HOUSE, role: 'member' })
    expect(screen.getByText(NOT_OWNER_MESSAGE)).toBeTruthy()
    expect(walletApi.listMembers).not.toHaveBeenCalled()
  })

  it('lists members, pending invitations and pending access requests', async () => {
    await mount()
    expect(await screen.findByText('membro@example.com')).toBeTruthy()
    expect(screen.getByText('convidada@example.com')).toBeTruthy()
    expect(screen.queryByText('antiga@example.com')).toBeNull()
    expect(screen.getByText('pedido@example.com')).toBeTruthy()
    // The owner cannot be removed through this screen.
    expect(screen.queryByRole('link', { name: 'Remover dona@example.com' })).toBeNull()
  })

  it('invites by e-mail, shows the API message and reads the lists again', async () => {
    const { walletApi } = await mount()
    await screen.findByText('membro@example.com')
    await fireEvent.changeText(screen.getByLabelText('E-mail para convidar'), ' nova@example.com ')
    await fireEvent.press(screen.getByRole('button', { name: 'Enviar convite' }))
    expect(await screen.findByText('Convite registrado. O e-mail será enviado em instantes.')).toBeTruthy()
    expect(walletApi.invite).toHaveBeenCalledWith('house', 'nova@example.com')
    expect(walletApi.listInvitations).toHaveBeenCalledTimes(2)
  })

  it('asks for an e-mail and shows an API refusal in Portuguese', async () => {
    const walletApi = fakeWalletApi({ invite: jest.fn(async () => { throw new ApiError('Muitos convites enviados. Aguarde alguns minutos e tente novamente.', 429) }) })
    await mount(walletApi)
    await screen.findByText('membro@example.com')
    await fireEvent.press(screen.getByRole('button', { name: 'Enviar convite' }))
    expect(await screen.findByText('Informe o e-mail da pessoa.')).toBeTruthy()
    expect(walletApi.invite).not.toHaveBeenCalled()

    await fireEvent.changeText(screen.getByLabelText('E-mail para convidar'), 'nova@example.com')
    await fireEvent.press(screen.getByRole('button', { name: 'Enviar convite' }))
    expect(await screen.findByText('Muitos convites enviados. Aguarde alguns minutos e tente novamente.')).toBeTruthy()
  })

  it('cancels a pending invitation', async () => {
    const { walletApi } = await mount()
    await screen.findByText('convidada@example.com')
    await fireEvent.press(screen.getByRole('link', { name: 'Cancelar convite de convidada@example.com' }))
    expect(walletApi.cancelInvitation).toHaveBeenCalledWith('house', 'inv-1')
  })

  it('removes a member only after confirmation', async () => {
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined)
    const { walletApi } = await mount()
    await screen.findByText('membro@example.com')
    await fireEvent.press(screen.getByRole('link', { name: 'Remover membro@example.com' }))
    expect(walletApi.removeMember).not.toHaveBeenCalled()

    const buttons = alert.mock.calls[0]?.[2] ?? []
    const remove = buttons.find((button) => button.text === 'Remover')
    await act(async () => { remove?.onPress?.() })
    expect(walletApi.removeMember).toHaveBeenCalledWith('house', 'member-2')
    alert.mockRestore()
  })

  it('approves and refuses access requests with the API message', async () => {
    const { walletApi } = await mount()
    await screen.findByText('pedido@example.com')
    await fireEvent.press(screen.getByRole('link', { name: 'Aprovar pedido@example.com' }))
    expect(await screen.findByText('Solicitação aprovada. Um convite de aceite será enviado ao e-mail informado.')).toBeTruthy()
    expect(walletApi.approveAccessRequest).toHaveBeenCalledWith('house', 'req-1')

    await fireEvent.press(screen.getByRole('link', { name: 'Recusar pedido@example.com' }))
    expect(await screen.findByText('Solicitação recusada.')).toBeTruthy()
    expect(walletApi.rejectAccessRequest).toHaveBeenCalledWith('house', 'req-1')
  })

  it('generates the access link and opens the share sheet with it', async () => {
    const { walletApi, onShareLink } = await mount()
    await screen.findByText('membro@example.com')
    await fireEvent.press(screen.getByRole('button', { name: 'Gerar link de acesso' }))
    expect(await screen.findByText('https://app.example/wallet-access?token=abc')).toBeTruthy()
    expect(walletApi.createAccessLink).toHaveBeenCalledWith('house')
    await fireEvent.press(screen.getByRole('link', { name: 'Compartilhar link' }))
    expect(onShareLink).toHaveBeenCalledWith('https://app.example/wallet-access?token=abc')
  })

  it('shows a retryable error when the sharing cannot be loaded', async () => {
    const listMembers = jest.fn()
      .mockRejectedValueOnce(new ApiError('Carteira não encontrada.', 404))
      .mockResolvedValue({ items: [] })
    await mount(fakeWalletApi({ listMembers }))
    expect(await screen.findByText('Carteira não encontrada.')).toBeTruthy()
    await fireEvent.press(screen.getByRole('button', { name: 'Tentar novamente' }))
    expect(await screen.findByText('pedido@example.com')).toBeTruthy()
    expect(listMembers).toHaveBeenCalledTimes(2)
  })

  // Code Review of PR #122: a failed re-read after an action used to leave the old lists on screen
  // without any sign that they might be stale.
  it('says so when the lists cannot be read again after an action, and clears it once they are', async () => {
    const listInvitations = jest.fn()
      .mockResolvedValueOnce({ items: [] })
      .mockRejectedValueOnce(new ApiError('Não foi possível conectar à API. Verifique sua conexão.', 0))
      .mockResolvedValue({ items: [] })
    await mount(fakeWalletApi({ listInvitations }))
    await screen.findByText('membro@example.com')

    await fireEvent.changeText(screen.getByLabelText('E-mail para convidar'), 'nova@example.com')
    await fireEvent.press(screen.getByRole('button', { name: 'Enviar convite' }))
    expect(await screen.findByText('Não foi possível conectar à API. Verifique sua conexão.')).toBeTruthy()
    expect(screen.getByText('membro@example.com')).toBeTruthy()

    await fireEvent.press(screen.getByRole('link', { name: 'Tentar novamente' }))
    await screen.findByText('membro@example.com')
    expect(listInvitations).toHaveBeenCalledTimes(3)
    expect(screen.queryByText('Não foi possível conectar à API. Verifique sua conexão.')).toBeNull()
  })
})
