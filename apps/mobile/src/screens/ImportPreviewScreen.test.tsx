import { act, fireEvent, render, screen } from '@testing-library/react-native'
import { Alert } from 'react-native'

import { ApiError } from '../api/client'
import type { Category } from '../catalog/catalogApi'
import type { ImportApi, ImportItem, ImportSession } from '../imports/importApi'
import { ImportPreviewScreen, ITEMS_PER_PAGE, SAVE_BEFORE_CONFIRMING } from './ImportPreviewScreen'

const FOOD: Category = { id: 'cat-food', name: 'Alimentação', nature: 'expense', subcategories: [{ id: 'sub-market', name: 'Mercado', categoryId: 'cat-food' }] }
const HOME: Category = { id: 'cat-home', name: 'Casa', nature: 'expense', subcategories: [] }
const SALARY: Category = { id: 'cat-salary', name: 'Salário', nature: 'income', subcategories: [] }

const MARKET: ImportItem = {
  id: 't1', sequence: 1, date: '2026-11-05', description: 'Supermercado', amount: '120.50', type: 'expense',
  categoryId: 'cat-food', subcategoryId: 'sub-market', validationStatus: 'valid', errorMessage: null, canEdit: true,
  categorizationSource: 'rule',
}
const DUPLICATE: ImportItem = {
  id: 't2', sequence: 2, date: '2026-11-06', description: 'Padaria', amount: '15.00', type: 'expense',
  categoryId: null, subcategoryId: null, validationStatus: 'duplicate', errorMessage: 'Possível duplicidade com uma importação anterior.',
  canEdit: true, canIncludeDuplicate: true,
}
const PAYMENT: ImportItem = {
  id: 't3', sequence: 3, date: '2026-11-07', description: 'PGTO FATURA', amount: '300.00', type: 'transfer',
  categoryId: null, subcategoryId: null, validationStatus: 'uncategorized', errorMessage: 'Escolha a fatura paga.', canEdit: true,
  statementCandidates: [{ statementId: 's1', creditCardId: 'c1', creditCardName: 'Roxo', closingDate: '2026-11-01', dueDate: '2026-11-10', outstandingAmount: '300.00' }],
  transferCandidates: [], transferCounterpartWallets: [], reconciliationUnavailableReason: null,
}

const SESSION: ImportSession = {
  id: 'imp-1',
  importedBy: { userId: 'u1', email: 'eu@exemplo.com', isCurrentUser: true },
  format: 'ofx',
  kind: 'bank_statement',
  fileName: 'extrato.ofx',
  fileSize: 2048,
  status: 'preview',
  summary: { total: 3, valid: 1, duplicate: 1, invalid: 0, uncategorized: 1, imported: 0 },
  items: [MARKET, DUPLICATE, PAYMENT],
  canUndo: false,
  undoBlockedReason: null,
  failureMessage: null,
  createdAt: '2026-11-18T12:00:00.000Z',
  confirmedAt: null,
}

function fakeImportApi(session: ImportSession = SESSION, overrides: Partial<ImportApi> = {}): ImportApi {
  return {
    get: jest.fn(async () => session),
    updateItem: jest.fn(async () => MARKET),
    confirm: jest.fn(async () => ({ ...session, status: 'completed', summary: { ...session.summary, imported: 2 } })),
    discard: jest.fn(async () => ({ ...session, status: 'failed' })),
    undo: jest.fn(async () => ({ ...session, status: 'undone' })),
    ...overrides,
  } as unknown as ImportApi
}

const catalogApi = { listCategories: jest.fn(async (nature: string) => ({ items: nature === 'income' ? [SALARY] : [FOOD, HOME] })) }

async function mount(importApi = fakeImportApi()) {
  await render(<ImportPreviewScreen importId="imp-1" importApi={importApi} catalogApi={catalogApi} />)
  await screen.findByText('Supermercado')
  return { importApi }
}

