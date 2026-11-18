import { act, fireEvent, render, screen } from '@testing-library/react-native'
import { Alert } from 'react-native'

import { ApiError } from '../api/client'
import type { Category } from '../catalog/catalogApi'
import type { Goal, GoalApi } from '../goals/goalApi'
import { GoalsScreen, MISSING_DESCRIPTION, MISSING_TITLE } from './GoalsScreen'

const RESERVE_CATEGORY: Category = { id: 'cat-reserve', name: 'Reserva', nature: 'investment', subcategories: [] }
// Progress is deliberately inconsistent with the amounts (1.250 of 5.000 is not 33%): the screen must
// show the API's percentage, never one it computes.
const TRIP: Goal = {
  id: 'g-trip',
  title: 'Viagem',
  description: 'Férias em família',
  targetAmount: '5000.00',
  dueDate: '2027-07-01',
  status: 'active',
  categoryId: 'cat-old',
  categoryName: 'Investimentos antigos',
  subcategoryId: 'sub-old',
  subcategoryName: 'Renda fixa',
  contributedAmount: '1250.00',
  progressPercentage: 33.333,
}
const CAR: Goal = { ...TRIP, id: 'g-car', title: 'Carro', description: 'Trocar o carro', status: 'closed', contributedAmount: '30000.00', targetAmount: '30000.00', progressPercentage: 100, dueDate: null, categoryId: null, categoryName: null, subcategoryId: null, subcategoryName: null }

function fakeGoalApi(overrides: Partial<GoalApi> = {}): GoalApi {
  return {
    list: jest.fn(async () => ({ items: [TRIP, CAR] })),
    create: jest.fn(async () => TRIP),
    update: jest.fn(async () => TRIP),
    close: jest.fn(async () => TRIP),
    ...overrides,
  } as unknown as GoalApi
}

const catalogApi = () => ({ listCategories: jest.fn(async () => ({ items: [RESERVE_CATEGORY] })) })

async function mount(goalApi = fakeGoalApi(), walletId = 'personal', refreshKey = 0, catalog = catalogApi()) {
  const onOpenContributions = jest.fn()
  const view = await render(<GoalsScreen walletId={walletId} goalApi={goalApi} catalogApi={catalog} refreshKey={refreshKey} onOpenContributions={onOpenContributions} />)
  return { goalApi, onOpenContributions, view, catalog }
}

