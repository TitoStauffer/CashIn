import type { ApiClient, ApiRequestOptions } from '../api/client'
import { createWalletApi } from './walletApi'

function recordingClient() {
  const calls: { path: string; options?: ApiRequestOptions }[] = []
  const client = (async (path: string, options?: ApiRequestOptions) => {
    calls.push({ path, options })
    return { items: [], link: {}, message: 'ok' }
  }) as ApiClient
  return { api: createWalletApi(client), calls }
}

// The contract is `docs/api.md`, section "Carteiras e escopo dos dados". No wallet route carries
// X-Wallet-Id: the sharing routes name their wallet in the path.
describe('createWalletApi', () => {
  it.each([
    ['list', (api: ReturnType<typeof createWalletApi>) => api.list(), '/wallets', undefined, undefined],
    ['create', (api: ReturnType<typeof createWalletApi>) => api.create('Viagem'), '/wallets', 'POST', { name: 'Viagem' }],
    ['listMembers', (api: ReturnType<typeof createWalletApi>) => api.listMembers('w1'), '/wallets/w1/members', undefined, undefined],
    ['removeMember', (api: ReturnType<typeof createWalletApi>) => api.removeMember('w1', 'u2'), '/wallets/w1/members/u2', 'DELETE', undefined],
    ['listInvitations', (api: ReturnType<typeof createWalletApi>) => api.listInvitations('w1'), '/wallets/w1/invites', undefined, undefined],
    ['invite', (api: ReturnType<typeof createWalletApi>) => api.invite('w1', 'pessoa@example.com'), '/wallets/w1/invites', 'POST', { email: 'pessoa@example.com' }],
    ['cancelInvitation', (api: ReturnType<typeof createWalletApi>) => api.cancelInvitation('w1', 'i3'), '/wallets/w1/invites/i3', 'DELETE', undefined],
    ['createAccessLink', (api: ReturnType<typeof createWalletApi>) => api.createAccessLink('w1'), '/wallets/w1/access-links', 'POST', undefined],
    ['listAccessRequests', (api: ReturnType<typeof createWalletApi>) => api.listAccessRequests('w1'), '/wallets/w1/access-requests', undefined, undefined],
    ['approveAccessRequest', (api: ReturnType<typeof createWalletApi>) => api.approveAccessRequest('w1', 'r4'), '/wallets/w1/access-requests/r4/approve', 'POST', undefined],
    ['rejectAccessRequest', (api: ReturnType<typeof createWalletApi>) => api.rejectAccessRequest('w1', 'r4'), '/wallets/w1/access-requests/r4/reject', 'POST', undefined],
    ['cancelAccessRequest', (api: ReturnType<typeof createWalletApi>) => api.cancelAccessRequest('w1', 'r4'), '/wallets/w1/access-requests/r4', 'DELETE', undefined],
  ])('%s calls the documented route outside any wallet scope', async (_name, call, path, method, body) => {
    const { api, calls } = recordingClient()
    await call(api)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.path).toBe(path)
    expect(calls[0]?.options?.scopeToActiveWallet).toBe(false)
    expect(calls[0]?.options?.method).toBe(method)
    expect(calls[0]?.options?.body).toEqual(body)
  })

  it('encodes every path segment, so an identifier cannot leave its route', async () => {
    const { api, calls } = recordingClient()
    await api.removeMember('w/../1', 'u?2')
    expect(calls[0]?.path).toBe('/wallets/w%2F..%2F1/members/u%3F2')
  })
})
