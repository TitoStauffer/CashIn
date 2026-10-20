import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CategoriesPage } from './CategoriesPage'
import { categoriesApi } from './categoriesApi'
import { WalletProvider } from '../wallets/WalletContext'
import { walletApi } from '../wallets/walletApi'

const category = {
  id: 'income-category',
  name: 'Salário',
  nature: 'income' as const,
  subcategories: [{ id: 'income-subcategory', name: 'Salário mensal', categoryId: 'income-category' }],
}
const personalWallet = { id: 'wallet-personal', name: 'Pessoal', isPersonal: true, role: 'owner' as const }
async function renderPage() {
  const result = render(<WalletProvider userId="user-1"><CategoriesPage userEmail="tito@example.com" isLoggingOut={false} onLogout={vi.fn()} /></WalletProvider>)
  await screen.findByRole('combobox', { name: /Carteira ativa/ })
  return result
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise })
  return { promise, resolve }
}

describe('CategoriesPage duplicate names', () => {
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
    vi.spyOn(categoriesApi, 'list').mockResolvedValue({ items: [category] })
    vi.spyOn(walletApi, 'list').mockResolvedValue({ items: [personalWallet] })
    vi.spyOn(categoriesApi, 'create').mockResolvedValue(undefined)
    vi.spyOn(categoriesApi, 'createSubcategory').mockResolvedValue(undefined)
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('rejects a category duplicate when the only difference is diacritics', async () => {
    const user = userEvent.setup()
    await renderPage()

    await screen.findByRole('heading', { name: 'Salário' })
    await user.click(screen.getByRole('button', { name: 'Nova categoria' }))
    await user.type(screen.getByLabelText('Nome da categoria'), 'salario')
    await user.click(screen.getByRole('button', { name: 'Salvar categoria' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Já existe uma categoria com esse nome')
    expect(categoriesApi.create).not.toHaveBeenCalled()
  })

  it('rejects a subcategory duplicate when the only difference is diacritics', async () => {
    const user = userEvent.setup()
    await renderPage()

    await user.click(await screen.findByRole('button', { name: /Adicionar subcategoria/ }))
    await user.type(screen.getByLabelText('Nome da nova subcategoria'), 'salario mensal')
    await user.click(screen.getByRole('button', { name: 'Salvar subcategoria' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Já existe uma subcategoria com esse nome')
    expect(categoriesApi.createSubcategory).not.toHaveBeenCalled()
  })

  it('shows a recoverable error when categories cannot be loaded', async () => {
    const user = userEvent.setup()
    vi.mocked(categoriesApi.list).mockRejectedValueOnce(new Error('offline'))
    await renderPage()

    expect(await screen.findByRole('alert')).toHaveTextContent('Não foi possível conectar ao serviço.')
    await user.click(screen.getByRole('button', { name: 'Tentar novamente' }))

    expect(await screen.findByRole('heading', { name: 'Salário' })).toBeVisible()
  })

  it('shows loading and mutation success states for category creation', async () => {
    const user = userEvent.setup()
    const initialLoad = deferred<{ items: Array<typeof category> }>()
    const createRequest = deferred<void>()
    vi.mocked(categoriesApi.list).mockReturnValueOnce(initialLoad.promise)
    vi.mocked(categoriesApi.list).mockResolvedValueOnce({ items: [category, { ...category, id: 'new-category', name: 'Freelance', subcategories: [] }] })
    vi.mocked(categoriesApi.create).mockReturnValueOnce(createRequest.promise)
    await renderPage()

    expect(screen.getByRole('status')).toHaveTextContent('Carregando categorias de entradas')
    initialLoad.resolve({ items: [category] })
    await screen.findByRole('heading', { name: 'Salário' })
    await user.click(screen.getByRole('button', { name: 'Nova categoria' }))
    await user.type(screen.getByLabelText('Nome da categoria'), 'Freelance')
    await user.click(screen.getByRole('button', { name: 'Salvar categoria' }))

    expect(screen.getByRole('button', { name: 'Salvando…' })).toBeVisible()
    createRequest.resolve()
    expect(await screen.findByRole('status')).toHaveTextContent('Categoria criada.')
    expect(await screen.findByRole('heading', { name: 'Freelance' })).toBeVisible()
  })
})