describe('GoalsScreen', () => {
  it('shows each goal with the progress the API derived, without recomputing it', async () => {
    const { catalog } = await mount()
    expect(await screen.findByText('Viagem')).toBeTruthy()
    expect(screen.getByText('Acumulado R$ 1.250,00 de R$ 5.000,00 (33,3%)')).toBeTruthy()
    expect(screen.getByText('Prazo: 01/07/2027')).toBeTruthy()
    expect(screen.getByText('Carro · encerrada')).toBeTruthy()
    expect(catalog.listCategories).toHaveBeenCalledWith('investment')
  })

  it('creates a goal with the exact target and an optional due date', async () => {
    const { goalApi } = await mount()
    await screen.findByText('Viagem')
    await fireEvent.press(screen.getByRole('button', { name: 'Nova meta' }))
    await fireEvent.changeText(screen.getByLabelText('Nome da meta'), ' Reserva de emergência ')
    await fireEvent.changeText(screen.getByLabelText('Descrição'), ' Seis meses de gastos ')
    await fireEvent.changeText(screen.getByLabelText('Valor-alvo (R$)'), '10000,10')
    await fireEvent.press(screen.getByRole('radio', { name: 'Reserva' }))
    await fireEvent.press(screen.getByRole('button', { name: 'Salvar meta' }))
    expect(await screen.findByText('Meta criada.')).toBeTruthy()
    expect(goalApi.create).toHaveBeenCalledWith({
      title: 'Reserva de emergência',
      description: 'Seis meses de gastos',
      targetAmount: '10000.10',
      dueDate: null,
      categoryId: 'cat-reserve',
      subcategoryId: null,
    })
    expect(goalApi.list).toHaveBeenCalledTimes(2)
  })

  it('checks name, description, target and due date before calling the API, and shows the API refusal', async () => {
    const create = jest.fn(async () => { throw new ApiError('Já existe uma meta de investimento com esse nome.', 409) })
    await mount(fakeGoalApi({ create }))
    await screen.findByText('Viagem')
    await fireEvent.press(screen.getByRole('button', { name: 'Nova meta' }))
    await fireEvent.press(screen.getByRole('button', { name: 'Salvar meta' }))
    expect(await screen.findByText(MISSING_TITLE)).toBeTruthy()
    await fireEvent.changeText(screen.getByLabelText('Nome da meta'), 'Viagem')
    await fireEvent.press(screen.getByRole('button', { name: 'Salvar meta' }))
    expect(await screen.findByText(MISSING_DESCRIPTION)).toBeTruthy()
    await fireEvent.changeText(screen.getByLabelText('Descrição'), 'Outra viagem')
    await fireEvent.changeText(screen.getByLabelText('Valor-alvo (R$)'), '0')
    await fireEvent.press(screen.getByRole('button', { name: 'Salvar meta' }))
    expect(await screen.findByText('O valor deve ser maior que zero.')).toBeTruthy()
    await fireEvent.changeText(screen.getByLabelText('Valor-alvo (R$)'), '100')
    await fireEvent.changeText(screen.getByLabelText('Prazo (DD/MM/AAAA, opcional)'), '30/02/2027')
    await fireEvent.press(screen.getByRole('button', { name: 'Salvar meta' }))
    expect(await screen.findByText('Informe a data no formato DD/MM/AAAA.')).toBeTruthy()
    expect(create).not.toHaveBeenCalled()

    await fireEvent.changeText(screen.getByLabelText('Prazo (DD/MM/AAAA, opcional)'), '')
    await fireEvent.press(screen.getByRole('button', { name: 'Salvar meta' }))
    expect(await screen.findByText('Já existe uma meta de investimento com esse nome.')).toBeTruthy()
  })

  it('edits a goal keeping its old category and subcategory, which PUT would otherwise drop', async () => {
    const { goalApi } = await mount()
    await screen.findByText('Viagem')
    await fireEvent.press(screen.getByRole('link', { name: 'Editar Viagem' }))
    expect(screen.getByRole('radio', { name: 'Investimentos antigos' })).toBeSelected()
    await fireEvent.changeText(screen.getByLabelText('Valor-alvo (R$)'), '6000')
    await fireEvent.press(screen.getByRole('button', { name: 'Salvar meta' }))
    expect(await screen.findByText('Meta atualizada.')).toBeTruthy()
    expect(goalApi.update).toHaveBeenCalledWith('g-trip', {
      title: 'Viagem',
      description: 'Férias em família',
      targetAmount: '6000.00',
      dueDate: '2027-07-01',
      categoryId: 'cat-old',
      subcategoryId: 'sub-old',
    })
  })

  it('drops the subcategory when the category changes', async () => {
    const { goalApi } = await mount()
    await screen.findByText('Viagem')
    await fireEvent.press(screen.getByRole('link', { name: 'Editar Viagem' }))
    await fireEvent.press(screen.getByRole('radio', { name: 'Reserva' }))
    await fireEvent.press(screen.getByRole('button', { name: 'Salvar meta' }))
    expect(goalApi.update).toHaveBeenCalledWith('g-trip', expect.objectContaining({ categoryId: 'cat-reserve', subcategoryId: null }))
  })

  it('closes a goal only after confirmation, and offers no change on a closed one', async () => {
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined)
    const { goalApi } = await mount()
    await screen.findByText('Viagem')
    expect(screen.queryByRole('link', { name: 'Editar Carro' })).toBeNull()
    expect(screen.queryByRole('link', { name: 'Encerrar Carro' })).toBeNull()
    await fireEvent.press(screen.getByRole('link', { name: 'Encerrar Viagem' }))
    expect(goalApi.close).not.toHaveBeenCalled()
    const buttons = (alert.mock.calls.at(-1)?.[2] ?? []) as { text: string; onPress?: () => void }[]
    await act(async () => { buttons.find((button) => button.text === 'Encerrar')?.onPress?.() })
    expect(goalApi.close).toHaveBeenCalledWith('g-trip')
    expect(await screen.findByText('Meta encerrada.')).toBeTruthy()
    alert.mockRestore()
  })

  it('opens the contributions of a goal', async () => {
    const { onOpenContributions } = await mount()
    await fireEvent.press(await screen.findByRole('link', { name: 'Aportes de Carro' }))
    expect(onOpenContributions).toHaveBeenCalledWith(CAR)
  })

  it('reads the goals again when the route comes back into view', async () => {
    const goalApi = fakeGoalApi()
    const catalog = catalogApi()
    const { view, onOpenContributions } = await mount(goalApi, 'personal', 0, catalog)
    await screen.findByText('Viagem')
    await view.rerender(<GoalsScreen walletId="personal" goalApi={goalApi} catalogApi={catalog} refreshKey={1} onOpenContributions={onOpenContributions} />)
    expect(goalApi.list).toHaveBeenCalledTimes(2)
  })

  it('reads the new wallet without showing the old goals, and drops the open form', async () => {
    let release: (value: { items: Goal[] }) => void = () => undefined
    const list = jest.fn()
      .mockResolvedValueOnce({ items: [TRIP] })
      .mockImplementationOnce(() => new Promise((resolve) => { release = resolve }))
    const goalApi = fakeGoalApi({ list })
    const catalog = catalogApi()
    const { view, onOpenContributions } = await mount(goalApi, 'personal', 0, catalog)
    await screen.findByText('Viagem')
    await fireEvent.press(screen.getByRole('button', { name: 'Nova meta' }))

    await view.rerender(<GoalsScreen walletId="house" goalApi={goalApi} catalogApi={catalog} onOpenContributions={onOpenContributions} />)
    expect(screen.queryByText('Viagem')).toBeNull()
    expect(screen.getByText('Carregando metas…')).toBeTruthy()
    await act(async () => { release({ items: [{ ...TRIP, id: 'g-house', title: 'Reforma' }] }) })
    expect(screen.getByText('Reforma')).toBeTruthy()
    expect(screen.queryByLabelText('Nome da meta')).toBeNull()
  })

  it('shows a retryable error when the goals cannot be read', async () => {
    const list = jest.fn()
      .mockRejectedValueOnce(new ApiError('Não foi possível conectar à API. Verifique sua conexão.', 0))
      .mockResolvedValue({ items: [TRIP] })
    await mount(fakeGoalApi({ list }))
    expect(await screen.findByText('Não foi possível conectar à API. Verifique sua conexão.')).toBeTruthy()
    await fireEvent.press(screen.getByRole('button', { name: 'Tentar novamente' }))
    expect(await screen.findByText('Viagem')).toBeTruthy()
  })
})
