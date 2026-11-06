import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { categoriesApi } from '../categories/categoriesApi'
import { WalletProvider } from '../wallets/WalletContext'
import { walletApi } from '../wallets/walletApi'
import { FinancialImportsPage } from './FinancialImportsPage'
import type { CsvImportConfiguration, CsvInspection, CsvMappingTemplate, FinancialImportItem, FinancialImportSession } from './importsApi'
import { FinancialImportApiError, importsApi } from './importsApi'
import { creditCardsApi } from '../creditCards/creditCardsApi'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

const previewSession: FinancialImportSession = {
  id: 'import-1',
  format: 'ofx',
  fileName: 'extrato.ofx',
  fileSize: 2048,
  status: 'preview',
  summary: { total: 3, valid: 1, duplicate: 0, invalid: 1, uncategorized: 1, imported: 0 },
  items: [
    {
      id: 'item-1', sequence: 1, date: '2026-10-01', description: 'Salário', amount: '3000.00',
      type: 'income', categoryId: null, subcategoryId: null, validationStatus: 'uncategorized', errorMessage: null, canEdit: true,
    },
    {
      id: 'item-2', sequence: 2, date: '2026-10-02', description: 'Mercado', amount: '150.00',
      type: 'expense', categoryId: 'expense-category', subcategoryId: null, validationStatus: 'valid', errorMessage: null, canEdit: true,
    },
    {
      id: 'item-3', sequence: 3, date: '2026-10-03', description: 'Registro incompleto', amount: '20.00',
      type: 'expense', categoryId: null, subcategoryId: null, validationStatus: 'invalid', errorMessage: 'Dados insuficientes para importar.', canEdit: false,
    },
  ],
  canUndo: false,
  undoBlockedReason: null,
  failureMessage: null,
  createdAt: '2026-10-23T12:00:00.000Z',
  confirmedAt: null,
}

const completedSession: FinancialImportSession = {
  ...previewSession,
  status: 'completed',
  summary: { ...previewSession.summary, imported: 2 },
  canUndo: true,
  confirmedAt: '2026-10-23T12:05:00.000Z',
}

const uncategorizedOnlySession: FinancialImportSession = {
  ...previewSession,
  summary: { total: 2, valid: 0, duplicate: 0, invalid: 0, uncategorized: 2, imported: 0 },
  items: previewSession.items!.slice(0, 2).map((item) => ({
    ...item,
    categoryId: null,
    subcategoryId: null,
    validationStatus: 'uncategorized',
  })),
}

const nullDescriptionSession: FinancialImportSession = {
  ...previewSession,
  summary: { total: 1, valid: 0, duplicate: 0, invalid: 0, uncategorized: 1, imported: 0 },
  items: [{
    ...previewSession.items![0],
    description: null,
  }],
}

const repairableInvalidSession: FinancialImportSession = {
  ...previewSession,
  summary: { total: 2, valid: 0, duplicate: 1, invalid: 1, uncategorized: 0, imported: 0 },
  items: [
    {
      ...previewSession.items![0],
      validationStatus: 'invalid',
      errorMessage: 'A categoria informada não existe nesta carteira.',
      canEdit: true,
    },
    {
      ...previewSession.items![1],
      validationStatus: 'duplicate',
      errorMessage: 'Esta movimentação já foi importada.',
      canEdit: false,
    },
  ],
}

const failedSession: FinancialImportSession = {
  ...previewSession,
  status: 'failed',
  summary: { total: 0, valid: 0, duplicate: 0, invalid: 0, uncategorized: 0, imported: 0 },
  items: [],
  failureMessage: 'Não foi possível interpretar o conteúdo do arquivo enviado.',
}

const confirmingSession: FinancialImportSession = {
  ...previewSession,
  status: 'confirming',
}

const csvConfiguration: CsvImportConfiguration = {
  delimiter: ';',
  encoding: 'utf-8',
  hasHeader: true,
  dateFormat: 'dd/MM/yyyy',
  numberFormat: 'pt-BR',
  columns: { date: 0, description: 1, amount: 2, credit: null, debit: null, externalId: 3 },
}

const csvInspection: CsvInspection = {
  detectedConfiguration: {
    delimiter: ';', encoding: 'utf-8', hasHeader: true, dateFormat: 'dd/MM/yyyy', numberFormat: 'pt-BR',
  },
  suggestedMapping: csvConfiguration.columns,
  columns: [
    { index: 0, label: 'Data' }, { index: 1, label: 'Histórico' }, { index: 2, label: 'Valor' }, { index: 3, label: 'ID' },
  ],
  sample: [{ lineNumber: 2, values: ['23/10/2026', 'Mercado', '-120,50', 'bank-1'] }],
}

const csvTemplate: CsvMappingTemplate = {
  id: 'mapping-1', name: 'Banco Exemplo', configuration: csvConfiguration,
  createdAt: '2026-10-23T12:00:00.000Z', updatedAt: '2026-10-23T12:00:00.000Z',
}

async function renderPage() {
  const result = render(
    <WalletProvider userId="user-1">
      <FinancialImportsPage userEmail="tito@example.com" isLoggingOut={false} onLogout={vi.fn()} />
    </WalletProvider>,
  )
  await screen.findByRole('heading', { name: 'Importar arquivo financeiro' })
  await waitFor(() => expect(importsApi.list).toHaveBeenCalled())
  await waitFor(() => expect(screen.getByLabelText('Arquivo OFX ou CSV')).toBeEnabled())
  return result
}

