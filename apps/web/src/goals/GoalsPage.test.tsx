import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { categoriesApi } from '../categories/categoriesApi'
import { GoalsPage } from './GoalsPage'
import { goalsApi } from './goalsApi'
import { WalletProvider } from '../wallets/WalletContext'
import { walletApi } from '../wallets/walletApi'

const goal = {
  id: 'goal-1', title: 'Carro novo', description: 'Reserva para o carro', targetAmount: '120000.00',
  dueDate: '2027-12-31', status: 'active' as const, categoryId: null, categoryName: null,
  subcategoryId: null, subcategoryName: null, contributedAmount: '15000.00', progressPercentage: 12.5,
}
const contribution = { id: 'contribution-1', amount: '15.25', date: '2026-10-01', description: 'Aporte mensal' }
const personalWallet = { id: 'wallet-personal', name: 'Pessoal', isPersonal: true, role: 'owner' as const }
async function renderPage() {
  const result = render(<WalletProvider userId="user-1"><GoalsPage userEmail="tito@example.com" isLoggingOut={false} onLogout={vi.fn()} /></WalletProvider>)
  await screen.findByRole('combobox', { name: /Carteira ativa/ })
  return result
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise })
  return { promise, resolve }
}

describe('GoalsPage currency inputs', () => {
  beforeEach(() => {
    vi.stubGlobal('matchMedia', vi.fn(() => ({
      matches: false, media: '(max-width: 760px)', onchange: null,
      addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn(),
    })))
    vi.spyOn(categoriesApi, 'list').mockResolvedValue({ items: [] })
    vi.spyOn(walletApi, 'list').mockResolvedValue({ items: [personalWallet] })
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
    await renderPage()
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
    await renderPage()
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
    await renderPage()

    await user.click(await screen.findByRole('button', { name: '＋ Registrar aporte' }))

    expect(await screen.findByLabelText('Valor *')).toBeVisible()
    await waitFor(() => expect(goalsApi.contributions).toHaveBeenCalledWith('goal-1'))
    expect(goalsApi.createContribution).not.toHaveBeenCalled()
  })

  it('reuses loaded contributions when the goal panel is reopened', async () => {
    const user = userEvent.setup()
    await renderPage()

    await user.click(await screen.findByRole('button', { name: 'Ver aportes' }))
    expect(await screen.findByText(/Aporte mensal/)).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Ocultar aportes' }))
    await user.click(screen.getByRole('button', { name: 'Ver aportes' }))

    expect(goalsApi.contributions).toHaveBeenCalledTimes(1)
    expect(screen.getByText(/Aporte mensal/)).toBeVisible()
  })

  it('shows an error when contributions cannot be loaded from the goal card', async () => {
    const user = userEvent.setup()
    vi.mocked(goalsApi.contributions).mockRejectedValueOnce(new Error('offline'))
    await renderPage()

    await user.click(await screen.findByRole('button', { name: '＋ Registrar aporte' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Não foi possível carregar os aportes.')
    expect(screen.getByLabelText('Valor *')).toBeVisible()
    expect(goalsApi.createContribution).not.toHaveBeenCalled()
  })

  it('shows a recoverable error when goals cannot be loaded', async () => {
    const user = userEvent.setup()
    vi.mocked(goalsApi.list).mockRejectedValueOnce(new Error('offline'))
    await renderPage()

    expect(await screen.findByText('Não foi possível carregar suas metas. Verifique sua conexão e tente novamente.')).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Tentar novamente' }))

    expect(await screen.findByRole('heading', { name: 'Carro novo' })).toBeVisible()
  })

  it('shows loading and mutation success states when creating a goal', async () => {
    const user = userEvent.setup()
    const initialLoad = deferred<{ items: Array<typeof goal> }>()
    const createRequest = deferred<typeof goal>()
    vi.mocked(goalsApi.list)
      .mockReturnValueOnce(initialLoad.promise)
      .mockResolvedValueOnce({ items: [goal] })
    vi.mocked(goalsApi.create).mockReturnValueOnce(createRequest.promise)
    await renderPage()

    expect(screen.getByRole('status')).toHaveTextContent('Carregando metas')
    initialLoad.resolve({ items: [goal] })
    await screen.findByRole('heading', { name: 'Carro novo' })
    await user.click(screen.getByRole('button', { name: /Nova meta/ }))
    await user.type(screen.getByLabelText('Título *'), 'Viagem')
    await user.type(screen.getByLabelText('Descrição *'), 'Reserva para viajar')
    fireEvent.change(screen.getByLabelText('Valor-alvo *'), { target: { value: '15000,00' } })
    await user.click(screen.getByRole('button', { name: 'Criar meta' }))

    expect(screen.getByRole('button', { name: 'Salvando…' })).toBeVisible()
    createRequest.resolve(goal)
    expect(await screen.findByRole('status')).toHaveTextContent('Meta criada.')
  })

  it('shows the saving and success states when registering a contribution', async () => {
    const user = userEvent.setup()
    const createRequest = deferred<typeof contribution>()
    vi.mocked(goalsApi.createContribution).mockReturnValueOnce(createRequest.promise)
    await renderPage()

    await user.click(await screen.findByRole('button', { name: '＋ Registrar aporte' }))
    await user.type(await screen.findByLabelText('Valor *'), '250,00')
    await user.click(screen.getByRole('button', { name: 'Registrar aporte' }))

    expect(screen.getByRole('button', { name: 'Salvando…' })).toBeVisible()
    createRequest.resolve(contribution)
    expect(await screen.findByRole('status')).toHaveTextContent('Aporte registrado.')
  })

  it('does not report a saved contribution as failed when refreshing the goal fails', async () => {
    const user = userEvent.setup()
    vi.mocked(goalsApi.list)
      .mockResolvedValueOnce({ items: [goal] })
      .mockRejectedValueOnce(new Error('offline'))
    await renderPage()

    await user.click(await screen.findByRole('button', { name: '＋ Registrar aporte' }))
    await user.type(await screen.findByLabelText('Valor *'), '250,00')
    await user.click(screen.getByRole('button', { name: 'Registrar aporte' }))

    expect(await screen.findByRole('status')).toHaveTextContent('Aporte registrado.')
    expect(await screen.findByRole('alert')).toHaveTextContent('O aporte foi salvo, mas não foi possível atualizar o progresso')
    expect(screen.queryByLabelText('Valor *')).not.toBeInTheDocument()
    expect(goalsApi.createContribution).toHaveBeenCalledTimes(1)
  })

  it('sends a contribution only once when the form is submitted repeatedly', async () => {
    const user = userEvent.setup()
    const createRequest = deferred<typeof contribution>()
    vi.mocked(goalsApi.createContribution).mockReturnValueOnce(createRequest.promise)
    await renderPage()

    await user.click(await screen.findByRole('button', { name: '＋ Registrar aporte' }))
    const amount = await screen.findByLabelText('Valor *')
    await user.type(amount, '250,00')
    const form = amount.closest('form')
    expect(form).not.toBeNull()
    fireEvent.submit(form as HTMLFormElement)
    fireEvent.submit(form as HTMLFormElement)

    expect(goalsApi.createContribution).toHaveBeenCalledTimes(1)
    createRequest.resolve(contribution)
    expect(await screen.findByRole('status')).toHaveTextContent('Aporte registrado.')
  })
})
