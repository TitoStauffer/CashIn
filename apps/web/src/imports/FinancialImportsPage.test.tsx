import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { categoriesApi } from '../categories/categoriesApi'
import { WalletProvider } from '../wallets/WalletContext'
import { walletApi } from '../wallets/walletApi'
import { FinancialImportsPage } from './FinancialImportsPage'
import type { FinancialImportSession } from './importsApi'
import { importsApi } from './importsApi'

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
      type: 'income', categoryId: null, subcategoryId: null, validationStatus: 'uncategorized', errorMessage: null,
    },
    {
      id: 'item-2', sequence: 2, date: '2026-10-02', description: 'Mercado', amount: '150.00',
      type: 'expense', categoryId: 'expense-category', subcategoryId: null, validationStatus: 'valid', errorMessage: null,
    },
    {
      id: 'item-3', sequence: 3, date: '2026-10-03', description: 'Registro incompleto', amount: '20.00',
      type: 'expense', categoryId: null, subcategoryId: null, validationStatus: 'invalid', errorMessage: 'Dados insuficientes para importar.',
    },
  ],
  canUndo: false,
  undoBlockedReason: null,
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
    vi.spyOn(importsApi, 'get').mockResolvedValue(previewSession)
    vi.spyOn(importsApi, 'upload').mockResolvedValue({ ...previewSession, status: 'processing', items: [] })
    vi.spyOn(importsApi, 'updateItem').mockImplementation(async (_importId, itemId, input) => ({
      ...previewSession.items!.find((item) => item.id === itemId)!,
      ...input,
      validationStatus: input.categoryId ? 'valid' : 'uncategorized',
    }))
    vi.spyOn(importsApi, 'confirm').mockResolvedValue(completedSession)
    vi.spyOn(importsApi, 'undo').mockResolvedValue({ ...completedSession, status: 'undone', canUndo: false, undoneAt: '2026-10-23T12:10:00.000Z' })
    vi.spyOn(window, 'confirm').mockReturnValue(true)
  })

  afterEach(() => {
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

  it('opens the preview, edits classification and confirms only reviewable items', async () => {
    vi.mocked(importsApi.list).mockResolvedValueOnce({ items: [{ ...previewSession, items: undefined }] })
    const user = userEvent.setup()
    await renderPage()
    await user.click(await screen.findByRole('button', { name: 'Ver detalhes' }))

    const firstItem = (await screen.findByText('Movimentação 1')).closest('li') as HTMLElement
    expect(within(firstItem).getAllByText('Não categorizada')[0]).toBeVisible()
    expect(screen.getByRole('button', { name: 'Confirmar 1 movimentação' })).toBeEnabled()
    expect(screen.getByText(/Itens sem categoria \(1\) ficam fora.*Itens inválidos \(1\) ou duplicados \(0\) não serão importados/)).toBeVisible()
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
    expect(screen.getByText(/Itens sem categoria \(2\) ficam fora.*Itens inválidos \(0\) ou duplicados \(0\) não serão importados/)).toBeVisible()
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
})
