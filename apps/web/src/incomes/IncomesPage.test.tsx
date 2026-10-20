import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { categoriesApi } from '../categories/categoriesApi'
import { IncomesPage } from './IncomesPage'
import { incomesApi } from './incomesApi'

const category = { id: 'income-category', name: 'Salário', nature: 'income' as const, subcategories: [] }
const income = {
  id: 'income-1', amount: '1234.56', date: '2026-10-01', description: 'Salário mensal',
  categoryId: category.id, categoryName: category.name, subcategoryId: null, subcategoryName: null,
  createdAt: '2026-10-01T12:00:00.000Z', updatedAt: '2026-10-01T12:00:00.000Z',
}

describe('IncomesPage currency input', () => {
  beforeEach(() => {
    vi.stubGlobal('matchMedia', vi.fn(() => ({
      matches: false, media: '(max-width: 760px)', onchange: null,
      addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn(),
    })))
    vi.spyOn(categoriesApi, 'list').mockResolvedValue({ items: [category] })
    vi.spyOn(incomesApi, 'list').mockResolvedValue({ items: [income] })
    vi.spyOn(incomesApi, 'create').mockResolvedValue(income)
    vi.spyOn(incomesApi, 'update').mockResolvedValue(income)
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('formats saved values, rejects invalid pasted values, and sends a canonical decimal on create', async () => {
    const user = userEvent.setup()
    render(<IncomesPage userEmail="tito@example.com" isLoggingOut={false} onLogout={vi.fn()} />)
    await user.click(await screen.findByRole('button', { name: /Nova entrada/ }))

    const amount = screen.getByLabelText('Valor *')
    fireEvent.change(amount, { target: { value: '1,239' } })
    expect(amount).toHaveAttribute('aria-invalid', 'true')
    expect(screen.getByRole('alert')).toHaveTextContent('duas casas decimais')
    await user.click(screen.getByRole('button', { name: 'Registrar entrada' }))
    expect(incomesApi.create).not.toHaveBeenCalled()

    fireEvent.change(amount, { target: { value: '1234,56' } })
    expect(amount).toHaveValue('1.234,56')
    await user.click(screen.getByRole('button', { name: 'Registrar entrada' }))
    await waitFor(() => expect(incomesApi.create).toHaveBeenCalledWith(expect.objectContaining({ amount: '1234.56' })))
  })

  it('loads an existing amount into the edit field and updates it without losing cents', async () => {
    const user = userEvent.setup()
    render(<IncomesPage userEmail="tito@example.com" isLoggingOut={false} onLogout={vi.fn()} />)
    await user.click(await screen.findByRole('button', { name: 'Editar entrada Salário mensal' }))

    const amount = screen.getByLabelText('Valor *')
    expect(amount).toHaveValue('1.234,56')
    await user.click(screen.getByRole('button', { name: 'Cancelar' }))
    await user.click(screen.getByRole('button', { name: 'Editar entrada Salário mensal' }))
    await user.click(screen.getByRole('button', { name: 'Salvar alterações' }))
    await waitFor(() => expect(incomesApi.update).toHaveBeenCalledWith('income-1', expect.objectContaining({ amount: '1234.56' })))
  })

  it('shows a recoverable error when incomes cannot be loaded', async () => {
    const user = userEvent.setup()
    vi.mocked(incomesApi.list).mockRejectedValueOnce(new Error('offline'))
    render(<IncomesPage userEmail="tito@example.com" isLoggingOut={false} onLogout={vi.fn()} />)

    expect(await screen.findByRole('alert')).toHaveTextContent('Não foi possível conectar ao serviço.')
    await user.click(screen.getByRole('button', { name: 'Tentar novamente' }))

    expect(await screen.findByText('Salário mensal')).toBeVisible()
  })
})
