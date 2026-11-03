import { afterEach, describe, expect, it, vi } from 'vitest'
import { setRequestWalletId } from '../wallets/walletApi'
import { FinancialImportApiError, importsApi } from './importsApi'
import type { CsvImportConfiguration } from './importsApi'

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

  it('inspects CSV files and manages wallet-scoped mapping templates', async () => {
    const configuration: CsvImportConfiguration = {
      delimiter: ';', encoding: 'utf-8', hasHeader: true, dateFormat: 'dd/MM/yyyy', numberFormat: 'pt-BR',
      columns: { date: 0, description: 1, amount: 2, credit: null, debit: null, externalId: null },
    }
    const inspection = {
      detectedConfiguration: { delimiter: ';', encoding: 'utf-8', hasHeader: true, dateFormat: 'dd/MM/yyyy', numberFormat: 'pt-BR' },
      suggestedMapping: configuration.columns,
      columns: [{ index: 0, label: 'Data' }],
      sample: [{ lineNumber: 2, values: ['23/10/2026'] }],
    }
    const mapping = { id: 'mapping-1', name: 'Banco', configuration, createdAt: 'now', updatedAt: 'now' }
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(inspection)))
      .mockResolvedValueOnce(new Response(JSON.stringify({ items: [mapping] })))
      .mockResolvedValueOnce(new Response(JSON.stringify(mapping)))
      .mockResolvedValueOnce(new Response(JSON.stringify(mapping)))
    vi.stubGlobal('fetch', fetchMock)
    const file = new File(['csv'], 'extrato.csv', { type: 'text/csv' })

    await importsApi.inspectCsv(file)
    await importsApi.listCsvMappings()
    await importsApi.createCsvMapping(mapping.name, configuration)
    await importsApi.updateCsvMapping('mapping/1', mapping.name, configuration)

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      '/api/financial-imports/csv/inspect',
      '/api/financial-imports/csv-mappings',
      '/api/financial-imports/csv-mappings',
      '/api/financial-imports/csv-mappings/mapping%2F1',
    ])
    expect(fetchMock.mock.calls[0][1]).toEqual(expect.objectContaining({ method: 'POST', body: file }))
    expect(JSON.parse(fetchMock.mock.calls[2][1].body)).toEqual({ name: mapping.name, configuration })
    expect(fetchMock.mock.calls[3][1]).toEqual(expect.objectContaining({ method: 'PATCH' }))
  })

  it('uploads CSV with either an inline configuration or a saved mapping id', async () => {
    const configuration: CsvImportConfiguration = {
      delimiter: ',', encoding: 'windows-1252', hasHeader: true, dateFormat: 'yyyy-MM-dd', numberFormat: 'en-US',
      columns: { date: 0, description: 1, amount: 2, credit: null, debit: null, externalId: 3 },
    }
    const fetchMock = vi.fn().mockImplementation(async () => new Response(JSON.stringify({ ...session, format: 'csv' })))
    vi.stubGlobal('fetch', fetchMock)
    const file = new File(['csv'], 'extrato.csv', { type: 'text/csv' })

    await importsApi.upload(file, 'csv', { configuration })
    await importsApi.upload(file, 'csv', { mappingId: 'mapping-1' })

    const inlineHeaders = new Headers(fetchMock.mock.calls[0][1].headers)
    const savedHeaders = new Headers(fetchMock.mock.calls[1][1].headers)
    expect(JSON.parse(decodeURIComponent(inlineHeaders.get('X-Csv-Mapping')!))).toEqual(configuration)
    expect(inlineHeaders.has('X-Csv-Mapping-Id')).toBe(false)
    expect(savedHeaders.get('X-Csv-Mapping-Id')).toBe('mapping-1')
    expect(savedHeaders.has('X-Csv-Mapping')).toBe(false)
  })

  it('preserves a safe API error status when the request fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ message: 'Arquivo inválido.' }), { status: 422 })))
    await expect(importsApi.list()).rejects.toEqual(new FinancialImportApiError('Arquivo inválido.', 422))
  })
})