function pressAlertButton(alert: jest.SpyInstance, text: string) {
  const buttons = (alert.mock.calls.at(-1)?.[2] ?? []) as { text: string; onPress?: () => void }[]
  return act(async () => { buttons.find((button) => button.text === text)?.onPress?.() })
}

describe('ImportPreviewScreen', () => {
  it('shows the preview as the API sent it: summary, lines, categories, rule and errors', async () => {
    await mount()
    expect(screen.getByText('Extrato bancário · Aguardando confirmação · importado por você')).toBeTruthy()
    expect(screen.getByText('3 movimentações · 1 prontas · 1 sem categoria · 1 duplicadas · 0 inválidas · 0 importadas')).toBeTruthy()
    expect(screen.getByText('R$ 120,50 · Saída')).toBeTruthy()
    expect(screen.getByText('Linha 1 · 05/11/2026 · Pronta para importar')).toBeTruthy()
    expect(screen.getByText('Alimentação › Mercado · sugerida por regra')).toBeTruthy()
    expect(screen.getByText('Possível duplicidade com uma importação anterior.')).toBeTruthy()
  })

  it('saves a corrected line with every field the API reads, and reads the preview again', async () => {
    const { importApi } = await mount()
    await fireEvent.press(screen.getByRole('link', { name: 'Editar movimentação 1 de 05/11/2026, R$ 120,50 (Supermercado)' }))
    await fireEvent.changeText(screen.getByLabelText('Descrição'), ' Feira ')
    await fireEvent.press(screen.getByRole('radio', { name: 'Casa' }))
    await fireEvent.press(screen.getByRole('button', { name: 'Salvar movimentação' }))
    expect(await screen.findByText('Movimentação salva.')).toBeTruthy()
    expect(importApi.updateItem).toHaveBeenCalledWith('imp-1', 't1', {
      date: '2026-11-05', description: 'Feira', type: 'expense', categoryId: 'cat-home', subcategoryId: null,
      statementClosingDate: null, creditCardStatementId: null, transferCounterpartWalletId: null, walletTransferId: null,
    })
    expect(importApi.get).toHaveBeenCalledTimes(2)
    expect(screen.queryByLabelText('Descrição')).toBeNull()
  })

  it('checks the date and the description before calling the API, and keeps the editor on a refusal', async () => {
    const updateItem = jest.fn(async () => { throw new ApiError('A data está fora do período aceito.', 400) })
    await mount(fakeImportApi(SESSION, { updateItem }))
    await fireEvent.press(screen.getByRole('link', { name: /^Editar movimentação 1/ }))
    await fireEvent.changeText(screen.getByLabelText('Data (DD/MM/AAAA)'), '31/11/2026')
    await fireEvent.press(screen.getByRole('button', { name: 'Salvar movimentação' }))
    expect(screen.getByText('Informe a data no formato DD/MM/AAAA.')).toBeTruthy()
    await fireEvent.changeText(screen.getByLabelText('Data (DD/MM/AAAA)'), '20/11/2026')
    await fireEvent.changeText(screen.getByLabelText('Descrição'), '  ')
    await fireEvent.press(screen.getByRole('button', { name: 'Salvar movimentação' }))
    expect(screen.getByText('Informe a descrição.')).toBeTruthy()
    expect(updateItem).not.toHaveBeenCalled()

    await fireEvent.changeText(screen.getByLabelText('Descrição'), 'Feira')
    await fireEvent.press(screen.getByRole('button', { name: 'Salvar movimentação' }))
    expect(await screen.findByText('A data está fora do período aceito.')).toBeTruthy()
    expect(updateItem).toHaveBeenCalledWith('imp-1', 't1', expect.objectContaining({ date: '2026-11-20' }))
    expect(screen.getByLabelText('Descrição').props.value).toBe('Feira')
  })

  it('imports a possible duplicate only when asked', async () => {
    const { importApi } = await mount()
    await fireEvent.press(screen.getByRole('link', { name: 'Importar mesmo assim movimentação 2 de 06/11/2026, R$ 15,00 (Padaria)' }))
    expect(importApi.updateItem).toHaveBeenCalledWith('imp-1', 't2', expect.objectContaining({ includeDuplicate: true, description: 'Padaria' }))
    expect(await screen.findByText('A movimentação será importada mesmo sendo uma possível duplicidade.')).toBeTruthy()
  })

  it('reconciles a bank payment with the statement the API offered', async () => {
    const { importApi } = await mount()
    await fireEvent.press(screen.getByRole('link', { name: /^Editar movimentação 3/ }))
    expect(screen.queryByText('Categoria')).toBeNull()
    await fireEvent.press(screen.getByRole('radio', { name: 'Fatura Roxo · vence 10/11/2026 · falta R$ 300,00' }))
    await fireEvent.press(screen.getByRole('button', { name: 'Salvar movimentação' }))
    expect(importApi.updateItem).toHaveBeenCalledWith('imp-1', 't3', expect.objectContaining({
      type: 'transfer', creditCardStatementId: 's1', walletTransferId: null, transferCounterpartWalletId: null,
    }))
  })

  it('asks to save the transfer type before offering a reconciliation', async () => {
    await mount()
    await fireEvent.press(screen.getByRole('link', { name: /^Editar movimentação 1/ }))
    await fireEvent.press(screen.getByRole('radio', { name: 'Transferência' }))
    expect(screen.getByText(/ainda está salva como saída/)).toBeTruthy()
    expect(screen.queryByRole('radio', { name: 'Casa' })).toBeNull()
  })

  it('drops the category of the old nature when the type changes', async () => {
    const { importApi } = await mount()
    await fireEvent.press(screen.getByRole('link', { name: /^Editar movimentação 1/ }))
    await fireEvent.press(screen.getByRole('radio', { name: 'Entrada' }))
    expect(screen.getByRole('radio', { name: 'Salário' })).toBeTruthy()
    await fireEvent.press(screen.getByRole('button', { name: 'Salvar movimentação' }))
    expect(importApi.updateItem).toHaveBeenCalledWith('imp-1', 't1', expect.objectContaining({ type: 'income', categoryId: null, subcategoryId: null }))
  })

  it('confirms with the message of what the API did, and never while a line is being edited', async () => {
    const confirm = jest.fn()
      .mockResolvedValueOnce({ ...SESSION, status: 'preview' })
      .mockResolvedValueOnce({ ...SESSION, status: 'completed', summary: { ...SESSION.summary, imported: 2 } })
    await mount(fakeImportApi(SESSION, { confirm }))
    await fireEvent.press(screen.getByRole('link', { name: /^Editar movimentação 1/ }))
    expect(screen.getByText(SAVE_BEFORE_CONFIRMING)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Confirmar importação' })).toBeNull()
    await fireEvent.press(screen.getByRole('link', { name: 'Cancelar edição' }))

    await fireEvent.press(screen.getByRole('button', { name: 'Confirmar importação' }))
    expect(await screen.findByText('A confirmação encontrou possíveis duplicidades e a prévia voltou para revisão.')).toBeTruthy()
    await fireEvent.press(screen.getByRole('button', { name: 'Confirmar importação' }))
    expect(await screen.findByText('Importação confirmada: 2 movimentações importadas.')).toBeTruthy()
  })

  it('discards the preview only after confirmation', async () => {
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined)
    const { importApi } = await mount()
    await fireEvent.press(screen.getByRole('link', { name: 'Descartar prévia' }))
    expect(importApi.discard).not.toHaveBeenCalled()
    await pressAlertButton(alert, 'Descartar')
    expect(importApi.discard).toHaveBeenCalledWith('imp-1')
    expect(await screen.findByText('Prévia descartada.')).toBeTruthy()
    alert.mockRestore()
  })

  it('undoes a completed import after confirmation, or says why it cannot', async () => {
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined)
    const completed = { ...SESSION, status: 'completed' as const, canUndo: true }
    const { importApi } = await mount(fakeImportApi(completed))
    expect(screen.queryByRole('link', { name: /^Editar/ })).toBeNull()
    await fireEvent.press(screen.getByRole('link', { name: 'Desfazer importação' }))
    await pressAlertButton(alert, 'Desfazer')
    expect(importApi.undo).toHaveBeenCalledWith('imp-1')
    expect(await screen.findByText('Importação desfeita.')).toBeTruthy()
    alert.mockRestore()
  })

  it('shows the reason an import cannot be undone, and the failure of an import', async () => {
    await mount(fakeImportApi({ ...SESSION, status: 'completed', undoBlockedReason: 'Um lançamento foi alterado depois da importação.' }))
    expect(screen.getByText('Um lançamento foi alterado depois da importação.')).toBeTruthy()
    expect(screen.queryByRole('link', { name: 'Desfazer importação' })).toBeNull()
  })

  it('moves a card purchase to the next statement, keeping it after a new date', async () => {
    const card: ImportSession = {
      ...SESSION, kind: 'credit_card_statement', creditCardName: 'Roxo', creditCardClosingDay: 10, creditCardDueDay: 17,
      statements: [{ closingDate: '2026-11-10', dueDate: '2026-11-17', purchasesAmount: '120.50', creditsAmount: '0.00', totalAmount: '120.50', isPaid: false }],
      items: [MARKET],
    }
    const { importApi } = await mount(fakeImportApi(card))
    expect(screen.getByText('Fatura que fecha em 10/11/2026 · vence em 17/11/2026')).toBeTruthy()
    expect(screen.getByText('R$ 120,50 · Compra')).toBeTruthy()
    await fireEvent.press(screen.getByRole('link', { name: /^Editar movimentação 1/ }))
    // A new date moves the purchase back to the statement it calculates.
    await fireEvent.press(screen.getByRole('radio', { name: 'Fecha em 10/12/2026' }))
    await fireEvent.changeText(screen.getByLabelText('Data (DD/MM/AAAA)'), '08/11/2026')
    expect(screen.getByRole('radio', { name: 'Pela data da compra' }).props.accessibilityState).toEqual({ selected: true })
    await fireEvent.press(screen.getByRole('radio', { name: 'Fecha em 10/12/2026' }))
    await fireEvent.press(screen.getByRole('button', { name: 'Salvar movimentação' }))
    expect(importApi.updateItem).toHaveBeenCalledWith('imp-1', 't1', expect.objectContaining({ date: '2026-11-08', statementClosingDate: '2026-12-10' }))
  })

  it('shows the lines in pages', async () => {
    const items = Array.from({ length: ITEMS_PER_PAGE + 2 }, (_, index) => ({ ...MARKET, id: `t${index}`, sequence: index + 1, description: `Compra ${index + 1}` }))
    await render(<ImportPreviewScreen importId="imp-1" importApi={fakeImportApi({ ...SESSION, items })} catalogApi={catalogApi} />)
    expect(await screen.findByText(`Compra ${ITEMS_PER_PAGE}`)).toBeTruthy()
    expect(screen.queryByText(`Compra ${ITEMS_PER_PAGE + 1}`)).toBeNull()
    await fireEvent.press(screen.getByRole('link', { name: 'Mostrar mais 2 movimentações' }))
    expect(screen.getByText(`Compra ${ITEMS_PER_PAGE + 2}`)).toBeTruthy()
  })

  it('shows why an import failed, and a read error with retry', async () => {
    const get = jest.fn()
      .mockRejectedValueOnce(new ApiError('Importação não encontrada.', 404))
      .mockResolvedValue({ ...SESSION, status: 'failed', failureMessage: 'O arquivo não é um extrato OFX válido.', items: [] })
    await render(<ImportPreviewScreen importId="imp-1" importApi={fakeImportApi(SESSION, { get })} catalogApi={catalogApi} />)
    expect(await screen.findByText('Importação não encontrada.')).toBeTruthy()
    await fireEvent.press(screen.getByRole('button', { name: 'Tentar novamente' }))
    expect(await screen.findByText('O arquivo não é um extrato OFX válido.')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Confirmar importação' })).toBeNull()
  })
})
