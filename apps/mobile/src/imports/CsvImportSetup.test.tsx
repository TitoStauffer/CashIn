import { act, fireEvent, render, screen } from '@testing-library/react-native'

import { ApiError } from '../api/client'
import type { CsvConfiguration, CsvInspection, CsvMappingTemplate, ImportApi, ImportFile } from './importApi'
import { AMOUNT_SIGN_REQUIRED, CsvImportSetup, INSPECT_AGAIN, MAPPING_INCOMPLETE, MAPPING_NAME_REQUIRED } from './CsvImportSetup'

const FILE: ImportFile = { name: 'extrato.csv', content: new Blob(['data;descricao;valor']) }
const COLUMNS = [{ index: 0, label: 'Data' }, { index: 1, label: 'Descrição' }, { index: 2, label: 'Valor' }]
const INSPECTION: CsvInspection = {
  detectedConfiguration: { delimiter: ';', encoding: 'utf-8', hasHeader: true, dateFormat: 'dd/MM/yyyy', numberFormat: 'pt-BR' },
  suggestedMapping: { date: 0, description: 1, amount: 2, credit: null, debit: null, externalId: null },
  columns: COLUMNS,
  sample: [{ lineNumber: 2, values: ['05/11/2026', 'Mercado', '-120,50'] }],
}
const DETECTED: CsvConfiguration = { ...INSPECTION.detectedConfiguration, columns: INSPECTION.suggestedMapping }
const MODEL: CsvMappingTemplate = {
  id: 'm-1', name: 'Banco X',
  configuration: { ...DETECTED, dateFormat: 'yyyy-MM-dd' },
  createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z',
}

type CsvApi = Pick<ImportApi, 'inspectCsv' | 'listCsvMappings' | 'createCsvMapping' | 'updateCsvMapping' | 'upload'>

function fakeApi(overrides: Partial<CsvApi> = {}): CsvApi {
  return {
    inspectCsv: jest.fn(async () => INSPECTION),
    listCsvMappings: jest.fn(async () => ({ items: [] as CsvMappingTemplate[] })),
    createCsvMapping: jest.fn(async (name: string, configuration: CsvConfiguration) => ({ ...MODEL, id: 'm-new', name, configuration })),
    updateCsvMapping: jest.fn(async (id: string, name: string, configuration: CsvConfiguration) => ({ ...MODEL, id, name, configuration })),
    upload: jest.fn(async () => ({ id: 'imp-csv' }) as Awaited<ReturnType<ImportApi['upload']>>),
    ...overrides,
  } as CsvApi
}

async function mount(importApi = fakeApi(), card: { id: string; nickname: string } | null = null) {
  const onUploaded = jest.fn()
  const onCancel = jest.fn()
  await render(<CsvImportSetup file={FILE} card={card} importApi={importApi} onUploaded={onUploaded} onCancel={onCancel} />)
  await screen.findByText('Linha 2: 05/11/2026 · Mercado · -120,50')
  return { importApi, onUploaded, onCancel }
}

const selected = (name: string) => screen.getByRole('radio', { name }).props.accessibilityState

