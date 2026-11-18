import { act, fireEvent, render, screen } from '@testing-library/react-native'

import { ApiError } from '../api/client'
import type { CreditCard, CreditCardApi } from '../cards/creditCardApi'
import { cardChanges, CardsScreen, INVALID_DAY, MISSING_NICKNAME, parseDay } from './CardsScreen'

const GOLD: CreditCard = { id: 'k-gold', nickname: 'Gold', closingDay: 10, dueDay: 20, isActive: true }
const OLD: CreditCard = { id: 'k-old', nickname: 'Antigo', closingDay: 5, dueDay: 15, isActive: false }

function fakeCardApi(overrides: Partial<CreditCardApi> = {}): CreditCardApi {
  return {
    list: jest.fn(async () => ({ items: [GOLD, OLD] })),
    create: jest.fn(async () => GOLD),
    update: jest.fn(async () => GOLD),
    ...overrides,
  } as unknown as CreditCardApi
}

async function mount(cardApi = fakeCardApi(), walletId = 'personal') {
  const onOpenStatements = jest.fn()
  const view = await render(<CardsScreen walletId={walletId} cardApi={cardApi} onOpenStatements={onOpenStatements} />)
  return { cardApi, onOpenStatements, view }
}

describe('CardsScreen', () => {
  it('lists active and inactive cards with their days, and opens the statements', async () => {
    const { onOpenStatements } = await mount()
    expect(await screen.findByText('Gold')).toBeTruthy()
    expect(screen.getByText('Fecha dia 10 · vence dia 20 · Ativo')).toBeTruthy()
    expect(screen.getByText('Fecha dia 5 · vence dia 15 · Inativo')).toBeTruthy()
    await fireEvent.press(screen.getByRole('link', { name: 'Faturas de Gold' }))
    expect(onOpenStatements).toHaveBeenCalledWith(GOLD)
  })

  it('creates a card with the trimmed nickname and whole days', async () => {
    const { cardApi } = await mount()
    await screen.findByText('Gold')
    await fireEvent.press(screen.getByRole('button', { name: 'Novo cartão' }))
    await fireEvent.changeText(screen.getByLabelText('Apelido do cartão'), ' Nubank ')
    await fireEvent.changeText(screen.getByLabelText('Dia de fechamento'), '3')
    await fireEvent.changeText(screen.getByLabelText('Dia de vencimento'), '10')
    await fireEvent.press(screen.getByRole('button', { name: 'Salvar cartão' }))
    expect(await screen.findByText('Cartão cadastrado.')).toBeTruthy()
    expect(cardApi.create).toHaveBeenCalledWith({ nickname: 'Nubank', closingDay: 3, dueDay: 10 })
    expect(cardApi.list).toHaveBeenCalledTimes(2)
  })

  it('checks nickname and days before calling the API, and shows the API refusal', async () => {
    const create = jest.fn(async () => { throw new ApiError('Os dados enviados são inválidos.', 400) })
    await mount(fakeCardApi({ create }))
    await screen.findByText('Gold')
    await fireEvent.press(screen.getByRole('button', { name: 'Novo cartão' }))
    await fireEvent.press(screen.getByRole('button', { name: 'Salvar cartão' }))
    expect(await screen.findByText(MISSING_NICKNAME)).toBeTruthy()
    await fireEvent.changeText(screen.getByLabelText('Apelido do cartão'), 'Nubank')
    await fireEvent.changeText(screen.getByLabelText('Dia de fechamento'), '32')
    await fireEvent.changeText(screen.getByLabelText('Dia de vencimento'), '10')
    await fireEvent.press(screen.getByRole('button', { name: 'Salvar cartão' }))
    expect(await screen.findByText(INVALID_DAY)).toBeTruthy()
    expect(create).not.toHaveBeenCalled()

    await fireEvent.changeText(screen.getByLabelText('Dia de fechamento'), '31')
    await fireEvent.press(screen.getByRole('button', { name: 'Salvar cartão' }))
    expect(await screen.findByText('Os dados enviados são inválidos.')).toBeTruthy()
  })

  it('edits only what changed, and sends nothing when nothing changed', async () => {
    const { cardApi } = await mount()
    await screen.findByText('Gold')
    await fireEvent.press(screen.getByRole('link', { name: 'Editar Gold' }))
    await fireEvent.press(screen.getByRole('button', { name: 'Salvar cartão' }))
    expect(cardApi.update).not.toHaveBeenCalled()
    expect(screen.queryByLabelText('Apelido do cartão')).toBeNull()

    await fireEvent.press(screen.getByRole('link', { name: 'Editar Gold' }))
    await fireEvent.changeText(screen.getByLabelText('Dia de vencimento'), '25')
    await fireEvent.press(screen.getByRole('button', { name: 'Salvar cartão' }))
    expect(await screen.findByText('Cartão atualizado.')).toBeTruthy()
    expect(cardApi.update).toHaveBeenCalledWith('k-gold', { dueDay: 25 })
  })

  it('deactivates and activates a card instead of deleting it', async () => {
    const { cardApi } = await mount()
    await screen.findByText('Gold')
    await fireEvent.press(screen.getByRole('link', { name: 'Desativar Gold' }))
    expect(await screen.findByText('Cartão desativado.')).toBeTruthy()
    expect(cardApi.update).toHaveBeenCalledWith('k-gold', { isActive: false })
    await fireEvent.press(screen.getByRole('link', { name: 'Ativar Antigo' }))
    expect(await screen.findByText('Cartão ativado.')).toBeTruthy()
    expect(cardApi.update).toHaveBeenLastCalledWith('k-old', { isActive: true })
  })

  it('reads the new wallet without showing the old cards, and drops the open form', async () => {
    let release: (value: { items: CreditCard[] }) => void = () => undefined
    const list = jest.fn()
      .mockResolvedValueOnce({ items: [GOLD] })
      .mockImplementationOnce(() => new Promise((resolve) => { release = resolve }))
    const cardApi = fakeCardApi({ list })
    const { view, onOpenStatements } = await mount(cardApi, 'personal')
    await screen.findByText('Gold')
    await fireEvent.press(screen.getByRole('button', { name: 'Novo cartão' }))

    // The same API instance: only the wallet changes, so only the wallet can trigger the new read.
    await view.rerender(<CardsScreen walletId="house" cardApi={cardApi} onOpenStatements={onOpenStatements} />)
    expect(screen.queryByText('Gold')).toBeNull()
    expect(screen.getByText('Carregando cartões…')).toBeTruthy()
    expect(list).toHaveBeenCalledTimes(2)
    await act(async () => { release({ items: [{ ...GOLD, id: 'k-house', nickname: 'Casa' }] }) })
    expect(screen.getByText('Casa')).toBeTruthy()
    expect(screen.queryByLabelText('Apelido do cartão')).toBeNull()
  })

  it('shows a retryable error when the cards cannot be read', async () => {
    const list = jest.fn()
      .mockRejectedValueOnce(new ApiError('Não foi possível conectar à API. Verifique sua conexão.', 0))
      .mockResolvedValue({ items: [GOLD] })
    await mount(fakeCardApi({ list }))
    expect(await screen.findByText('Não foi possível conectar à API. Verifique sua conexão.')).toBeTruthy()
    await fireEvent.press(screen.getByRole('button', { name: 'Tentar novamente' }))
    expect(await screen.findByText('Gold')).toBeTruthy()
  })

  it('reads a day only when it is a whole number from 1 to 31, and compares edits field by field', () => {
    expect(parseDay(' 7 ')).toBe(7)
    expect(parseDay('31')).toBe(31)
    expect(parseDay('0')).toBeNull()
    expect(parseDay('32')).toBeNull()
    expect(parseDay('1.5')).toBeNull()
    expect(cardChanges(GOLD, 'Gold', 10, 20)).toEqual({})
    expect(cardChanges(GOLD, 'Black', 12, 20)).toEqual({ nickname: 'Black', closingDay: 12 })
  })
})
