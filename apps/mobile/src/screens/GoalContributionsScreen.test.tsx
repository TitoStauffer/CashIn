import { act, fireEvent, render, screen } from '@testing-library/react-native'
import { Alert } from 'react-native'

import { ApiError } from '../api/client'
import type { Contribution, GoalApi } from '../goals/goalApi'
import { GoalContributionsScreen } from './GoalContributionsScreen'

const NOW = new Date(2026, 10, 18)
const MONTHLY: Contribution = { id: 'c1', amount: '250.00', date: '2026-11-05', description: 'Aporte mensal' }

function fakeGoalApi(overrides: Partial<GoalApi> = {}): GoalApi {
  return {
    listContributions: jest.fn(async () => ({ items: [MONTHLY] })),
    createContribution: jest.fn(async () => MONTHLY),
    removeContribution: jest.fn(async () => undefined),
    ...overrides,
  } as unknown as GoalApi
}

async function mount(goalApi = fakeGoalApi(), status: 'active' | 'closed' = 'active') {
  await render(<GoalContributionsScreen goal={{ id: 'g-trip', title: 'Viagem', status }} goalApi={goalApi} now={NOW} />)
  return { goalApi }
}

describe('GoalContributionsScreen', () => {
  it('lists the contributions of the goal', async () => {
    const { goalApi } = await mount()
    expect(await screen.findByText('R$ 250,00')).toBeTruthy()
    expect(screen.getByText('05/11/2026 · Aporte mensal')).toBeTruthy()
    expect(goalApi.listContributions).toHaveBeenCalledWith('g-trip')
  })

  it('registers a contribution with the exact decimal typed, dated today by default', async () => {
    const { goalApi } = await mount()
    await screen.findByText('R$ 250,00')
    await fireEvent.changeText(screen.getByLabelText('Valor do aporte (R$)'), '0,10')
    await fireEvent.press(screen.getByRole('button', { name: 'Registrar aporte' }))
    expect(await screen.findByText('Aporte registrado.')).toBeTruthy()
    expect(goalApi.createContribution).toHaveBeenCalledWith('g-trip', { amount: '0.10', date: '2026-11-18', description: null })
    expect(goalApi.listContributions).toHaveBeenCalledTimes(2)
    expect(screen.getByLabelText('Valor do aporte (R$)').props.value).toBe('')
  })

  it('checks amount and date before calling the API, and shows the API refusal', async () => {
    const createContribution = jest.fn(async () => { throw new ApiError('A meta de investimento está encerrada e não aceita alterações.', 409) })
    await mount(fakeGoalApi({ createContribution }))
    await screen.findByText('R$ 250,00')
    await fireEvent.press(screen.getByRole('button', { name: 'Registrar aporte' }))
    expect(await screen.findByText('Informe o valor.')).toBeTruthy()
    await fireEvent.changeText(screen.getByLabelText('Valor do aporte (R$)'), '50')
    await fireEvent.changeText(screen.getByLabelText('Data (DD/MM/AAAA)'), '31/11/2026')
    await fireEvent.press(screen.getByRole('button', { name: 'Registrar aporte' }))
    expect(await screen.findByText('Informe a data no formato DD/MM/AAAA.')).toBeTruthy()
    expect(createContribution).not.toHaveBeenCalled()

    await fireEvent.changeText(screen.getByLabelText('Data (DD/MM/AAAA)'), '18/11/2026')
    await fireEvent.press(screen.getByRole('button', { name: 'Registrar aporte' }))
    expect(await screen.findByText('A meta de investimento está encerrada e não aceita alterações.')).toBeTruthy()
    expect(screen.getByLabelText('Valor do aporte (R$)').props.value).toBe('50')
  })

  it('removes a contribution only after confirmation', async () => {
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined)
    const { goalApi } = await mount()
    await screen.findByText('R$ 250,00')
    await fireEvent.press(screen.getByRole('link', { name: 'Excluir aporte de R$ 250,00 em 05/11/2026' }))
    expect(goalApi.removeContribution).not.toHaveBeenCalled()
    const buttons = (alert.mock.calls.at(-1)?.[2] ?? []) as { text: string; onPress?: () => void }[]
    await act(async () => { buttons.find((button) => button.text === 'Excluir')?.onPress?.() })
    expect(goalApi.removeContribution).toHaveBeenCalledWith('g-trip', 'c1')
    expect(await screen.findByText('Aporte excluído.')).toBeTruthy()
    alert.mockRestore()
  })

  it('only shows the history of a closed goal', async () => {
    await mount(fakeGoalApi(), 'closed')
    expect(await screen.findByText('Meta encerrada: os aportes ficam só para consulta.')).toBeTruthy()
    expect(screen.queryByLabelText('Valor do aporte (R$)')).toBeNull()
    expect(screen.queryByRole('link', { name: /Excluir aporte/ })).toBeNull()
  })

  it('says when the goal has no contribution, and shows a retryable error', async () => {
    const listContributions = jest.fn()
      .mockRejectedValueOnce(new ApiError('Meta de investimento não encontrada.', 404))
      .mockResolvedValue({ items: [] })
    await mount(fakeGoalApi({ listContributions }))
    expect(await screen.findByText('Meta de investimento não encontrada.')).toBeTruthy()
    await fireEvent.press(screen.getByRole('button', { name: 'Tentar novamente' }))
    expect(await screen.findByText('Nenhum aporte nesta meta.')).toBeTruthy()
  })
})
