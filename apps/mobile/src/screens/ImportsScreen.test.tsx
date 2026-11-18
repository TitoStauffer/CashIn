import { fireEvent, render, screen } from '@testing-library/react-native'

import { ApiError } from '../api/client'
import type { CreditCard } from '../cards/creditCardApi'
import type { ImportApi, ImportFile, ImportSession } from '../imports/importApi'
import { ImportsScreen, NO_ACTIVE_CARD, PICK_FAILED } from './ImportsScreen'

const SESSION: ImportSession = {
  id: 'imp-1',
  importedBy: { userId: 'u1', email: 'eu@exemplo.com', isCurrentUser: true },
  format: 'ofx',
  kind: 'bank_statement',
  fileName: 'extrato.ofx',
  fileSize: 2048,
  status: 'preview',
  summary: { total: 4, valid: 2, duplicate: 1, invalid: 0, uncategorized: 1, imported: 0 },
  canUndo: false,
  undoBlockedReason: null,
  failureMessage: null,
  createdAt: '2026-11-18T12:00:00.000Z',
  confirmedAt: null,
}
const CARD: CreditCard = { id: 'card-1', nickname: 'Roxo', closingDay: 10, dueDay: 17, isActive: true }
const OLD_CARD: CreditCard = { id: 'card-2', nickname: 'Antigo', closingDay: 5, dueDay: 12, isActive: false }
const FILE: ImportFile = { name: 'extrato.ofx', content: new Blob(['OFXHEADER:100']) }

function fakeImportApi(overrides: Partial<ImportApi> = {}): ImportApi {
  return {
    list: jest.fn(async () => ({ items: [SESSION] })),
    upload: jest.fn(async () => ({ ...SESSION, id: 'imp-new' })),
    inspectCsv: jest.fn(async () => ({
      detectedConfiguration: { delimiter: ';', encoding: 'utf-8', hasHeader: true, dateFormat: 'dd/MM/yyyy', numberFormat: 'pt-BR' },
      suggestedMapping: { date: 0, description: 1, amount: 2, credit: null, debit: null, externalId: null },
      columns: [{ index: 0, label: 'Data' }, { index: 1, label: 'Descrição' }, { index: 2, label: 'Valor' }],
      sample: [{ lineNumber: 2, values: ['05/11/2026', 'Mercado', '-120,50'] }],
    })),
    listCsvMappings: jest.fn(async () => ({ items: [] })),
    ...overrides,
  } as unknown as ImportApi
}

async function mount({
  importApi = fakeImportApi(),
  cards = [CARD, OLD_CARD],
  pickFile = jest.fn(async () => FILE as ImportFile | null),
  walletId = 'w1',
}: { importApi?: ImportApi; cards?: CreditCard[]; pickFile?: jest.Mock; walletId?: string } = {}) {
  const onOpenImport = jest.fn()
  const cardApi = { list: jest.fn(async () => ({ items: cards })) }
  const view = await render(<ImportsScreen walletId={walletId} importApi={importApi} cardApi={cardApi} pickFile={pickFile} onOpenImport={onOpenImport} />)
  await screen.findByText('extrato.ofx')
  return { importApi, pickFile, onOpenImport, cardApi, view }
}

