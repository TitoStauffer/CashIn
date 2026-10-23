import { afterEach, describe, expect, it, vi } from 'vitest'
import { setRequestWalletId } from '../wallets/walletApi'
import { FinancialImportApiError, importsApi } from './importsApi'

const session = {
  id: 'import-1',
  format: 'ofx' as const,
  fileName: 'extrato outubro.ofx',
  fileSize: 128,
  status: 'preview' as const,
  summary: { total: 1, valid: 1, duplicate: 0, invalid: 0, uncategorized: 0, imported: 0 },
  items: [],
  canUndo: false,
  undoBlockedReason: null,
  createdAt: '2026-10-23T12:00:00.000Z',
  confirmedAt: null,
}

afterEach(() => {
  vi.unstubAllGlobals()
  setRequestWalletId(null)
})

describe('financial imports API', () => {
  it('uploads the raw file with encoded metadata and the active wallet', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(session)))
    vi.stubGlobal('fetch', fetchMock)
    setRequestWalletId('wallet-1')
    const file = new File(['content'], 'extrato mês.ofx', { type: 'application/x-ofx' })

    await expect(importsApi.upload(file, 'ofx')).resolves.toEqual(session)

    const [url, init] = fetchMock.mock.calls[0]
    const headers = new Headers(init.headers)
    expect(url).toBe('/api/financial-imports')
    expect(init).toMatchObject({ method: 'POST', body: file, credentials: 'include' })
    expect(headers.get('Content-Type')).toBe('application/octet-stream')
    expect(headers.get('X-File-Name')).toBe(encodeURIComponent('extrato mês.ofx'))
    expect(headers.get('X-File-Format')).toBe('ofx')
    expect(headers.get('X-Wallet-Id')).toBe('wallet-1')
  })

  it('lists, opens, updates, confirms and undoes imports through their contracts', async () => {
    const item = {
      id: 'item-1', sequence: 1, date: '2026-10-01', description: 'Salário', amount: '100.00',
      type: 'income' as const, categoryId: null, subcategoryId: null,
      validationStatus: 'uncategorized' as const, errorMessage: null,
    }
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ items: [session] })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ...session, items: [item] })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ...item, categoryId: 'category-1', validationStatus: 'valid' })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ...session, status: 'completed' })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ...session, status: 'undone' })))
    vi.stubGlobal('fetch', fetchMock)
    const controller = new AbortController()

    await importsApi.list(controller.signal)
    await importsApi.get('import/1')
    await importsApi.updateItem('import/1', 'item/1', {
      date: item.date,
      description: item.description,
      type: item.type,
      categoryId: 'category-1',
      subcategoryId: null,
    })
    await importsApi.confirm('import/1')
    await importsApi.undo('import/1')

    expect(fetchMock.mock.calls[0][1].signal).toBe(controller.signal)
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      '/api/financial-imports',
      '/api/financial-imports/import%2F1',
      '/api/financial-imports/import%2F1/items/item%2F1',
      '/api/financial-imports/import%2F1/confirm',
      '/api/financial-imports/import%2F1/undo',
    ])
    expect(fetchMock.mock.calls[2][1]).toEqual(expect.objectContaining({ method: 'PATCH' }))
    expect(JSON.parse(fetchMock.mock.calls[2][1].body)).toMatchObject({ categoryId: 'category-1' })
    expect(fetchMock.mock.calls[3][1]).toEqual(expect.objectContaining({ method: 'POST' }))
    expect(fetchMock.mock.calls[4][1]).toEqual(expect.objectContaining({ method: 'POST' }))
  })

  it('preserves a safe API error status when the request fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ message: 'Arquivo inválido.' }), { status: 422 })))
    await expect(importsApi.list()).rejects.toEqual(new FinancialImportApiError('Arquivo inválido.', 422))
  })
})
