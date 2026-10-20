import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  getStoredWalletId,
  getPendingInviteToken,
  getWalletStorageKey,
  setRequestWalletId,
  storeWalletId,
  storePendingInviteToken,
  walletApi,
  WalletApiError,
  withActiveWallet,
} from './walletApi'

const wallet = { id: 'wallet-1', name: 'Pessoal', isPersonal: true, role: 'owner' as const }

function response(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: vi.fn().mockResolvedValue(body) }
}

describe('financial wallet request context', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn())
    window.localStorage.clear()
  })

  afterEach(() => {
    setRequestWalletId(null)
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('lists wallets with credentials and an optional abort signal', async () => {
    const signal = new AbortController().signal
    vi.mocked(fetch).mockResolvedValueOnce(response({ items: [wallet] }) as unknown as Response)

    await expect(walletApi.list(signal)).resolves.toEqual({ items: [wallet] })
    expect(fetch).toHaveBeenCalledWith('/api/wallets', expect.objectContaining({ credentials: 'include', signal }))
  })

  it('creates a wallet with the expected JSON contract', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(response(wallet) as unknown as Response)

    await expect(walletApi.create('Pessoal')).resolves.toEqual(wallet)
    expect(fetch).toHaveBeenCalledWith('/api/wallets', expect.objectContaining({
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Pessoal' }),
    }))
  })

  it('returns undefined for successful no-content responses', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(response(null, 204) as unknown as Response)
    await expect(walletApi.create('Pessoal')).resolves.toBeUndefined()
  })

  it('raises a typed API error with the response message and status', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(response({ message: 'Acesso negado' }, 404) as unknown as Response)
    await expect(walletApi.list()).rejects.toMatchObject<Partial<WalletApiError>>({
      name: 'WalletApiError', message: 'Acesso negado', status: 404,
    })
  })

  it('handles invalid error bodies without leaking a JSON parsing failure', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: false, status: 500, json: vi.fn().mockRejectedValue(new Error('invalid json')),
    } as unknown as Response)
    await expect(walletApi.list()).rejects.toMatchObject({ name: 'WalletApiError', message: '', status: 500 })
  })

  it('stores wallet selection by user and tolerates unavailable storage', () => {
    expect(getWalletStorageKey('user-a')).toBe('saldocerto.active-wallet.user-a')
    storeWalletId('user-a', 'wallet-a')
    expect(getStoredWalletId('user-a')).toBe('wallet-a')
    expect(getStoredWalletId('user-b')).toBeNull()

    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked') })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked') })
    expect(getStoredWalletId('user-a')).toBeNull()
    expect(() => storeWalletId('user-a', 'wallet-a')).not.toThrow()
  })

  it('adds the active wallet header while preserving existing request headers', () => {
    setRequestWalletId('wallet-shared')

    const request = withActiveWallet({
      method: 'POST',
      headers: { Authorization: 'Bearer session' },
    })

    expect(new Headers(request.headers).get('X-Wallet-Id')).toBe('wallet-shared')
    expect(new Headers(request.headers).get('Authorization')).toBe('Bearer session')
    expect(request.method).toBe('POST')
  })

  it('leaves the request unchanged when there is no selected wallet', () => {
    expect(withActiveWallet({ method: 'GET' })).toEqual({ method: 'GET' })
  })

  it('preserves a pending invitation token through the email confirmation and login flow', () => {
    storePendingInviteToken('single-use-invitation-token')
    expect(getPendingInviteToken()).toBe('single-use-invitation-token')
    storePendingInviteToken(null)
    expect(getPendingInviteToken()).toBeNull()
  })

  it('calls the wallet invitation and member endpoints with encoded identifiers', async () => {
    const invitation = { id: 'invite-1', email: 'person@example.com', status: 'pending', expiresAt: '2026-11-01T00:00:00Z', createdAt: '2026-10-20T00:00:00Z' }
    const member = { id: 'member-1', email: 'person@example.com', role: 'member', createdAt: '2026-10-20T00:00:00Z' }
    vi.mocked(fetch)
      .mockResolvedValueOnce(response({ items: [invitation] }) as unknown as Response)
      .mockResolvedValueOnce(response({ invitation, message: 'Convite enviado.' }, 202) as unknown as Response)
      .mockResolvedValueOnce(response(null, 204) as unknown as Response)
      .mockResolvedValueOnce(response({ items: [member] }) as unknown as Response)
      .mockResolvedValueOnce(response(null, 204) as unknown as Response)
      .mockResolvedValueOnce(response({ wallet }) as unknown as Response)

    await expect(walletApi.listInvitations('wallet/one')).resolves.toEqual({ items: [invitation] })
    await expect(walletApi.createInvitation('wallet/one', 'person@example.com')).resolves.toEqual({ invitation, message: 'Convite enviado.' })
    await expect(walletApi.cancelInvitation('wallet/one', 'invite/1')).resolves.toBeUndefined()
    await expect(walletApi.listMembers('wallet/one')).resolves.toEqual({ items: [member] })
    await expect(walletApi.removeMember('wallet/one', 'member/1')).resolves.toBeUndefined()
    await expect(walletApi.acceptInvitation('token')).resolves.toEqual({ wallet })

    expect(fetch).toHaveBeenNthCalledWith(1, '/api/wallets/wallet%2Fone/invites', expect.any(Object))
    expect(fetch).toHaveBeenNthCalledWith(2, '/api/wallets/wallet%2Fone/invites', expect.objectContaining({ method: 'POST', body: JSON.stringify({ email: 'person@example.com' }) }))
    expect(fetch).toHaveBeenNthCalledWith(3, '/api/wallets/wallet%2Fone/invites/invite%2F1', expect.objectContaining({ method: 'DELETE' }))
    expect(fetch).toHaveBeenNthCalledWith(4, '/api/wallets/wallet%2Fone/members', expect.any(Object))
    expect(fetch).toHaveBeenNthCalledWith(5, '/api/wallets/wallet%2Fone/members/member%2F1', expect.objectContaining({ method: 'DELETE' }))
    expect(fetch).toHaveBeenNthCalledWith(6, '/api/wallet-invitations/accept', expect.objectContaining({ method: 'POST', body: JSON.stringify({ token: 'token' }) }))
  })
})
