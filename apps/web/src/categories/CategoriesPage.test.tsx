import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CategoriesPage } from './CategoriesPage'
import { categoriesApi } from './categoriesApi'

const category = {
  id: 'income-category',
  name: 'Salário',
  nature: 'income' as const,
  subcategories: [{ id: 'income-subcategory', name: 'Salário mensal', categoryId: 'income-category' }],
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
    render(<CategoriesPage userEmail="tito@example.com" isLoggingOut={false} onLogout={vi.fn()} />)

    await screen.findByRole('heading', { name: 'Salário' })
    await user.click(screen.getByRole('button', { name: 'Nova categoria' }))
    await user.type(screen.getByLabelText('Nome da categoria'), 'salario')
    await user.click(screen.getByRole('button', { name: 'Salvar categoria' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Já existe uma categoria com esse nome')
    expect(categoriesApi.create).not.toHaveBeenCalled()
  })

  it('rejects a subcategory duplicate when the only difference is diacritics', async () => {
    const user = userEvent.setup()
    render(<CategoriesPage userEmail="tito@example.com" isLoggingOut={false} onLogout={vi.fn()} />)

    await user.click(await screen.findByRole('button', { name: /Adicionar subcategoria/ }))
    await user.type(screen.getByLabelText('Nome da nova subcategoria'), 'salario mensal')
    await user.click(screen.getByRole('button', { name: 'Salvar subcategoria' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Já existe uma subcategoria com esse nome')
    expect(categoriesApi.createSubcategory).not.toHaveBeenCalled()
  })

  it('shows a recoverable error when categories cannot be loaded', async () => {
    const user = userEvent.setup()
    vi.mocked(categoriesApi.list).mockRejectedValueOnce(new Error('offline'))
    render(<CategoriesPage userEmail="tito@example.com" isLoggingOut={false} onLogout={vi.fn()} />)

    expect(await screen.findByRole('alert')).toHaveTextContent('Não foi possível conectar ao serviço.')
    await user.click(screen.getByRole('button', { name: 'Tentar novamente' }))

    expect(await screen.findByRole('heading', { name: 'Salário' })).toBeVisible()
  })
})