describe('FinancialImportsPage', () => {
  beforeEach(() => {
    vi.stubGlobal('matchMedia', vi.fn(() => ({
      matches: false,
      media: '(max-width: 760px)',
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })))
    vi.spyOn(walletApi, 'list').mockResolvedValue({ items: [
      { id: 'wallet-personal', name: 'Pessoal', isPersonal: true, role: 'owner' },
      { id: 'wallet-shared', name: 'Família', isPersonal: false, role: 'member' },
    ] })
    vi.spyOn(categoriesApi, 'list').mockImplementation(async (nature) => ({ items: nature === 'income' ? [{
      id: 'income-category', name: 'Salário', nature: 'income', subcategories: [{ id: 'income-subcategory', name: 'Mensal', categoryId: 'income-category' }],
    }] : [{
      id: 'expense-category', name: 'Alimentação', nature: 'expense', subcategories: [{ id: 'expense-subcategory', name: 'Mercado', categoryId: 'expense-category' }],
    }] }))
    vi.spyOn(importsApi, 'list').mockResolvedValue({ items: [] })
    vi.spyOn(importsApi, 'listCsvMappings').mockResolvedValue({ items: [] })
    vi.spyOn(importsApi, 'inspectCsv').mockResolvedValue(csvInspection)
    vi.spyOn(importsApi, 'createCsvMapping').mockResolvedValue(csvTemplate)
    vi.spyOn(importsApi, 'updateCsvMapping').mockResolvedValue(csvTemplate)
    vi.spyOn(importsApi, 'get').mockResolvedValue(previewSession)
    vi.spyOn(importsApi, 'upload').mockResolvedValue({ ...previewSession, status: 'processing', items: [] })
    vi.spyOn(importsApi, 'updateItem').mockImplementation(async (_importId, itemId, input) => ({
      ...previewSession.items!.find((item) => item.id === itemId)!,
      ...input,
      validationStatus: input.categoryId ? 'valid' : 'uncategorized',
    }))
    vi.spyOn(importsApi, 'confirm').mockResolvedValue(completedSession)
    vi.spyOn(importsApi, 'undo').mockResolvedValue({ ...completedSession, status: 'undone', canUndo: false, undoneAt: '2026-10-23T12:10:00.000Z' })
    vi.spyOn(importsApi, 'discard').mockResolvedValue({
      ...previewSession,
      status: 'failed',
      failureMessage: 'Importação descartada pelo usuário.',
      summary: { ...previewSession.summary, valid: 0, uncategorized: 2 },
      items: previewSession.items!.map((item) => ({
        ...item,
        categoryId: null,
        subcategoryId: null,
        validationStatus: item.validationStatus === 'valid' ? 'uncategorized' as const : item.validationStatus,
        canEdit: false,
      })),
    })
    vi.spyOn(window, 'confirm').mockReturnValue(true)
  })

  afterEach(() => {
    vi.useRealTimers()
    cleanup()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    window.localStorage.clear()
  })

  it('uploads a supported file only after showing its name and limit', async () => {
    const user = userEvent.setup()
    await renderPage()
    expect(screen.getByText(/Limite de 10 MB e 10.000 movimentações/)).toBeVisible()
    const file = new File(['OFXDATA'], 'extrato.ofx', { type: 'application/x-ofx' })

    await user.upload(screen.getByLabelText('Arquivo OFX ou CSV'), file)
    expect(screen.getByText(/extrato\.ofx/)).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Enviar e preparar prévia' }))

    await waitFor(() => expect(importsApi.upload).toHaveBeenCalledWith(file, 'ofx'))
    expect(await screen.findByText(/Arquivo recebido/)).toBeVisible()
    expect(screen.getByText(/processado temporariamente/i)).toBeVisible()
  })

  it('rejects unsupported and oversized files before calling the API', async () => {
    await renderPage()
    const input = screen.getByLabelText('Arquivo OFX ou CSV')

    fireEvent.change(input, { target: { files: [new File(['texto'], 'extrato.txt', { type: 'text/plain' })] } })
    expect(await screen.findByRole('alert')).toHaveTextContent('extensão .ofx ou .csv')
    expect(importsApi.upload).not.toHaveBeenCalled()

    const oversized = new File([new Uint8Array(10 * 1024 * 1024 + 1)], 'extrato.csv', { type: 'text/csv' })
    fireEvent.change(input, { target: { files: [oversized] } })
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('ultrapassa o limite de 10 MB'))
    expect(importsApi.upload).not.toHaveBeenCalled()
  })

  it('inspects and uploads CSV only after presenting the detected mapping and sample', async () => {
    const user = userEvent.setup()
    await renderPage()
    const file = new File(['Data;Histórico;Valor;ID\n23/10/2026;Mercado;-120,50;bank-1'], 'extrato.csv', { type: 'text/csv' })

    await user.upload(screen.getByLabelText('Arquivo OFX ou CSV'), file)

    await waitFor(() => expect(importsApi.inspectCsv).toHaveBeenCalledWith(file, expect.any(AbortSignal)))
    expect(await screen.findByRole('heading', { name: 'Confira como as colunas serão interpretadas' })).toBeVisible()
    expect(screen.getByRole('table', { name: 'Amostra das primeiras linhas' })).toHaveTextContent('Mercado')
    expect(screen.getByLabelText('Data *')).toHaveValue('0')
    expect(screen.getByLabelText('Descrição')).toHaveValue('1')

    await user.click(screen.getByRole('button', { name: 'Enviar e preparar prévia' }))

    await waitFor(() => expect(importsApi.upload).toHaveBeenCalledWith(file, 'csv', { configuration: csvConfiguration }))
  })

  it('reinspects columns and sample after manually correcting an incorrect delimiter', async () => {
    const incorrectInspection: CsvInspection = {
      ...csvInspection,
      detectedConfiguration: { ...csvInspection.detectedConfiguration, delimiter: ';' },
      suggestedMapping: { date: 0, description: null, amount: null, credit: null, debit: null, externalId: null },
      columns: [{ index: 0, label: 'Data,Valor' }],
      sample: [{ lineNumber: 2, values: ['23/10/2026,-120,50'] }],
    }
    const correctedInspection: CsvInspection = {
      ...csvInspection,
      detectedConfiguration: { ...csvInspection.detectedConfiguration, delimiter: ',' },
      suggestedMapping: { date: 0, description: null, amount: 1, credit: null, debit: null, externalId: null },
      columns: [{ index: 0, label: 'Data' }, { index: 1, label: 'Valor' }],
      sample: [{ lineNumber: 2, values: ['23/10/2026', '-120,50'] }],
    }
    vi.mocked(importsApi.inspectCsv)
      .mockResolvedValueOnce(incorrectInspection)
      .mockResolvedValueOnce(correctedInspection)
    const user = userEvent.setup()
    await renderPage()
    const file = new File(['Data,Valor\n23/10/2026,-120,50'], 'extrato.csv', { type: 'text/csv' })
    await user.upload(screen.getByLabelText('Arquivo OFX ou CSV'), file)
    expect(await screen.findByRole('columnheader', { name: 'Data,Valor' })).toBeVisible()

    await user.selectOptions(screen.getByLabelText('Delimitador'), ',')

    await waitFor(() => expect(importsApi.inspectCsv).toHaveBeenLastCalledWith(
      file,
      expect.any(AbortSignal),
      expect.objectContaining({ delimiter: ',' }),
    ))
    expect(await screen.findByRole('columnheader', { name: 'Valor' })).toBeVisible()
    expect(screen.queryByRole('columnheader', { name: 'Data,Valor' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Enviar e preparar prévia' })).toBeEnabled()
  })

  it('keeps manual configuration and saved models available after the initial inspection fails', async () => {
    vi.mocked(importsApi.listCsvMappings).mockResolvedValueOnce({ items: [csvTemplate] })
    vi.mocked(importsApi.inspectCsv)
      .mockRejectedValueOnce(new Error('detection failed'))
      .mockResolvedValueOnce(csvInspection)
    const user = userEvent.setup()
    await renderPage()
    const file = new File(['\nData;Valor\n23/10/2026;-120,50'], 'extrato.csv', { type: 'text/csv' })

    await user.upload(screen.getByLabelText('Arquivo OFX ou CSV'), file)

    expect(await screen.findByRole('alert')).toHaveTextContent('Não foi possível analisar o CSV')
    expect(screen.getByRole('heading', { name: 'Confira como as colunas serão interpretadas' })).toBeVisible()
    expect(screen.getByLabelText('Delimitador')).toBeEnabled()
    expect(screen.getByRole('option', { name: csvTemplate.name })).toBeVisible()

    await user.selectOptions(screen.getByLabelText('Modelo salvo'), csvTemplate.id)

    await waitFor(() => expect(importsApi.inspectCsv).toHaveBeenLastCalledWith(
      file,
      expect.any(AbortSignal),
      csvTemplate.configuration,
    ))
    expect(await screen.findByText('Mercado')).toBeVisible()
    expect(screen.getByRole('button', { name: 'Enviar e preparar prévia' })).toBeEnabled()
  })

  it('ignores an obsolete reinspection response when adjustments happen in sequence', async () => {
    const firstCorrection = deferred<CsvInspection>()
    const latestCorrection = deferred<CsvInspection>()
    vi.mocked(importsApi.inspectCsv)
      .mockResolvedValueOnce(csvInspection)
      .mockReturnValueOnce(firstCorrection.promise)
      .mockReturnValueOnce(latestCorrection.promise)
    const user = userEvent.setup()
    await renderPage()
    await user.upload(screen.getByLabelText('Arquivo OFX ou CSV'), new File(['csv'], 'extrato.csv', { type: 'text/csv' }))
    await screen.findByRole('heading', { name: 'Confira como as colunas serão interpretadas' })

    await user.selectOptions(screen.getByLabelText('Delimitador'), ',')
    await user.selectOptions(screen.getByLabelText('Codificação'), 'windows-1252')
    await act(async () => {
      latestCorrection.resolve({
        ...csvInspection,
        detectedConfiguration: { ...csvInspection.detectedConfiguration, delimiter: ',', encoding: 'windows-1252' },
        sample: [{ lineNumber: 2, values: ['ATUAL', 'Mercado', '-120,50', 'bank-1'] }],
      })
      await latestCorrection.promise
    })
    expect(await screen.findByText('ATUAL')).toBeVisible()

    await act(async () => {
      firstCorrection.resolve({
        ...csvInspection,
        sample: [{ lineNumber: 2, values: ['OBSOLETA', 'Mercado', '-120,50', 'bank-1'] }],
      })
      await firstCorrection.promise
    })
    expect(screen.queryByText('OBSOLETA')).not.toBeInTheDocument()
    expect(screen.getByLabelText('Codificação')).toHaveValue('windows-1252')
  })

  it('accepts CSV with only date and amount mapped because description is optional', async () => {
    vi.mocked(importsApi.inspectCsv).mockResolvedValueOnce({
      ...csvInspection,
      suggestedMapping: { ...csvInspection.suggestedMapping, description: null, amount: null },
    })
    const user = userEvent.setup()
    await renderPage()
    await user.upload(screen.getByLabelText('Arquivo OFX ou CSV'), new File(['csv'], 'extrato.csv', { type: 'text/csv' }))
    await screen.findByRole('heading', { name: 'Confira como as colunas serão interpretadas' })
    const uploadButton = screen.getByRole('button', { name: 'Enviar e preparar prévia' })
    expect(uploadButton).toBeDisabled()

    await user.selectOptions(screen.getByLabelText('Valor único'), '2')

    expect(uploadButton).toBeEnabled()
    await user.click(uploadButton)
    await waitFor(() => expect(importsApi.upload).toHaveBeenCalledWith(
      expect.any(File),
      'csv',
      { configuration: expect.objectContaining({ columns: expect.objectContaining({ date: 0, description: null, amount: 2 }) }) },
    ))
  })

  it('accepts either amount or the complete credit and debit pair, never a partial combination', async () => {
    const user = userEvent.setup()
    await renderPage()
    await user.upload(screen.getByLabelText('Arquivo OFX ou CSV'), new File(['csv'], 'extrato.csv', { type: 'text/csv' }))
    await screen.findByRole('heading', { name: 'Confira como as colunas serão interpretadas' })
    const uploadButton = screen.getByRole('button', { name: 'Enviar e preparar prévia' })
    expect(uploadButton).toBeEnabled()

    await user.selectOptions(screen.getByLabelText('Identificador externo'), '')
    await user.selectOptions(screen.getByLabelText('Crédito'), '2')
    expect(uploadButton).toBeDisabled()
    await user.selectOptions(screen.getByLabelText('Valor único'), '')
    expect(uploadButton).toBeDisabled()
    await user.selectOptions(screen.getByLabelText('Débito'), '3')
    expect(uploadButton).toBeEnabled()
  })

  it('blocks repeated column indexes across required and optional CSV fields', async () => {
    const user = userEvent.setup()
    await renderPage()
    await user.upload(screen.getByLabelText('Arquivo OFX ou CSV'), new File(['csv'], 'extrato.csv', { type: 'text/csv' }))
    await screen.findByRole('heading', { name: 'Confira como as colunas serão interpretadas' })
    const uploadButton = screen.getByRole('button', { name: 'Enviar e preparar prévia' })
    expect(uploadButton).toBeEnabled()

    await user.selectOptions(screen.getByLabelText('Valor único'), '0')
    expect(uploadButton).toBeDisabled()

    await user.selectOptions(screen.getByLabelText('Valor único'), '2')
    await user.selectOptions(screen.getByLabelText('Identificador externo'), '2')
    expect(uploadButton).toBeDisabled()

    await user.selectOptions(screen.getByLabelText('Identificador externo'), '3')
    expect(uploadButton).toBeEnabled()
  })

  it('saves and reuses a wallet-scoped CSV mapping by its identifier', async () => {
    vi.mocked(importsApi.listCsvMappings).mockResolvedValueOnce({ items: [csvTemplate] })
    const user = userEvent.setup()
    await renderPage()
    const file = new File(['csv'], 'extrato.csv', { type: 'text/csv' })
    await user.upload(screen.getByLabelText('Arquivo OFX ou CSV'), file)
    await screen.findByRole('heading', { name: 'Confira como as colunas serão interpretadas' })

    await user.selectOptions(screen.getByLabelText('Modelo salvo'), csvTemplate.id)
    await waitFor(() => expect(importsApi.inspectCsv).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Enviar e preparar prévia' })).toBeEnabled())
    expect(screen.getByLabelText('Nome do modelo')).toHaveValue(csvTemplate.name)
    await user.click(screen.getByRole('button', { name: 'Enviar e preparar prévia' }))

    await waitFor(() => expect(importsApi.upload).toHaveBeenCalledWith(file, 'csv', { mappingId: csvTemplate.id }))
  })

  it('creates a named CSV model from the detected configuration', async () => {
    const user = userEvent.setup()
    await renderPage()
    await user.upload(screen.getByLabelText('Arquivo OFX ou CSV'), new File(['csv'], 'extrato.csv', { type: 'text/csv' }))
    await screen.findByRole('heading', { name: 'Confira como as colunas serão interpretadas' })
    await user.type(screen.getByLabelText('Nome do modelo'), 'Banco Exemplo')

    await user.click(screen.getByRole('button', { name: 'Salvar novo modelo' }))

    await waitFor(() => expect(importsApi.createCsvMapping).toHaveBeenCalledWith('Banco Exemplo', csvConfiguration))
    expect(await screen.findByText(/Modelo “Banco Exemplo” salvo/)).toBeVisible()
  })

  it('updates an edited CSV model before reusing it', async () => {
    vi.mocked(importsApi.listCsvMappings).mockResolvedValueOnce({ items: [csvTemplate] })
    vi.mocked(importsApi.inspectCsv)
      .mockResolvedValueOnce(csvInspection)
      .mockResolvedValueOnce(csvInspection)
      .mockResolvedValueOnce({
        ...csvInspection,
        detectedConfiguration: { ...csvInspection.detectedConfiguration, numberFormat: 'en-US' },
      })
    const user = userEvent.setup()
    await renderPage()
    await user.upload(screen.getByLabelText('Arquivo OFX ou CSV'), new File(['csv'], 'extrato.csv', { type: 'text/csv' }))
    await screen.findByRole('heading', { name: 'Confira como as colunas serão interpretadas' })
    await user.selectOptions(screen.getByLabelText('Modelo salvo'), csvTemplate.id)
    await waitFor(() => expect(importsApi.inspectCsv).toHaveBeenCalledTimes(2))
    await user.selectOptions(screen.getByLabelText('Formato monetário'), 'en-US')
    await waitFor(() => expect(importsApi.inspectCsv).toHaveBeenCalledTimes(3))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Atualizar modelo' })).toBeEnabled())

    await user.click(screen.getByRole('button', { name: 'Atualizar modelo' }))

    await waitFor(() => expect(importsApi.updateCsvMapping).toHaveBeenCalledWith(
      csvTemplate.id,
      csvTemplate.name,
      expect.objectContaining({ numberFormat: 'en-US' }),
    ))
  })

  it('opens the preview, edits classification and confirms only reviewable items', async () => {
    vi.mocked(importsApi.list).mockResolvedValueOnce({ items: [{ ...previewSession, items: undefined }] })
    const user = userEvent.setup()
    await renderPage()
    await user.click(await screen.findByRole('button', { name: 'Ver detalhes' }))

    const firstItem = (await screen.findByText('Movimentação 1')).closest('li') as HTMLElement
    expect(within(firstItem).getAllByText('Não categorizada')[0]).toBeVisible()
    expect(screen.getByRole('button', { name: 'Confirmar 1 movimentação' })).toBeEnabled()
    expect(screen.getByText(/Itens sem categoria \(1\) ficam fora.*Itens inválidos \(1\) e duplicidades confirmadas não serão importados/)).toBeVisible()
    await user.selectOptions(within(firstItem).getByLabelText('Categoria'), 'income-category')
    await user.selectOptions(within(firstItem).getByLabelText('Subcategoria'), 'income-subcategory')
    await user.clear(within(firstItem).getByLabelText('Descrição'))
    await user.type(within(firstItem).getByLabelText('Descrição'), 'Salário mensal')
    expect(screen.getByRole('button', { name: 'Confirmar 1 movimentação' })).toBeDisabled()
    expect(screen.getByText(/Existem ajustes não salvos/)).toBeVisible()
    await user.click(within(firstItem).getByRole('button', { name: 'Salvar ajuste' }))

    await waitFor(() => expect(importsApi.updateItem).toHaveBeenCalledWith('import-1', 'item-1', expect.objectContaining({
      description: 'Salário mensal', categoryId: 'income-category', subcategoryId: 'income-subcategory',
    })))
    const confirmButton = screen.getByRole('button', { name: 'Confirmar 2 movimentações' })
    expect(confirmButton).toBeEnabled()
    expect(screen.queryByText(/Existem ajustes não salvos/)).not.toBeInTheDocument()
    await user.click(confirmButton)
    await waitFor(() => expect(importsApi.confirm).toHaveBeenCalledWith('import-1'))
    expect(await screen.findByText(/2 movimentações foram importadas/)).toBeVisible()
  })

  it('does not confirm a preview when all items are uncategorized', async () => {
    vi.mocked(importsApi.list).mockResolvedValueOnce({ items: [{ ...uncategorizedOnlySession, items: undefined }] })
    vi.mocked(importsApi.get).mockResolvedValueOnce(uncategorizedOnlySession)
    const user = userEvent.setup()
    await renderPage()
    await user.click(await screen.findByRole('button', { name: 'Ver detalhes' }))

    expect(await screen.findByText(/Nenhuma movimentação está pronta para confirmar/)).toBeVisible()
    expect(screen.getByText(/Itens sem categoria \(2\) ficam fora.*Itens inválidos \(0\) e duplicidades confirmadas não serão importados/)).toBeVisible()
    expect(screen.getByRole('button', { name: 'Confirmar 0 movimentações' })).toBeDisabled()
    expect(importsApi.confirm).not.toHaveBeenCalled()
  })

  it('normalizes a null description and allows saving the classification without text', async () => {
    vi.mocked(importsApi.list).mockResolvedValueOnce({ items: [{ ...nullDescriptionSession, items: undefined }] })
    vi.mocked(importsApi.get).mockResolvedValueOnce(nullDescriptionSession)
    const user = userEvent.setup()
    await renderPage()
    await user.click(await screen.findByRole('button', { name: 'Ver detalhes' }))

    const item = (await screen.findByText('Movimentação 1')).closest('li') as HTMLElement
    expect(within(item).getByLabelText('Descrição')).toHaveValue('')
    await user.selectOptions(within(item).getByLabelText('Categoria'), 'income-category')
    await user.click(within(item).getByRole('button', { name: 'Salvar ajuste' }))

    await waitFor(() => expect(importsApi.updateItem).toHaveBeenCalledWith('import-1', 'item-1', expect.objectContaining({
      description: '', categoryId: 'income-category',
    })))
    expect(screen.queryByText(/Informe a data e a descrição/)).not.toBeInTheDocument()
  })

  it('allows repairing editable invalid items while keeping duplicates locked', async () => {
    vi.mocked(importsApi.list).mockResolvedValueOnce({ items: [{ ...repairableInvalidSession, items: undefined }] })
    vi.mocked(importsApi.get).mockResolvedValueOnce(repairableInvalidSession)
    const user = userEvent.setup()
    await renderPage()
    await user.click(await screen.findByRole('button', { name: 'Ver detalhes' }))

    const repairable = (await screen.findByText('Movimentação 1')).closest('li') as HTMLElement
    const duplicate = screen.getByText('Movimentação 2').closest('li') as HTMLElement
    expect(within(repairable).getByLabelText('Categoria')).toBeEnabled()
    expect(within(repairable).getByRole('button', { name: 'Salvar ajuste' })).toBeEnabled()
    expect(within(duplicate).getByLabelText('Categoria')).toBeDisabled()
    expect(within(duplicate).queryByRole('button', { name: 'Salvar ajuste' })).not.toBeInTheDocument()

    await user.selectOptions(within(repairable).getByLabelText('Categoria'), 'income-category')
    await user.click(within(repairable).getByRole('button', { name: 'Salvar ajuste' }))
    await waitFor(() => expect(importsApi.updateItem).toHaveBeenCalledWith('import-1', 'item-1', expect.objectContaining({
      categoryId: 'income-category',
    })))
  })

  it('requires explicit confirmation before importing a possible duplicate', async () => {
    const possibleDuplicateSession: FinancialImportSession = {
      ...repairableInvalidSession,
      items: repairableInvalidSession.items!.map((item) => item.sequence === 2
        ? { ...item, canIncludeDuplicate: true }
        : item),
    }
    vi.mocked(importsApi.list).mockResolvedValueOnce({ items: [{ ...possibleDuplicateSession, items: undefined }] })
    vi.mocked(importsApi.get).mockResolvedValueOnce(possibleDuplicateSession)
    const user = userEvent.setup()
    await renderPage()
    await user.click(await screen.findByRole('button', { name: 'Ver detalhes' }))

    const duplicate = (await screen.findByText('Movimentação 2')).closest('li') as HTMLElement
    await user.click(within(duplicate).getByRole('button', { name: 'Importar mesmo assim' }))

    await waitFor(() => expect(importsApi.updateItem).toHaveBeenCalledWith('import-1', 'item-2', expect.objectContaining({
      includeDuplicate: true,
    })))
  })

  it('shows newly detected duplicates before importing any movement', async () => {
    const revalidatedPreview: FinancialImportSession = {
      ...previewSession,
      summary: { total: 3, valid: 0, duplicate: 1, invalid: 1, uncategorized: 1, imported: 0 },
      items: previewSession.items!.map((item) => item.sequence === 2
        ? { ...item, validationStatus: 'duplicate', canEdit: false, canIncludeDuplicate: true }
        : item),
    }
    vi.mocked(importsApi.list).mockResolvedValueOnce({ items: [{ ...previewSession, items: undefined }] })
    vi.mocked(importsApi.get).mockResolvedValueOnce(previewSession)
    vi.mocked(importsApi.confirm).mockResolvedValueOnce(revalidatedPreview)
    const user = userEvent.setup()
    await renderPage()
    await user.click(await screen.findByRole('button', { name: 'Ver detalhes' }))
    await user.click(screen.getByRole('button', { name: 'Confirmar 1 movimentação' }))

    expect(await screen.findByText(/A validação encontrou 1 duplicidade/)).toBeVisible()
    expect(screen.getByRole('button', { name: 'Importar mesmo assim' })).toBeVisible()
    expect(importsApi.confirm).toHaveBeenCalledWith('import-1')
  })

  it('keeps the returned items visible after confirmation and undo', async () => {
    const confirmed = {
      ...completedSession,
      summary: { ...completedSession.summary, valid: 0, imported: 1 },
      items: previewSession.items!.map((item) => item.id === 'item-2'
        ? { ...item, validationStatus: 'imported' as const, canEdit: false }
        : item),
    }
    const undone = {
      ...confirmed,
      status: 'undone' as const,
      canUndo: false,
      summary: { ...confirmed.summary, imported: 0, uncategorized: confirmed.summary.uncategorized + 1 },
      items: confirmed.items.map((item) => item.id === 'item-2'
        ? { ...item, categoryId: null, subcategoryId: null, validationStatus: 'uncategorized' as const, canEdit: false }
        : item),
    }
    vi.mocked(importsApi.list).mockResolvedValueOnce({ items: [{ ...previewSession, items: undefined }] })
    vi.mocked(importsApi.get).mockResolvedValueOnce(previewSession)
    vi.mocked(importsApi.confirm).mockResolvedValueOnce(confirmed)
    vi.mocked(importsApi.undo).mockResolvedValueOnce(undone)
    const user = userEvent.setup()
    await renderPage()
    await user.click(await screen.findByRole('button', { name: 'Ver detalhes' }))
    await user.click(screen.getByRole('button', { name: 'Confirmar 1 movimentação' }))

    const preview = (await screen.findByText('extrato.ofx', { selector: 'h2' })).closest('section') as HTMLElement
    expect(within(preview).getByText('Movimentação 2')).toBeVisible()
    expect(within(preview).getByText('Importada')).toBeVisible()
    await user.click(within(preview).getByRole('button', { name: 'Desfazer importação' }))
    const undoneItem = (await within(preview).findByText('Movimentação 2')).closest('li') as HTMLElement
    expect(within(undoneItem).getAllByText('Não categorizada')[0]).toBeVisible()
    expect(within(undoneItem).getByLabelText('Categoria')).toHaveValue('')
  })

  it('discards a preview only after confirmation and preserves the returned history', async () => {
    vi.mocked(importsApi.list).mockResolvedValueOnce({ items: [{ ...previewSession, items: undefined }] })
    vi.mocked(importsApi.get).mockResolvedValueOnce(previewSession)
    const user = userEvent.setup()
    await renderPage()
    await user.click(await screen.findByRole('button', { name: 'Ver detalhes' }))

    await user.click(screen.getByRole('button', { name: 'Descartar prévia' }))

    await waitFor(() => expect(importsApi.discard).toHaveBeenCalledWith('import-1'))
    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining('extrato.ofx'))
    expect(await screen.findByText('Prévia descartada. Nenhuma movimentação foi criada.')).toBeVisible()
    expect(screen.getAllByText('Importação descartada pelo usuário.')).toHaveLength(2)
    expect(screen.getAllByText('Descartada').length).toBeGreaterThan(0)
    const discardedItem = screen.getByText('Movimentação 2').closest('li') as HTMLElement
    expect(within(discardedItem).getByLabelText('Categoria')).toHaveValue('')
    expect(screen.queryByRole('button', { name: 'Descartar prévia' })).not.toBeInTheDocument()
  })

  it('shows safe failure details and the confirming state without actions', async () => {
    vi.mocked(importsApi.list).mockResolvedValueOnce({ items: [{ ...failedSession, items: undefined }] })
    vi.mocked(importsApi.get).mockResolvedValueOnce(failedSession)
    const user = userEvent.setup()
    await renderPage()
    expect(screen.getByText(failedSession.failureMessage!)).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Ver detalhes' }))
    expect(screen.getAllByText(failedSession.failureMessage!)).toHaveLength(2)

    cleanup()
    vi.mocked(importsApi.list).mockResolvedValueOnce({ items: [{ ...confirmingSession, items: undefined }] })
    vi.mocked(importsApi.get).mockResolvedValueOnce(confirmingSession)
    render(
      <WalletProvider userId="user-1">
        <FinancialImportsPage userEmail="tito@example.com" isLoggingOut={false} onLogout={vi.fn()} />
      </WalletProvider>,
    )
    await user.click(await screen.findByRole('button', { name: 'Ver detalhes' }))
    expect(await screen.findByText(/Confirmando os lançamentos/)).toBeVisible()
    expect(screen.queryByRole('button', { name: /Confirmar \d/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Desfazer importação' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Salvar ajuste' })).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Descrição')).not.toBeInTheDocument()
  })

  it('paginates large previews locally', async () => {
    const items = Array.from({ length: 205 }, (_, index): FinancialImportItem => ({
      ...previewSession.items![1],
      id: `item-${index + 1}`,
      sequence: index + 1,
      description: `Movimentação paginada ${index + 1}`,
    }))
    const largeSession: FinancialImportSession = {
      ...previewSession,
      summary: { total: items.length, valid: items.length, duplicate: 0, invalid: 0, uncategorized: 0, imported: 0 },
      items,
    }
    vi.mocked(importsApi.list).mockResolvedValueOnce({ items: [{ ...largeSession, items: undefined }] })
    vi.mocked(importsApi.get).mockResolvedValueOnce(largeSession)
    const user = userEvent.setup()
    await renderPage()
    await user.click(await screen.findByRole('button', { name: 'Ver detalhes' }))

    expect(await screen.findByText('Movimentação 100')).toBeVisible()
    expect(screen.queryByText('Movimentação 101')).not.toBeInTheDocument()
    expect(screen.getByText('Mostrando 1–100 de 205')).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Próxima' }))
    expect(screen.queryByText('Movimentação 1')).not.toBeInTheDocument()
    expect(screen.getByText('Movimentação 101')).toBeVisible()
    expect(screen.getByText('Mostrando 101–200 de 205')).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Última' }))
    expect(screen.getByText('Movimentação 205')).toBeVisible()
    expect(screen.getByText('Página 3 de 3')).toBeVisible()
  })

  it('pauses polling after bounded backoff and recovers through the explicit retry', async () => {
    vi.mocked(importsApi.list).mockResolvedValueOnce({ items: [{ ...confirmingSession, items: undefined }] })
    vi.mocked(importsApi.get)
      .mockResolvedValueOnce(confirmingSession)
      .mockRejectedValueOnce(new Error('temporary 1'))
      .mockRejectedValueOnce(new Error('temporary 2'))
      .mockRejectedValueOnce(new Error('temporary 3'))
      .mockResolvedValueOnce(completedSession)
    await renderPage()
    vi.useFakeTimers()
    fireEvent.click(screen.getByRole('button', { name: 'Ver detalhes' }))
    await act(async () => { await Promise.resolve() })
    expect(importsApi.get).toHaveBeenCalledTimes(1)

    await act(async () => { await vi.advanceTimersByTimeAsync(1500) })
    expect(importsApi.get).toHaveBeenCalledTimes(2)
    expect(screen.getByText(/Nova tentativa automática 2 de 3/)).toBeVisible()
    await act(async () => { await vi.advanceTimersByTimeAsync(3000) })
    expect(importsApi.get).toHaveBeenCalledTimes(3)
    expect(screen.getByText(/Nova tentativa automática 3 de 3/)).toBeVisible()
    await act(async () => { await vi.advanceTimersByTimeAsync(6000) })
    expect(importsApi.get).toHaveBeenCalledTimes(4)
    expect(screen.getByText(/acompanhamento automático foi pausado/i)).toBeVisible()

    fireEvent.click(screen.getByRole('button', { name: 'Tentar acompanhar novamente' }))
    await act(async () => { await vi.advanceTimersByTimeAsync(1500) })
    expect(importsApi.get).toHaveBeenCalledTimes(5)
    expect(screen.getByText(/2 movimentações foram importadas com segurança/)).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Tentar acompanhar novamente' })).not.toBeInTheDocument()
  }, 10_000)

  it('shows undo eligibility and refreshes the history when the active wallet changes', async () => {
    vi.mocked(importsApi.list).mockResolvedValue({ items: [{ ...completedSession, items: undefined }] })
    const user = userEvent.setup()
    await renderPage()
    await user.click(await screen.findByRole('button', { name: 'Desfazer' }))
    await waitFor(() => expect(importsApi.undo).toHaveBeenCalledWith('import-1'))
    expect(await screen.findByText(/Importação desfeita/)).toBeVisible()

    await user.selectOptions(screen.getByRole('combobox', { name: /Carteira ativa/ }), 'wallet-shared')
    await waitFor(() => expect(importsApi.list).toHaveBeenCalledTimes(2))
    expect(screen.getByText((_, element) => Boolean(element?.classList.contains('imports-wallet') && element.textContent === 'Carteira: Família'))).toBeVisible()
  })

  it('discards a delayed upload response after the active wallet changes', async () => {
    const upload = deferred<FinancialImportSession>()
    vi.mocked(importsApi.upload).mockReturnValueOnce(upload.promise)
    const user = userEvent.setup()
    await renderPage()
    const file = new File(['OFXDATA'], 'conta-antiga.ofx', { type: 'application/x-ofx' })
    await user.upload(screen.getByLabelText('Arquivo OFX ou CSV'), file)
    await user.click(screen.getByRole('button', { name: 'Enviar e preparar prévia' }))
    await waitFor(() => expect(importsApi.upload).toHaveBeenCalledWith(file, 'ofx'))

    await user.selectOptions(screen.getByRole('combobox', { name: /Carteira ativa/ }), 'wallet-shared')
    await waitFor(() => expect(importsApi.list).toHaveBeenCalledTimes(2))
    await act(async () => {
      upload.resolve({ ...previewSession, fileName: 'conta-antiga.ofx' })
      await upload.promise
    })

    expect(screen.queryByText(/Arquivo recebido/)).not.toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'conta-antiga.ofx' })).not.toBeInTheDocument()
    expect(screen.getByText((_, element) => Boolean(element?.classList.contains('imports-wallet') && element.textContent === 'Carteira: Família'))).toBeVisible()
  })

  it('discards a delayed CSV inspection after the active wallet changes', async () => {
    const inspection = deferred<CsvInspection>()
    vi.mocked(importsApi.inspectCsv).mockReturnValueOnce(inspection.promise)
    const user = userEvent.setup()
    await renderPage()
    await user.upload(screen.getByLabelText('Arquivo OFX ou CSV'), new File(['csv'], 'conta-antiga.csv', { type: 'text/csv' }))
    await waitFor(() => expect(importsApi.inspectCsv).toHaveBeenCalled())

    await user.selectOptions(screen.getByRole('combobox', { name: /Carteira ativa/ }), 'wallet-shared')
    await waitFor(() => expect(importsApi.list).toHaveBeenCalledTimes(2))
    await act(async () => {
      inspection.resolve(csvInspection)
      await inspection.promise
    })

    expect(screen.queryByRole('heading', { name: 'Confira como as colunas serão interpretadas' })).not.toBeInTheDocument()
    expect(screen.getByLabelText('Arquivo OFX ou CSV')).toBeEnabled()
  })

  it('discards delayed import details after the active wallet changes', async () => {
    const details = deferred<FinancialImportSession>()
    vi.mocked(importsApi.list).mockResolvedValueOnce({ items: [{ ...previewSession, items: undefined }] })
    vi.mocked(importsApi.get).mockReturnValueOnce(details.promise)
    const user = userEvent.setup()
    await renderPage()
    await user.click(await screen.findByRole('button', { name: 'Ver detalhes' }))
    await waitFor(() => expect(importsApi.get).toHaveBeenCalledWith('import-1'))

    await user.selectOptions(screen.getByRole('combobox', { name: /Carteira ativa/ }), 'wallet-shared')
    await waitFor(() => expect(importsApi.list).toHaveBeenCalledTimes(2))
    await act(async () => {
      details.resolve(previewSession)
      await details.promise
    })

    expect(screen.queryByRole('heading', { name: 'extrato.ofx' })).not.toBeInTheDocument()
    expect(screen.queryByText('Movimentação 1')).not.toBeInTheDocument()
    expect(screen.getByText((_, element) => Boolean(element?.classList.contains('imports-wallet') && element.textContent === 'Carteira: Família'))).toBeVisible()
  })

  it('clears wallet-scoped state and blocks upload when the new wallet fails to load', async () => {
    vi.mocked(importsApi.list)
      .mockResolvedValueOnce({ items: [{ ...previewSession, items: undefined }] })
      .mockRejectedValueOnce(new Error('load failed'))
    const user = userEvent.setup()
    await renderPage()
    await user.click(await screen.findByRole('button', { name: 'Ver detalhes' }))
    const firstItem = (await screen.findByText('Movimentação 1')).closest('li') as HTMLElement
    await user.selectOptions(within(firstItem).getByLabelText('Categoria'), 'income-category')

    const input = screen.getByLabelText('Arquivo OFX ou CSV') as HTMLInputElement
    const previousWalletFile = new File(['OFXDATA'], 'carteira-pessoal.ofx', { type: 'application/x-ofx' })
    await user.upload(input, previousWalletFile)
    expect(screen.getByText(/carteira-pessoal\.ofx/)).toBeVisible()

    await user.selectOptions(screen.getByRole('combobox', { name: /Carteira ativa/ }), 'wallet-shared')
    expect(await screen.findByRole('alert')).toHaveTextContent('Não foi possível carregar o histórico de importações')

    expect(screen.queryByText('Movimentação 1')).not.toBeInTheDocument()
    expect(screen.queryByText(/Existem ajustes não salvos/)).not.toBeInTheDocument()
    expect(screen.queryByText(/carteira-pessoal\.ofx/)).not.toBeInTheDocument()
    const currentInput = screen.getByLabelText('Arquivo OFX ou CSV') as HTMLInputElement
    expect(currentInput).not.toBe(input)
    expect(currentInput.files).toHaveLength(0)
    expect(currentInput).toBeDisabled()
    const uploadButton = screen.getByRole('button', { name: 'Enviar e preparar prévia' })
    expect(uploadButton).toBeDisabled()
    await user.click(uploadButton)
    fireEvent.submit(uploadButton.closest('form')!)
    expect(importsApi.upload).not.toHaveBeenCalled()
  })

  it('shows action errors while the user remains in the same wallet', async () => {
    vi.mocked(importsApi.list).mockResolvedValueOnce({ items: [{ ...previewSession, items: undefined }] })
    vi.mocked(importsApi.upload).mockRejectedValueOnce(new Error('upload failed'))
    vi.mocked(importsApi.get).mockRejectedValueOnce(new Error('open failed'))
    const user = userEvent.setup()
    await renderPage()
    const file = new File(['OFXDATA'], 'extrato.ofx', { type: 'application/x-ofx' })
    await user.upload(screen.getByLabelText('Arquivo OFX ou CSV'), file)
    await user.click(screen.getByRole('button', { name: 'Enviar e preparar prévia' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Não foi possível enviar o arquivo')

    await user.click(screen.getByRole('button', { name: 'Ver detalhes' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Não foi possível abrir esta importação')
  })

  it('keeps the preview unchanged when saving an adjustment fails', async () => {
    vi.mocked(importsApi.list).mockResolvedValueOnce({ items: [{ ...previewSession, items: undefined }] })
    vi.mocked(importsApi.get).mockResolvedValueOnce(previewSession)
    vi.mocked(importsApi.updateItem).mockRejectedValueOnce(new Error('update failed'))
    const user = userEvent.setup()
    await renderPage()
    await user.click(await screen.findByRole('button', { name: 'Ver detalhes' }))
    const item = (await screen.findByText('Movimentação 1')).closest('li') as HTMLElement
    await user.selectOptions(within(item).getByLabelText('Categoria'), 'income-category')
    await user.click(within(item).getByRole('button', { name: 'Salvar ajuste' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Não foi possível atualizar a movimentação')
    expect(screen.getByRole('button', { name: 'Confirmar 1 movimentação' })).toBeDisabled()
    expect(screen.getByText(/Existem ajustes não salvos/)).toBeVisible()
  })

  it('locks an item while saving and only enables confirmation with the persisted response', async () => {
    const update = deferred<FinancialImportItem>()
    vi.mocked(importsApi.list).mockResolvedValueOnce({ items: [{ ...previewSession, items: undefined }] })
    vi.mocked(importsApi.get).mockResolvedValueOnce(previewSession)
    vi.mocked(importsApi.updateItem).mockReturnValueOnce(update.promise)
    const user = userEvent.setup()
    await renderPage()
    await user.click(await screen.findByRole('button', { name: 'Ver detalhes' }))

    const item = (await screen.findByText('Movimentação 1')).closest('li') as HTMLElement
    const description = within(item).getByLabelText('Descrição')
    await user.selectOptions(within(item).getByLabelText('Categoria'), 'income-category')
    await user.clear(description)
    await user.type(description, 'Descrição persistida')
    await user.click(within(item).getByRole('button', { name: 'Salvar ajuste' }))

    await waitFor(() => expect(importsApi.updateItem).toHaveBeenCalledWith('import-1', 'item-1', expect.objectContaining({
      description: 'Descrição persistida', categoryId: 'income-category',
    })))
    expect(within(item).getByLabelText('Data')).toBeDisabled()
    expect(within(item).getByLabelText('Tipo')).toBeDisabled()
    expect(description).toBeDisabled()
    expect(within(item).getByLabelText('Categoria')).toBeDisabled()
    expect(within(item).getByLabelText('Subcategoria')).toBeDisabled()
    expect(within(item).getByRole('button', { name: 'Salvando…' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Confirmar 1 movimentação' })).toBeDisabled()

    await user.type(description, ' não deve entrar')
    expect(description).toHaveValue('Descrição persistida')

    await act(async () => {
      update.resolve({
        ...previewSession.items![0],
        description: 'Descrição persistida',
        categoryId: 'income-category',
        validationStatus: 'valid',
      })
      await update.promise
    })

    expect(description).toHaveValue('Descrição persistida')
    expect(screen.getByRole('button', { name: 'Confirmar 2 movimentações' })).toBeEnabled()
    await user.click(screen.getByRole('button', { name: 'Confirmar 2 movimentações' }))
    await waitFor(() => expect(importsApi.confirm).toHaveBeenCalledWith('import-1'))
  })

  it('marks rule suggestions and learns a rule from a saved manual classification only after confirmation', async () => {
    const ruleSession: FinancialImportSession = {
      ...previewSession,
      items: previewSession.items!.map((item) => item.id === 'item-2' ? { ...item, categorizationSource: 'rule' as const } : item),
    }
    vi.mocked(importsApi.list).mockResolvedValueOnce({ items: [{ ...ruleSession, items: undefined }] })
    vi.mocked(importsApi.get).mockResolvedValue(ruleSession)
    vi.mocked(importsApi.updateItem).mockImplementation(async (_importId, itemId, input) => ({
      ...ruleSession.items!.find((item) => item.id === itemId)!,
      ...input,
      validationStatus: input.categoryId ? 'valid' : 'uncategorized',
      categorizationSource: input.categoryId ? 'manual' : null,
    }))
    const createRule = vi.spyOn(importsApi, 'createCategorizationRule').mockResolvedValue({
      id: 'rule-1', type: 'income', description: 'Salário', categoryId: 'income-category', categoryName: 'Salário',
      subcategoryId: 'income-subcategory', subcategoryName: 'Mensal', isActive: true, isStale: false,
      createdAt: '2026-11-05T12:00:00.000Z', updatedAt: '2026-11-05T12:00:00.000Z',
    })
    const user = userEvent.setup()
    await renderPage()
    await user.click(await screen.findByRole('button', { name: 'Ver detalhes' }))

    const suggestedItem = (await screen.findByText('Movimentação 2')).closest('li') as HTMLElement
    expect(within(suggestedItem).getByText('Categoria sugerida por regra desta carteira')).toBeVisible()
    expect(within(suggestedItem).queryByRole('button', { name: 'Criar regra para esta descrição' })).not.toBeInTheDocument()

    const firstItem = screen.getByText('Movimentação 1').closest('li') as HTMLElement
    expect(within(firstItem).queryByRole('button', { name: 'Criar regra para esta descrição' })).not.toBeInTheDocument()
    await user.selectOptions(within(firstItem).getByLabelText('Categoria'), 'income-category')
    await user.selectOptions(within(firstItem).getByLabelText('Subcategoria'), 'income-subcategory')
    expect(within(firstItem).queryByRole('button', { name: 'Criar regra para esta descrição' })).not.toBeInTheDocument()
    await user.click(within(firstItem).getByRole('button', { name: 'Salvar ajuste' }))
    const learnButton = await within(firstItem).findByRole('button', { name: 'Criar regra para esta descrição' })

    vi.mocked(window.confirm).mockReturnValueOnce(false)
    await user.click(learnButton)
    expect(createRule).not.toHaveBeenCalled()

    await user.click(learnButton)
    expect(window.confirm).toHaveBeenLastCalledWith(expect.stringContaining('“Salário” como Salário / Mensal'))
    await waitFor(() => expect(createRule).toHaveBeenCalledWith({
      type: 'income', description: 'Salário', categoryId: 'income-category', subcategoryId: 'income-subcategory',
    }))
    expect(await screen.findByText('Regra criada. Ela será aplicada às próximas importações desta carteira.')).toBeVisible()
  })

  it('manages wallet rules, flags removed categories, and keeps errors visible', async () => {
    vi.spyOn(importsApi, 'listCategorizationRules').mockResolvedValue({ items: [{
      id: 'rule-stale', type: 'expense', description: 'Padaria', categoryId: 'removed-category', categoryName: null,
      subcategoryId: null, subcategoryName: null, isActive: false, isStale: true,
      createdAt: '2026-11-05T12:00:00.000Z', updatedAt: '2026-11-05T12:00:00.000Z',
    }] })
    const createRule = vi.spyOn(importsApi, 'createCategorizationRule')
      .mockRejectedValueOnce(new FinancialImportApiError('Já existe uma regra para esta descrição e tipo nesta carteira.', 409))
      .mockResolvedValueOnce({
        id: 'rule-new', type: 'expense', description: 'Mercado', categoryId: 'expense-category', categoryName: 'Alimentação',
        subcategoryId: 'expense-subcategory', subcategoryName: 'Mercado', isActive: true, isStale: false,
        createdAt: '2026-11-05T12:00:00.000Z', updatedAt: '2026-11-05T12:00:00.000Z',
      })
    const updateRule = vi.spyOn(importsApi, 'updateCategorizationRule').mockImplementation(async (ruleId, input) => ({
      id: ruleId, ...input, subcategoryId: input.subcategoryId ?? null, isActive: input.isActive ?? true,
      categoryName: 'Alimentação', subcategoryName: null, isStale: false,
      createdAt: '2026-11-05T12:00:00.000Z', updatedAt: '2026-11-05T12:10:00.000Z',
    }))
    const deleteRule = vi.spyOn(importsApi, 'deleteCategorizationRule').mockResolvedValue(undefined)
    const user = userEvent.setup()
    await renderPage()

    await user.click(screen.getByRole('button', { name: 'Gerenciar regras' }))
    const rules = screen.getByRole('region', { name: 'Regras por carteira' })
    expect(await within(rules).findByText('Padaria')).toBeVisible()
    expect(within(rules).getByText(/Categoria removida\. Edite a regra/)).toBeVisible()
    expect(within(rules).getByText('Regra desativada')).toBeVisible()

    await user.type(within(rules).getByLabelText('Descrição exata da movimentação'), 'Mercado')
    await user.selectOptions(within(rules).getByLabelText('Categoria'), 'expense-category')
    await user.selectOptions(within(rules).getByLabelText('Subcategoria'), 'expense-subcategory')
    await user.click(within(rules).getByRole('button', { name: 'Confirmar e criar regra' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Já existe uma regra para esta descrição e tipo nesta carteira.')
    await user.click(within(rules).getByRole('button', { name: 'Confirmar e criar regra' }))
    await waitFor(() => expect(createRule).toHaveBeenLastCalledWith({
      type: 'expense', description: 'Mercado', categoryId: 'expense-category', subcategoryId: 'expense-subcategory', isActive: true,
    }))
    expect(await within(within(rules).getByRole('list')).findByText('Mercado')).toBeVisible()

    const staleRule = within(rules).getByText('Padaria').closest('li') as HTMLElement
    await user.click(within(staleRule).getByRole('button', { name: 'Editar' }))
    await user.selectOptions(within(rules).getByLabelText('Categoria'), 'expense-category')
    await user.click(within(rules).getByLabelText('Regra ativa'))
    await user.click(within(rules).getByRole('button', { name: 'Salvar alterações' }))
    await waitFor(() => expect(updateRule).toHaveBeenCalledWith('rule-stale', {
      type: 'expense', description: 'Padaria', categoryId: 'expense-category', subcategoryId: null, isActive: true,
    }))
    await waitFor(() => expect(within(rules).queryByText(/Categoria removida\. Edite a regra/)).not.toBeInTheDocument())

    const updatedRule = within(rules).getByText('Padaria').closest('li') as HTMLElement
    vi.mocked(window.confirm).mockReturnValueOnce(false)
    await user.click(within(updatedRule).getByRole('button', { name: 'Excluir' }))
    expect(deleteRule).not.toHaveBeenCalled()
    await user.click(within(updatedRule).getByRole('button', { name: 'Excluir' }))
    await waitFor(() => expect(deleteRule).toHaveBeenCalledWith('rule-stale'))
    await waitFor(() => expect(within(rules).queryByText('Padaria')).not.toBeInTheDocument())
  })
  describe('credit card statements', () => {
    const cardPreview: FinancialImportSession = {
      ...previewSession,
      id: 'card-import-1',
      fileName: 'fatura.ofx',
      kind: 'credit_card_statement',
      creditCardId: 'card-1',
      creditCardName: 'Principal',
      creditCardClosingDay: 10,
      creditCardDueDay: 20,
      summary: { total: 3, valid: 2, duplicate: 0, invalid: 0, uncategorized: 1, imported: 0 },
      statements: [
        { closingDate: '2026-11-10', dueDate: '2026-11-20', purchasesAmount: '50.25', creditsAmount: '20.25', totalAmount: '30.00', isPaid: false },
      ],
      items: [
        {
          id: 'card-item-1', sequence: 1, date: '2026-10-11', description: 'LIVRARIA', amount: '50.25', type: 'expense',
          categoryId: 'expense-category', subcategoryId: null, validationStatus: 'valid', errorMessage: null, canEdit: true,
          statementClosingDate: '2026-11-10', statementDueDate: '2026-11-20',
        },
        {
          id: 'card-item-2', sequence: 2, date: '2026-10-12', description: 'Estorno de LIVRARIA', amount: '20.25', type: 'card_credit',
          categoryId: null, subcategoryId: null, validationStatus: 'valid', errorMessage: null, canEdit: true,
          statementClosingDate: '2026-11-10', statementDueDate: '2026-11-20',
        },
        {
          id: 'card-item-3', sequence: 3, date: '2026-10-15', description: 'Pagamento recebido', amount: '500.00', type: 'transfer',
          categoryId: null, subcategoryId: null, validationStatus: 'uncategorized',
          errorMessage: 'Pagamento da fatura: ele é conciliado com o extrato bancário e não é importado como estorno.', canEdit: true,
          statementClosingDate: '2026-11-10', statementDueDate: '2026-11-20',
        },
      ],
    }

    beforeEach(() => {
      vi.spyOn(creditCardsApi, 'list').mockResolvedValue({ items: [
        { id: 'card-1', nickname: 'Principal', closingDay: 10, dueDay: 20, isActive: true },
        { id: 'card-old', nickname: 'Antigo', closingDay: 5, dueDay: 15, isActive: false },
      ] })
    })

    it('requires an active card of the wallet before uploading a card OFX statement', async () => {
      const user = userEvent.setup()
      await renderPage()
      await user.click(screen.getByRole('radio', { name: 'Fatura de cartão' }))
      const cardSelect = await screen.findByRole('combobox', { name: 'Cartão da fatura' })
      await waitFor(() => expect(within(cardSelect).getByRole('option', { name: 'Principal' })).toBeInTheDocument())
      expect(within(cardSelect).queryByRole('option', { name: 'Antigo' })).not.toBeInTheDocument()
      const file = new File(['OFXDATA'], 'fatura.ofx', { type: 'application/x-ofx' })
      await user.upload(screen.getByLabelText('Arquivo OFX ou CSV'), file)
      expect(screen.getByRole('button', { name: 'Enviar e preparar prévia' })).toBeDisabled()

      await user.selectOptions(cardSelect, 'card-1')
      await user.click(screen.getByRole('button', { name: 'Enviar e preparar prévia' }))
      await waitFor(() => expect(importsApi.upload).toHaveBeenCalledWith(file, 'ofx', undefined, { creditCardId: 'card-1' }))
    })

    it('asks how a card CSV signs purchases and sends that choice', async () => {
      const user = userEvent.setup()
      await renderPage()
      await user.click(screen.getByRole('radio', { name: 'Fatura de cartão' }))
      await user.selectOptions(await screen.findByRole('combobox', { name: 'Cartão da fatura' }), 'card-1')
      const file = new File(['Data;Histórico;Valor\n23/10/2026;Mercado;120,50'], 'fatura.csv', { type: 'text/csv' })
      await user.upload(screen.getByLabelText('Arquivo OFX ou CSV'), file)
      const sign = await screen.findByRole('combobox', { name: 'Como o CSV mostra as compras' })
      await waitFor(() => expect(importsApi.inspectCsv).toHaveBeenCalled())
      expect(screen.getByRole('button', { name: 'Enviar e preparar prévia' })).toBeDisabled()

      await user.selectOptions(sign, 'purchases_positive')
      await user.click(screen.getByRole('button', { name: 'Enviar e preparar prévia' }))
      await waitFor(() => expect(importsApi.upload).toHaveBeenCalledWith(
        file,
        'csv',
        expect.objectContaining({ configuration: expect.any(Object) }),
        { creditCardId: 'card-1', amountSign: 'purchases_positive' },
      ))
    })

    it('shows calculated statements and lets a purchase move to a neighbouring statement', async () => {
      const user = userEvent.setup()
      vi.spyOn(importsApi, 'upload').mockResolvedValue(cardPreview)
      vi.spyOn(importsApi, 'get').mockResolvedValue(cardPreview)
      vi.spyOn(importsApi, 'updateItem').mockImplementation(async (_importId, itemId, input) => ({
        ...cardPreview.items!.find((item) => item.id === itemId)!,
        ...input,
      }))
      await renderPage()
      await user.click(screen.getByRole('radio', { name: 'Fatura de cartão' }))
      await user.selectOptions(await screen.findByRole('combobox', { name: 'Cartão da fatura' }), 'card-1')
      await user.upload(screen.getByLabelText('Arquivo OFX ou CSV'), new File(['OFXDATA'], 'fatura.ofx', { type: 'application/x-ofx' }))
      await user.click(screen.getByRole('button', { name: 'Enviar e preparar prévia' }))

      const statements = await screen.findByRole('table', { name: 'Faturas calculadas' })
      expect(within(statements).getByRole('rowheader', { name: /Fecha 10\/11\/2026 · vence 20\/11\/2026/ })).toBeVisible()
      expect(within(statements).getByText('R$ 30,00')).toBeVisible()

      const purchase = screen.getByText('Movimentação 1').closest('li')!
      const typeSelect = within(purchase).getByRole('combobox', { name: 'Tipo' })
      expect(within(typeSelect).getAllByRole('option').map((option) => option.textContent)).toEqual(['Compra', 'Estorno/crédito na fatura', 'Pagamento da fatura'])
      const credit = screen.getByText('Movimentação 2').closest('li')!
      expect(within(credit).queryByRole('combobox', { name: 'Categoria' })).not.toBeInTheDocument()
      const payment = screen.getByText('Movimentação 3').closest('li')!
      expect(within(payment).queryByRole('combobox', { name: 'Fatura' })).not.toBeInTheDocument()

      const statementSelect = within(purchase).getByRole('combobox', { name: 'Fatura' })
      expect(within(statementSelect).getAllByRole('option').map((option) => option.textContent)).toEqual([
        'Fecha 10/10/2026 · vence 20/10/2026',
        'Fecha 10/11/2026 · vence 20/11/2026',
        'Fecha 10/12/2026 · vence 20/12/2026',
      ])
      await user.selectOptions(statementSelect, '2026-12-10')
      await user.click(within(purchase).getByRole('button', { name: 'Salvar ajuste' }))
      await waitFor(() => expect(importsApi.updateItem).toHaveBeenCalledWith('card-import-1', 'card-item-1', expect.objectContaining({
        type: 'expense',
        statementClosingDate: '2026-12-10',
      })))
      await waitFor(() => expect(importsApi.get).toHaveBeenCalledWith('card-import-1'))
    })

    it('marks statements that were already paid in the statement options', async () => {
      const user = userEvent.setup()
      const withPaidStatement: FinancialImportSession = {
        ...cardPreview,
        statements: [
          { closingDate: '2026-10-10', dueDate: '2026-10-20', purchasesAmount: '0.00', creditsAmount: '0.00', totalAmount: '0.00', isPaid: true },
          ...cardPreview.statements!,
        ],
      }
      vi.spyOn(importsApi, 'upload').mockResolvedValue(withPaidStatement)
      vi.spyOn(importsApi, 'get').mockResolvedValue(withPaidStatement)
      await renderPage()
      await user.click(screen.getByRole('radio', { name: 'Fatura de cartão' }))
      await user.selectOptions(await screen.findByRole('combobox', { name: 'Cartão da fatura' }), 'card-1')
      await user.upload(screen.getByLabelText('Arquivo OFX ou CSV'), new File(['OFXDATA'], 'fatura.ofx', { type: 'application/x-ofx' }))
      await user.click(screen.getByRole('button', { name: 'Enviar e preparar prévia' }))

      const purchase = (await screen.findByText('Movimentação 1')).closest('li')!
      const options = within(within(purchase).getByRole('combobox', { name: 'Fatura' })).getAllByRole('option')
      expect(options.map((option) => option.textContent)).toEqual([
        'Fecha 10/10/2026 · vence 20/10/2026 · já paga',
        'Fecha 10/11/2026 · vence 20/11/2026',
        'Fecha 10/12/2026 · vence 20/12/2026',
      ])
    })

    it('reports a failed reload without claiming the saved item failed', async () => {
      const user = userEvent.setup()
      vi.spyOn(importsApi, 'upload').mockResolvedValue(cardPreview)
      vi.spyOn(importsApi, 'get').mockRejectedValue(new FinancialImportApiError('', 500))
      vi.spyOn(importsApi, 'updateItem').mockImplementation(async (_importId, itemId, input) => ({
        ...cardPreview.items!.find((item) => item.id === itemId)!,
        ...input,
      }))
      await renderPage()
      await user.click(screen.getByRole('radio', { name: 'Fatura de cartão' }))
      await user.selectOptions(await screen.findByRole('combobox', { name: 'Cartão da fatura' }), 'card-1')
      await user.upload(screen.getByLabelText('Arquivo OFX ou CSV'), new File(['OFXDATA'], 'fatura.ofx', { type: 'application/x-ofx' }))
      await user.click(screen.getByRole('button', { name: 'Enviar e preparar prévia' }))

      const purchase = (await screen.findByText('Movimentação 1')).closest('li')!
      await user.click(within(purchase).getByRole('button', { name: 'Salvar ajuste' }))

      expect(await screen.findByText(/foi salva, mas os totais das faturas não puderam ser atualizados/)).toBeVisible()
      expect(screen.queryByText('Não foi possível atualizar a movimentação.')).not.toBeInTheDocument()
      expect(screen.getByText(/Movimentação 1 atualizada na prévia/)).toBeVisible()
    })
  })
})