describe('CsvImportSetup', () => {
  it('shows what the API detected and sends that layout as is', async () => {
    const { importApi, onUploaded } = await mount()
    expect(importApi.inspectCsv).toHaveBeenCalledWith(FILE, undefined)
    expect(selected('Ponto e vírgula (;)')).toEqual({ selected: true })
    expect(selected('Valor único: coluna Valor')).toEqual({ selected: true })
    await fireEvent.press(screen.getByRole('button', { name: 'Enviar CSV' }))
    expect(importApi.upload).toHaveBeenCalledWith(FILE, { format: 'csv', csvMapping: { configuration: DETECTED }, card: null })
    expect(onUploaded).toHaveBeenCalledWith('imp-csv')
  })

  it('asks the API again on a format change, keeping the columns only when they stay the same', async () => {
    const { importApi } = await mount()
    await fireEvent.press(screen.getByRole('radio', { name: 'AAAA-MM-DD' }))
    expect(importApi.inspectCsv).toHaveBeenLastCalledWith(FILE, { ...DETECTED, dateFormat: 'yyyy-MM-dd' })
    await fireEvent.press(screen.getByRole('radio', { name: 'Descrição: não mapear' }))
    await fireEvent.press(screen.getByRole('radio', { name: 'Vírgula (,)' }))
    // The delimiter changes the columns themselves, so the API's suggestion replaces the mapping.
    expect(await screen.findByText('Linha 2: 05/11/2026 · Mercado · -120,50')).toBeTruthy()
    expect(selected('Descrição: coluna Descrição')).toEqual({ selected: true })
  })

  it('keeps the mapping on screen when only the date or money format changes', async () => {
    await mount()
    await fireEvent.press(screen.getByRole('radio', { name: 'Descrição: não mapear' }))
    await fireEvent.press(screen.getByRole('radio', { name: '1,234.56' }))
    await screen.findByText('Linha 2: 05/11/2026 · Mercado · -120,50')
    expect(selected('Descrição: não mapear')).toEqual({ selected: true })
  })

  // Code Review of PR #130: the answer to a date or money format change brought back the columns of the
  // moment it was asked, undoing a column fixed while it ran.
  it('keeps a column fixed while a format inspection runs', async () => {
    let release: (value: CsvInspection) => void = () => undefined
    const inspectCsv = jest.fn()
      .mockResolvedValueOnce(INSPECTION)
      .mockReturnValueOnce(new Promise<CsvInspection>((resolve) => { release = resolve }))
    await mount(fakeApi({ inspectCsv }))
    await fireEvent.press(screen.getByRole('radio', { name: 'AAAA-MM-DD' }))
    await fireEvent.press(screen.getByRole('radio', { name: 'Descrição: não mapear' }))
    await act(async () => { release({ ...INSPECTION, detectedConfiguration: { ...INSPECTION.detectedConfiguration, dateFormat: 'yyyy-MM-dd' } }) })
    expect(selected('Descrição: não mapear')).toEqual({ selected: true })
    expect(selected('AAAA-MM-DD')).toEqual({ selected: true })
  })

  it('applies only the latest inspection, never a slower earlier one', async () => {
    let releaseFirst: (value: CsvInspection) => void = () => undefined
    const slow = new Promise<CsvInspection>((resolve) => { releaseFirst = resolve })
    const inspectCsv = jest.fn()
      .mockResolvedValueOnce(INSPECTION)
      .mockReturnValueOnce(slow)
      .mockResolvedValueOnce({ ...INSPECTION, sample: [{ lineNumber: 2, values: ['2026-11-05', 'Mercado', '-120.50'] }] })
    await mount(fakeApi({ inspectCsv }))
    await fireEvent.press(screen.getByRole('radio', { name: 'AAAA-MM-DD' }))
    await fireEvent.press(screen.getByRole('radio', { name: '1,234.56' }))
    expect(await screen.findByText('Linha 2: 2026-11-05 · Mercado · -120.50')).toBeTruthy()
    await act(async () => { releaseFirst({ ...INSPECTION, sample: [{ lineNumber: 2, values: ['antiga', 'antiga', 'antiga'] }] }) })
    expect(screen.queryByText('Linha 2: antiga · antiga · antiga')).toBeNull()
    expect(screen.getByText('Linha 2: 2026-11-05 · Mercado · -120.50')).toBeTruthy()
  })

  it('refuses to send a layout without one money layout', async () => {
    const { importApi } = await mount()
    await fireEvent.press(screen.getByRole('radio', { name: 'Valor único: não mapear' }))
    expect(screen.getByText(MAPPING_INCOMPLETE)).toBeTruthy()
    await fireEvent.press(screen.getByRole('button', { name: 'Enviar CSV' }))
    expect(importApi.upload).not.toHaveBeenCalled()
    await fireEvent.press(screen.getByRole('radio', { name: 'Crédito: coluna Valor' }))
    await fireEvent.press(screen.getByRole('radio', { name: 'Débito: coluna Descrição' }))
    await fireEvent.press(screen.getByRole('radio', { name: 'Descrição: não mapear' }))
    await fireEvent.press(screen.getByRole('button', { name: 'Enviar CSV' }))
    expect(importApi.upload).toHaveBeenCalledWith(FILE, expect.objectContaining({
      csvMapping: { configuration: { ...DETECTED, columns: { date: 0, description: null, amount: null, credit: 2, debit: 1, externalId: null } } },
    }))
  })

  it('sends a card statement only with how it writes purchases', async () => {
    const { importApi } = await mount(fakeApi(), { id: 'card-1', nickname: 'Roxo' })
    await fireEvent.press(screen.getByRole('button', { name: 'Enviar CSV' }))
    expect(await screen.findByText(AMOUNT_SIGN_REQUIRED)).toBeTruthy()
    expect(importApi.upload).not.toHaveBeenCalled()
    await fireEvent.press(screen.getByRole('radio', { name: 'Compras com valor negativo' }))
    await fireEvent.press(screen.getByRole('button', { name: 'Enviar CSV' }))
    expect(importApi.upload).toHaveBeenCalledWith(FILE, expect.objectContaining({ card: { creditCardId: 'card-1', amountSign: 'purchases_negative' } }))
  })

  it('sends an unchanged saved model by its id, and an edited one as the layout on screen', async () => {
    const importApi = fakeApi({ listCsvMappings: jest.fn(async () => ({ items: [MODEL] })) })
    await mount(importApi)
    await fireEvent.press(await screen.findByRole('radio', { name: 'Banco X' }))
    expect(importApi.inspectCsv).toHaveBeenLastCalledWith(FILE, MODEL.configuration)
    await screen.findByText('Modelo salvo nesta carteira.')
    await fireEvent.press(screen.getByRole('button', { name: 'Enviar CSV' }))
    expect(importApi.upload).toHaveBeenLastCalledWith(FILE, { format: 'csv', csvMapping: { mappingId: 'm-1' }, card: null })

    await fireEvent.press(screen.getByRole('radio', { name: 'Identificador externo: coluna Descrição' }))
    await fireEvent.press(screen.getByRole('radio', { name: 'Descrição: não mapear' }))
    await fireEvent.press(screen.getByRole('button', { name: 'Enviar CSV' }))
    expect(importApi.upload).toHaveBeenLastCalledWith(FILE, expect.objectContaining({ csvMapping: { configuration: expect.objectContaining({ columns: expect.objectContaining({ externalId: 1, description: null }) }) } }))
  })

  it('updates the chosen model with the edited layout, and saves a new one by name', async () => {
    const importApi = fakeApi({ listCsvMappings: jest.fn(async () => ({ items: [MODEL] })) })
    await mount(importApi)
    await fireEvent.press(await screen.findByRole('radio', { name: 'Banco X' }))
    await screen.findByText('Modelo salvo nesta carteira.')
    await fireEvent.press(screen.getByRole('radio', { name: 'Descrição: não mapear' }))
    await fireEvent.press(screen.getByRole('link', { name: 'Atualizar modelo' }))
    expect(importApi.updateCsvMapping).toHaveBeenCalledWith('m-1', 'Banco X', expect.objectContaining({ columns: expect.objectContaining({ description: null }) }))
    expect(await screen.findByText('Modelo “Banco X” salvo para esta carteira.')).toBeTruthy()

    await fireEvent.press(screen.getByRole('radio', { name: 'Configuração detectada' }))
    await screen.findByText('Linha 2: 05/11/2026 · Mercado · -120,50')
    await fireEvent.press(screen.getByRole('link', { name: 'Salvar novo modelo' }))
    expect(screen.getByText(MAPPING_NAME_REQUIRED)).toBeTruthy()
    await fireEvent.changeText(screen.getByLabelText('Nome do modelo'), '  Banco Y ')
    await fireEvent.press(screen.getByRole('link', { name: 'Salvar novo modelo' }))
    expect(importApi.createCsvMapping).toHaveBeenCalledWith('Banco Y', DETECTED)
  })

  it('shows the API refusal of the file, and inspects again on retry', async () => {
    const inspectCsv = jest.fn()
      .mockRejectedValueOnce(new ApiError('O CSV contém aspas inesperadas na linha 3.', 400))
      .mockResolvedValue(INSPECTION)
    await render(<CsvImportSetup file={FILE} card={null} importApi={fakeApi({ inspectCsv })} onUploaded={jest.fn()} onCancel={jest.fn()} />)
    expect(await screen.findByText('O CSV contém aspas inesperadas na linha 3.')).toBeTruthy()
    expect(screen.queryByRole('radio', { name: 'Vírgula (,)' })).toBeNull()
    await fireEvent.press(screen.getByRole('link', { name: 'Tentar novamente' }))
    expect(await screen.findByText('Linha 2: 05/11/2026 · Mercado · -120,50')).toBeTruthy()
  })

  // Code Review of PR #130: after a failed inspection the new format was on screen with the old sample,
  // and the file could be sent with it; a retry also kept the columns a delimiter change replaces.
  it('sends nothing after a failed inspection, and retries exactly the request that failed', async () => {
    const inspectCsv = jest.fn()
      .mockResolvedValueOnce(INSPECTION)
      .mockRejectedValueOnce(new ApiError('A API demorou para responder. Tente novamente.', 0))
      .mockResolvedValue(INSPECTION)
    const importApi = fakeApi({ inspectCsv })
    await mount(importApi)
    await fireEvent.press(screen.getByRole('radio', { name: 'Descrição: não mapear' }))
    await fireEvent.press(screen.getByRole('radio', { name: 'Vírgula (,)' }))
    expect(await screen.findByText('A API demorou para responder. Tente novamente.')).toBeTruthy()
    expect(screen.getByText(INSPECT_AGAIN)).toBeTruthy()
    await fireEvent.press(screen.getByRole('button', { name: 'Enviar CSV' }))
    await fireEvent.press(screen.getByRole('link', { name: 'Salvar novo modelo' }))
    expect(importApi.upload).not.toHaveBeenCalled()
    expect(importApi.createCsvMapping).not.toHaveBeenCalled()

    await fireEvent.press(screen.getByRole('link', { name: 'Tentar novamente' }))
    expect(inspectCsv).toHaveBeenLastCalledWith(FILE, { ...DETECTED, delimiter: ',', columns: { ...DETECTED.columns, description: null } })
    await screen.findByText('Linha 2: 05/11/2026 · Mercado · -120,50')
    expect(screen.queryByText(INSPECT_AGAIN)).toBeNull()
    // The failed request was a delimiter change, so the retry adopts the columns the API suggests.
    expect(selected('Descrição: coluna Descrição')).toEqual({ selected: true })
    await fireEvent.press(screen.getByRole('button', { name: 'Enviar CSV' }))
    expect(importApi.upload).toHaveBeenCalled()
  })

  // Code Review of PR #130: two equal headers gave two radios of the same group the same name.
  it('names a repeated header by its position too', async () => {
    const inspectCsv = jest.fn(async () => ({
      ...INSPECTION,
      columns: [{ index: 0, label: 'Data' }, { index: 1, label: 'Valor' }, { index: 2, label: 'Valor' }],
      suggestedMapping: { ...INSPECTION.suggestedMapping, description: null },
    }))
    await mount(fakeApi({ inspectCsv }))
    expect(screen.getByRole('radio', { name: 'Valor único: coluna 2 (Valor)' })).toBeTruthy()
    expect(selected('Valor único: coluna 3 (Valor)')).toEqual({ selected: true })
    expect(screen.getByRole('radio', { name: 'Valor único: coluna Data' })).toBeTruthy()
  })

  // Acceptance criterion of DEV-157: the content of the file never reaches a log or the console.
  it('never writes to the console while inspecting and sending, on success or on refusal', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((method) => jest.spyOn(console, method))
    try {
      const upload = jest.fn().mockRejectedValueOnce(new ApiError('O arquivo excede o limite de 10 MB.', 413))
      const { onCancel } = await mount(fakeApi({ upload }))
      await fireEvent.press(screen.getByRole('button', { name: 'Enviar CSV' }))
      expect(await screen.findByText('O arquivo excede o limite de 10 MB.')).toBeTruthy()
      await fireEvent.press(screen.getByRole('link', { name: 'Cancelar importação do CSV' }))
      expect(onCancel).toHaveBeenCalled()
      for (const spy of spies) expect(spy).not.toHaveBeenCalled()
    } finally {
      for (const spy of spies) spy.mockRestore()
    }
  })
})
