import type { ApiClient, ApiRequestOptions } from '../api/client'
import { type CategorizationRuleInput, createImportApi, type CsvConfiguration, type ImportApi, type ImportItemInput, UPLOAD_TIMEOUT_MS } from './importApi'

function recordingClient() {
  const calls: { path: string; options?: ApiRequestOptions }[] = []
  const client = (async (path: string, options?: ApiRequestOptions) => {
    calls.push({ path, options })
    return { items: [] }
  }) as ApiClient
  return { api: createImportApi(client), calls }
}

const INPUT: ImportItemInput = { date: '2026-11-05', description: 'Mercado', type: 'expense', categoryId: 'cat-1', subcategoryId: null }
const RULE: CategorizationRuleInput = { type: 'expense', description: 'Padaria', categoryId: 'cat-1', subcategoryId: null, isActive: false }
const CSV: CsvConfiguration = {
  delimiter: ';', encoding: 'utf-8', hasHeader: true, dateFormat: 'dd/MM/yyyy', numberFormat: 'pt-BR',
  columns: { date: 0, description: 1, amount: 2, credit: null, debit: null, externalId: null },
}

// The contract is `docs/financial-imports-contract.md`. Every route belongs to the active wallet.
describe('createImportApi', () => {
  it.each([
    ['list', (api: ImportApi) => api.list(), '/financial-imports', undefined, undefined],
    ['get', (api: ImportApi) => api.get('i1'), '/financial-imports/i1', undefined, undefined],
    ['updateItem', (api: ImportApi) => api.updateItem('i1', 't2', INPUT), '/financial-imports/i1/items/t2', 'PATCH', INPUT],
    ['confirm', (api: ImportApi) => api.confirm('i1'), '/financial-imports/i1/confirm', 'POST', undefined],
    ['undo', (api: ImportApi) => api.undo('i1'), '/financial-imports/i1/undo', 'POST', undefined],
    ['discard', (api: ImportApi) => api.discard('i1'), '/financial-imports/i1', 'DELETE', undefined],
    ['listRules', (api: ImportApi) => api.listRules(), '/financial-imports/rules', undefined, undefined],
    ['createRule', (api: ImportApi) => api.createRule(RULE), '/financial-imports/rules', 'POST', RULE],
    ['updateRule', (api: ImportApi) => api.updateRule('r/1', RULE), '/financial-imports/rules/r%2F1', 'PATCH', RULE],
    ['deleteRule', (api: ImportApi) => api.deleteRule('r?1'), '/financial-imports/rules/r%3F1', 'DELETE', undefined],
    ['listCsvMappings', (api: ImportApi) => api.listCsvMappings(), '/financial-imports/csv-mappings', undefined, undefined],
    ['createCsvMapping', (api: ImportApi) => api.createCsvMapping('Banco X', CSV), '/financial-imports/csv-mappings', 'POST', { name: 'Banco X', configuration: CSV }],
    ['updateCsvMapping', (api: ImportApi) => api.updateCsvMapping('m/1', 'Banco X', CSV), '/financial-imports/csv-mappings/m%2F1', 'PATCH', { name: 'Banco X', configuration: CSV }],
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
    await api.upload({ name: 'extrato nov/2026.ofx', content }, { format: 'ofx', creditCardId: null })
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
    await api.upload({ name: 'fatura.ofx', content: new Blob(['x']) }, { format: 'ofx', creditCardId: 'card-1' })
    expect(calls[0]?.options?.headers).toEqual({ 'X-File-Name': 'fatura.ofx', 'X-File-Format': 'ofx', 'X-Credit-Card-Id': 'card-1' })
  })

  it('uploads a CSV with an ad hoc layout encoded, or with a saved model, never both', async () => {
    const { api, calls } = recordingClient()
    const file = { name: 'extrato.csv', content: new Blob(['data;valor']) }
    await api.upload(file, { format: 'csv', csvMapping: { configuration: CSV }, card: null })
    await api.upload(file, { format: 'csv', csvMapping: { mappingId: 'm-1' }, card: null })
    expect(calls[0]?.options?.headers).toEqual({
      'X-File-Name': 'extrato.csv', 'X-File-Format': 'csv', 'X-Csv-Mapping': encodeURIComponent(JSON.stringify(CSV)),
    })
    expect(calls[1]?.options?.headers).toEqual({ 'X-File-Name': 'extrato.csv', 'X-File-Format': 'csv', 'X-Csv-Mapping-Id': 'm-1' })
    expect(calls[0]?.options?.rawBody).toBe(file.content)
  })

  it('sends the card and how its CSV writes purchases', async () => {
    const { api, calls } = recordingClient()
    await api.upload({ name: 'fatura.csv', content: new Blob(['x']) }, {
      format: 'csv', csvMapping: { mappingId: 'm-1' }, card: { creditCardId: 'card-1', amountSign: 'purchases_positive' },
    })
    expect(calls[0]?.options?.headers).toEqual({
      'X-File-Name': 'fatura.csv', 'X-File-Format': 'csv', 'X-Csv-Mapping-Id': 'm-1',
      'X-Credit-Card-Id': 'card-1', 'X-Card-Amount-Sign': 'purchases_positive',
    })
  })

  it('inspects a CSV as is, with the layout to recompute when one is given', async () => {
    const { api, calls } = recordingClient()
    const file = { name: 'extrato set.csv', content: new Blob(['x']) }
    await api.inspectCsv(file)
    await api.inspectCsv(file, CSV)
    expect(calls[0]?.path).toBe('/financial-imports/csv/inspect')
    expect(calls[0]?.options).toEqual({ method: 'POST', rawBody: file.content, timeoutMs: UPLOAD_TIMEOUT_MS, headers: { 'X-File-Name': 'extrato%20set.csv' } })
    expect(calls[1]?.options?.headers).toEqual({ 'X-File-Name': 'extrato%20set.csv', 'X-Csv-Mapping': encodeURIComponent(JSON.stringify(CSV)) })
  })

  it('encodes import and item ids, so they cannot leave their route', async () => {
    const { api, calls } = recordingClient()
    await api.updateItem('i/../1', 't?2', INPUT)
    expect(calls[0]?.path).toBe('/financial-imports/i%2F..%2F1/items/t%3F2')
  })
})
