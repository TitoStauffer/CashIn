import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { categoriesApi } from '../categories/categoriesApi'
import { GoalsPage } from './GoalsPage'
import { goalsApi } from './goalsApi'

const goal = {
  id: 'goal-1', title: 'Carro novo', description: 'Reserva para o carro', targetAmount: '120000.00',
  dueDate: '2027-12-31', status: 'active' as const, categoryId: null, categoryName: null,
  subcategoryId: null, subcategoryName: null, contributedAmount: '15000.00', progressPercentage: 12.5,
}
const contribution = { id: 'contribution-1', amount: '15.25', date: '2026-10-01', description: 'Aporte mensal' }

describe('GoalsPage currency inputs', () => {
  beforeEach(() => {
    vi.stubGlobal('matchMedia', vi.fn(() => ({
      matches: false, media: '(max-width: 760px)', onchange: null,
      addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn(),
    })))
    vi.spyOn(categoriesApi, 'list').mockResolvedValue({ items: [] })
    vi.spyOn(goalsApi, 'list').mockResolvedValue({ items: [goal] })
    vi.spyOn(goalsApi, 'create').mockResolvedValue(goal)
    vi.spyOn(goalsApi, 'update').mockResolvedValue(goal)
    vi.spyOn(goalsApi, 'contributions').mockResolvedValue({ items: [contribution] })
    vi.spyOn(goalsApi, 'createContribution').mockResolvedValue(contribution)
    vi.spyOn(goalsApi, 'updateContribution').mockResolvedValue(contribution)
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('masks and validates a new goal amount, then sends the canonical decimal on create', async () => {
    const user = userEvent.setup()
    render(<GoalsPage userEmail="tito@example.com" isLoggingOut={false} onLogout={vi.fn()} />)
    await user.click(await screen.findByRole('button', { name: /Nova meta/ }))
    await user.type(screen.getByLabelText('Título *'), 'Viagem')
    await user.type(screen.getByLabelText('Descrição *'), 'Reserva para viagem')

    const amount = screen.getByLabelText('Valor-alvo *')
    fireEvent.change(amount, { target: { value: '12,345' } })
    expect(amount).toHaveAttribute('aria-invalid', 'true')
    await user.click(screen.getByRole('button', { name: 'Criar meta' }))
    expect(goalsApi.create).not.toHaveBeenCalled()

    fireEvent.change(amount, { target: { value: '1234,56' } })
    expect(amount).toHaveValue('1.234,56')
    await user.click(screen.getByRole('button', { name: 'Criar meta' }))
    await waitFor(() => expect(goalsApi.create).toHaveBeenCalledWith(expect.objectContaining({ targetAmount: '1234.56' })))
  })

  it('formats saved goal and contribution amounts for editing and preserves cents on update', async () => {
    const user = userEvent.setup()
    render(<GoalsPage userEmail="tito@example.com" isLoggingOut={false} onLogout={vi.fn()} />)
    await user.click(await screen.findByRole('button', { name: 'Editar meta' }))

    const goalAmount = screen.getByLabelText('Valor-alvo *')
    expect(goalAmount).toHaveValue('120.000,00')
    await user.click(screen.getByRole('button', { name: 'Salvar alterações' }))
    await waitFor(() => expect(goalsApi.update).toHaveBeenCalledWith('goal-1', expect.objectContaining({ targetAmount: '120000.00' })))

    await user.click(screen.getByRole('button', { name: 'Ver aportes' }))
    const contributionRow = await screen.findByText(/Aporte mensal/)
    const row = contributionRow.closest('li')
    expect(row).not.toBeNull()
    await user.click(within(row as HTMLElement).getByRole('button', { name: 'Editar' }))

    const contributionAmount = screen.getByLabelText('Valor *')
    expect(contributionAmount).toHaveValue('15,25')
    fireEvent.change(contributionAmount, { target: { value: '15,259' } })
    expect(contributionAmount).toHaveAttribute('aria-invalid', 'true')
    await user.click(screen.getByRole('button', { name: 'Salvar aporte' }))
    expect(goalsApi.updateContribution).not.toHaveBeenCalled()
    fireEvent.change(contributionAmount, { target: { value: '15,26' } })
    expect(contributionAmount).toHaveValue('15,26')
    await user.click(screen.getByRole('button', { name: 'Salvar aporte' }))
    await waitFor(() => expect(goalsApi.updateContribution).toHaveBeenCalledWith('goal-1', 'contribution-1', expect.objectContaining({ amount: '15.26' })))

    await user.click(screen.getByRole('button', { name: '＋ Novo aporte' }))
    const newContributionAmount = screen.getByLabelText('Valor *')
    await user.type(newContributionAmount, '12,34')
    await user.click(screen.getByRole('button', { name: 'Registrar aporte' }))
    await waitFor(() => expect(goalsApi.createContribution).toHaveBeenCalledWith('goal-1', expect.objectContaining({ amount: '12.34' })))
  })

  it('opens the contribution form from the collapsed goal card', async () => {
    const user = userEvent.setup()
    render(<GoalsPage userEmail="tito@example.com" isLoggingOut={false} onLogout={vi.fn()} />)

    await user.click(await screen.findByRole('button', { name: '＋ Registrar aporte' }))

    expect(await screen.findByLabelText('Valor *')).toBeVisible()
    await waitFor(() => expect(goalsApi.contributions).toHaveBeenCalledWith('goal-1'))
    expect(goalsApi.createContribution).not.toHaveBeenCalled()
  })
})