describe('ImportsScreen', () => {
  it('lists the history with status, summary and who imported, and opens an import', async () => {
    const { onOpenImport } = await mount()
    expect(screen.getByText('Aguardando confirmação · 18/11/2026 · 2,0 KB · importado por você')).toBeTruthy()
    expect(screen.getByText('2 prontas · 1 sem categoria · 1 duplicadas · 0 inválidas · 0 importadas')).toBeTruthy()
    await fireEvent.press(screen.getByRole('link', { name: 'Abrir importação de extrato.ofx em 18/11/2026' }))
    expect(onOpenImport).toHaveBeenCalledWith('imp-1')
  })

  it('sends a bank statement as chosen and opens its preview', async () => {
    const { importApi, onOpenImport } = await mount()
    await fireEvent.press(screen.getByRole('button', { name: 'Escolher arquivo OFX' }))
    expect(importApi.upload).toHaveBeenCalledWith(FILE, { format: 'ofx', creditCardId: null })
    expect(onOpenImport).toHaveBeenCalledWith('imp-new')
  })

  it('sends a card statement only with an active card chosen', async () => {
    const { importApi } = await mount()
    await fireEvent.press(screen.getByRole('radio', { name: 'Fatura de cartão' }))
    expect(screen.queryByRole('radio', { name: 'Antigo' })).toBeNull()
    await fireEvent.press(screen.getByRole('button', { name: 'Escolher arquivo OFX' }))
    expect(await screen.findByText('Escolha o cartão da fatura.')).toBeTruthy()
    expect(importApi.upload).not.toHaveBeenCalled()

    await fireEvent.press(screen.getByRole('radio', { name: 'Roxo' }))
    await fireEvent.press(screen.getByRole('button', { name: 'Escolher arquivo OFX' }))
    expect(importApi.upload).toHaveBeenCalledWith(FILE, { format: 'ofx', creditCardId: 'card-1' })
  })

  it('opens the setup of a chosen CSV, for the chosen card, before sending it', async () => {
    const csv: ImportFile = { name: 'fatura.csv', content: new Blob(['data;valor']) }
    const { importApi, onOpenImport } = await mount({ pickFile: jest.fn(async () => csv) })
    await fireEvent.press(screen.getByRole('radio', { name: 'CSV' }))
    await fireEvent.press(screen.getByRole('radio', { name: 'Fatura de cartão' }))
    await fireEvent.press(screen.getByRole('radio', { name: 'Roxo' }))
    await fireEvent.press(screen.getByRole('button', { name: 'Escolher arquivo CSV' }))
    expect(importApi.upload).not.toHaveBeenCalled()
    expect(await screen.findByText('Configurar fatura.csv')).toBeTruthy()
    expect(importApi.inspectCsv).toHaveBeenCalledWith(csv, undefined)
    await screen.findByText('Linha 2: 05/11/2026 · Mercado · -120,50')
    await fireEvent.press(screen.getByRole('radio', { name: 'Compras com valor positivo' }))
    await fireEvent.press(screen.getByRole('button', { name: 'Enviar CSV' }))
    expect(importApi.upload).toHaveBeenCalledWith(csv, expect.objectContaining({ format: 'csv', card: { creditCardId: 'card-1', amountSign: 'purchases_positive' } }))
    expect(onOpenImport).toHaveBeenCalledWith('imp-new')
  })

  it('goes back to a new import when the CSV setup is cancelled', async () => {
    await mount({ pickFile: jest.fn(async () => ({ name: 'extrato.csv', content: new Blob(['x']) })) })
    await fireEvent.press(screen.getByRole('radio', { name: 'CSV' }))
    await fireEvent.press(screen.getByRole('button', { name: 'Escolher arquivo CSV' }))
    await fireEvent.press(await screen.findByRole('link', { name: 'Cancelar importação do CSV' }))
    expect(screen.getByRole('button', { name: 'Escolher arquivo CSV' })).toBeTruthy()
  })

  it('points to the cards when the wallet has no active card', async () => {
    const { importApi } = await mount({ cards: [OLD_CARD] })
    await fireEvent.press(screen.getByRole('radio', { name: 'Fatura de cartão' }))
    expect(screen.getByText(NO_ACTIVE_CARD)).toBeTruthy()
    await fireEvent.press(screen.getByRole('button', { name: 'Escolher arquivo OFX' }))
    expect(screen.getAllByText(NO_ACTIVE_CARD)).toHaveLength(2)
    expect(importApi.upload).not.toHaveBeenCalled()
  })

  it('does nothing when the person gives up choosing the file', async () => {
    const { importApi, onOpenImport } = await mount({ pickFile: jest.fn(async () => null) })
    await fireEvent.press(screen.getByRole('button', { name: 'Escolher arquivo OFX' }))
    expect(importApi.upload).not.toHaveBeenCalled()
    expect(onOpenImport).not.toHaveBeenCalled()
  })

  it('shows the API refusal of the file, and a picker failure, in Portuguese', async () => {
    const upload = jest.fn(async () => { throw new ApiError('O arquivo excede o limite de 10 MB.', 413) })
    const pickFile = jest.fn().mockResolvedValueOnce(FILE).mockRejectedValueOnce(new Error('E_DOCUMENT_PICKER'))
    const { onOpenImport } = await mount({ importApi: fakeImportApi({ upload }), pickFile })
    await fireEvent.press(screen.getByRole('button', { name: 'Escolher arquivo OFX' }))
    expect(await screen.findByText('O arquivo excede o limite de 10 MB.')).toBeTruthy()
    await fireEvent.press(screen.getByRole('button', { name: 'Escolher arquivo OFX' }))
    expect(await screen.findByText(PICK_FAILED)).toBeTruthy()
    expect(onOpenImport).not.toHaveBeenCalled()
  })

  // Acceptance criterion of DEV-150: the content of the file never reaches a log or the console.
  it('never writes to the console while sending a file, on success or on refusal', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((method) => jest.spyOn(console, method))
    try {
      const upload = jest.fn()
        .mockResolvedValueOnce({ ...SESSION, id: 'imp-new' })
        .mockRejectedValueOnce(new ApiError('Arquivo OFX inválido.', 400))
      await mount({ importApi: fakeImportApi({ upload }) })
      await fireEvent.press(screen.getByRole('button', { name: 'Escolher arquivo OFX' }))
      await fireEvent.press(screen.getByRole('button', { name: 'Escolher arquivo OFX' }))
      expect(await screen.findByText('Arquivo OFX inválido.')).toBeTruthy()
      for (const spy of spies) expect(spy).not.toHaveBeenCalled()
    } finally {
      for (const spy of spies) spy.mockRestore()
    }
  })

  it('starts clean in another wallet, and shows a read error with retry', async () => {
    const list = jest.fn()
      .mockResolvedValueOnce({ items: [SESSION] })
      .mockRejectedValueOnce(new ApiError('Carteira não encontrada.', 404))
      .mockResolvedValue({ items: [] })
    const { view } = await mount({ importApi: fakeImportApi({ list }) })
    await fireEvent.press(screen.getByRole('radio', { name: 'Fatura de cartão' }))
    await view.rerender(<ImportsScreen walletId="w2" importApi={fakeImportApi({ list })} cardApi={{ list: async () => ({ items: [CARD] }) }} pickFile={async () => null} onOpenImport={() => undefined} />)
    expect(await screen.findByText('Carteira não encontrada.')).toBeTruthy()
    await fireEvent.press(screen.getByRole('button', { name: 'Tentar novamente' }))
    expect(await screen.findByText('Nenhuma importação nesta carteira.')).toBeTruthy()
    expect(screen.getByRole('radio', { name: 'Extrato bancário' }).props.accessibilityState).toEqual({ selected: true })
  })
})
