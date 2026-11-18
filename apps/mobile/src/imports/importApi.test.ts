import type { ApiClient, ApiRequestOptions } from '../api/client'
import { createImportApi, type ImportApi, type ImportItemInput, UPLOAD_TIMEOUT_MS } from './importApi'

function recordingClient() {
  const calls: { path: string; options?: ApiRequestOptions }[] = []
  const client = (async (path: string, options?: ApiRequestOptions) => {
    calls.push({ path, options })
    return { items: [] }
  }) as ApiClient
  return { api: createImportApi(client), calls }
}

const INPUT: ImportItemInput = { date: '2026-11-05', description: 'Mercado', type: 'expense', categoryId: 'cat-1', subcategoryId: null }

// The contract is `docs/financial-imports-contract.md`. Every route belongs to the active wallet.
describe('createImportApi', () => {
  it.each([
    ['list', (api: ImportApi) => api.list(), '/financial-imports', undefined, undefined],
    ['get', (api: ImportApi) => api.get('i1'), '/financial-imports/i1', undefined, undefined],
    ['updateItem', (api: ImportApi) => api.updateItem('i1', 't2', INPUT), '/financial-imports/i1/items/t2', 'PATCH', INPUT],
    ['confirm', (api: ImportApi) => api.confirm('i1'), '/financial-imports/i1/confirm', 'POST', undefined],
    ['undo', (api: ImportApi) => api.undo('i1'), '/financial-imports/i1/undo', 'POST', undefined],
    ['discard', (api: ImportApi) => api.discard('i1'), '/financial-imports/i1', 'DELETE', undefined],
  ])('%s calls the documented route in the active wallet', async (_name, call, path, method, body) => {
    const { api, calls } = recordingClient()
    await call(api)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.path).toBe(path)
    expect(calls[0]?.options?.scopeToActiveWallet).toBeUndefined()
    expect(calls[0]?.options?.method).toBe(method)
    expect(calls[0]?.options?.body).toEqual(body)
  })

  it('uploads a bank statement as is, with the encoded file name and the OFX format', async () => {
    const { api, calls } = recordingClient()
    const content = new Blob(['OFXHEADER:100'])
    await api.upload({ name: 'extrato nov/2026.ofx', content }, null)
    expect(calls[0]?.path).toBe('/financial-imports')
    expect(calls[0]?.options).toEqual({
      method: 'POST',
      rawBody: content,
      timeoutMs: UPLOAD_TIMEOUT_MS,
      headers: { 'X-File-Name': 'extrato%20nov%2F2026.ofx', 'X-File-Format': 'ofx' },
    })
  })

  it('names the card of a card statement upload', async () => {
    const { api, calls } = recordingClient()
    await api.upload({ name: 'fatura.ofx', content: new Blob(['x']) }, 'card-1')
    expect(calls[0]?.options?.headers).toEqual({ 'X-File-Name': 'fatura.ofx', 'X-File-Format': 'ofx', 'X-Credit-Card-Id': 'card-1' })
  })

  it('encodes import and item ids, so they cannot leave their route', async () => {
    const { api, calls } = recordingClient()
    await api.updateItem('i/../1', 't?2', INPUT)
    expect(calls[0]?.path).toBe('/financial-imports/i%2F..%2F1/items/t%3F2')
  })
})
