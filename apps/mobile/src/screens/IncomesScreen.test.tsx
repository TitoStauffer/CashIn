import { act, fireEvent, render, screen } from '@testing-library/react-native'
import { Alert } from 'react-native'

import { ApiError } from '../api/client'
import type { CatalogApi, Category } from '../catalog/catalogApi'
import type { Income, IncomeApi } from '../incomes/incomeApi'
import { IncomesScreen, LEGACY_BALANCE_NOTICE } from './IncomesScreen'

const NOW = new Date(2026, 10, 18)
const SALARY: Category = {
  id: 'c-salary',
  name: 'Salário',
  nature: 'income',
  subcategories: [{ id: 's-bonus', name: 'Bônus', categoryId: 'c-salary' }],
}
const GIFT: Category = { id: 'c-gift', name: 'Presente', nature: 'income', subcategories: [] }
const PAYCHECK: Income = {
  id: 'i-1',
  amount: '1250.50',
  date: '2026-11-05',
  description: 'Pagamento',
  categoryId: 'c-salary',
  categoryName: 'Salário',
  subcategoryId: null,
  subcategoryName: null,
  balanceType: 'cash',
}
const OLD_VR: Income = { ...PAYCHECK, id: 'i-2', amount: '600.00', date: '2026-11-01', description: null, balanceType: 'meal_benefit' }

function fakeIncomeApi(overrides: Partial<IncomeApi> = {}): IncomeApi {
  return {
    list: jest.fn(async () => ({ items: [PAYCHECK, OLD_VR] })),
    create: jest.fn(async () => PAYCHECK),
    update: jest.fn(async () => PAYCHECK),
    remove: jest.fn(async () => undefined),
    ...overrides,
  } as unknown as IncomeApi
}

function fakeCatalogApi(): CatalogApi {
  return { listCategories: jest.fn(async () => ({ items: [SALARY, GIFT] })) } as unknown as CatalogApi
}

async function mount(incomeApi = fakeIncomeApi(), walletId = 'personal', catalogApi = fakeCatalogApi()) {
  const view = await render(<IncomesScreen walletId={walletId} incomeApi={incomeApi} catalogApi={catalogApi} now={NOW} />)
  return { incomeApi, catalogApi, view }
}

async function fillNewIncome(amount: string) {
  await fireEvent.press(screen.getByRole('button', { name: 'Nova entrada' }))
  await fireEvent.changeText(screen.getByLabelText('Valor (R$)'), amount)
  await fireEvent.press(screen.getByRole('radio', { name: 'Salário' }))
}

describe('IncomesScreen', () => {
  it('lists the incomes of the current month with amount, date, category and balance', async () => {
    const { incomeApi, catalogApi } = await mount()
    expect(await screen.findByText('R$ 1.250,50')).toBeTruthy()
    expect(screen.getByText('05/11/2026 · Salário · Dinheiro')).toBeTruthy()
    expect(screen.getByText('01/11/2026 · Salário · Vale-refeição (VR) · histórico')).toBeTruthy()
    expect(screen.getByText('Novembro de 2026')).toBeTruthy()
    expect(incomeApi.list).toHaveBeenCalledWith('2026-11-01', '2026-11-30')
    expect(catalogApi.listCategories).toHaveBeenCalledWith('income')
  })

  it('reads the chosen month', async () => {
    const { incomeApi } = await mount()
    await screen.findByText('R$ 1.250,50')
    await fireEvent.press(screen.getByRole('link', { name: 'Mês anterior' }))
    expect(await screen.findByText('Outubro de 2026')).toBeTruthy()
    expect(incomeApi.list).toHaveBeenLastCalledWith('2026-10-01', '2026-10-31')
    await fireEvent.press(screen.getByRole('link', { name: 'Próximo mês' }))
    expect(await screen.findByText('Novembro de 2026')).toBeTruthy()
    expect(incomeApi.list).toHaveBeenLastCalledWith('2026-11-01', '2026-11-30')
  })

  it('sends the exact decimal typed, with today as the default date', async () => {
    const { incomeApi } = await mount()
    await screen.findByText('R$ 1.250,50')
    await fillNewIncome('0,10')
    expect(screen.getByLabelText('Data (DD/MM/AAAA)').props.value).toBe('18/11/2026')
    await fireEvent.press(screen.getByRole('radio', { name: 'Bônus' }))
    await fireEvent.press(screen.getByRole('radio', { name: 'Cartão de benefícios (VA/VR)' }))
    await fireEvent.changeText(screen.getByLabelText('Descrição (opcional)'), '  Troco  ')
    await fireEvent.press(screen.getByRole('button', { name: 'Salvar entrada' }))
    expect(await screen.findByText('Entrada registrada.')).toBeTruthy()
    expect(incomeApi.create).toHaveBeenCalledWith({
      amount: '0.10',
      date: '2026-11-18',
      description: 'Troco',
      categoryId: 'c-salary',
      subcategoryId: 's-bonus',
      balanceType: 'food_meal_benefit',
    })
    expect(incomeApi.list).toHaveBeenCalledTimes(2)
  })

  it('checks amount, date and category before calling the API', async () => {
    const { incomeApi } = await mount()
    await screen.findByText('R$ 1.250,50')
    await fireEvent.press(screen.getByRole('button', { name: 'Nova entrada' }))
    await fireEvent.changeText(screen.getByLabelText('Valor (R$)'), '-5')
    await fireEvent.press(screen.getByRole('button', { name: 'Salvar entrada' }))
    expect(await screen.findByText('O valor deve ser maior que zero.')).toBeTruthy()

    await fireEvent.changeText(screen.getByLabelText('Valor (R$)'), '10,00')
    await fireEvent.changeText(screen.getByLabelText('Data (DD/MM/AAAA)'), '31/02/2026')
    await fireEvent.press(screen.getByRole('button', { name: 'Salvar entrada' }))
    expect(await screen.findByText('Informe a data no formato DD/MM/AAAA.')).toBeTruthy()

    await fireEvent.changeText(screen.getByLabelText('Data (DD/MM/AAAA)'), '10/11/2026')
    await fireEvent.press(screen.getByRole('button', { name: 'Salvar entrada' }))
    expect(await screen.findByText('Escolha a categoria da entrada.')).toBeTruthy()
    expect(incomeApi.create).not.toHaveBeenCalled()
  })

  it('shows the API validation message in Portuguese', async () => {
    const create = jest.fn(async () => { throw new ApiError('A categoria informada é inválida.', 400) })
    await mount(fakeIncomeApi({ create }))
    await screen.findByText('R$ 1.250,50')
    await fillNewIncome('10')
    await fireEvent.press(screen.getByRole('button', { name: 'Salvar entrada' }))
    expect(await screen.findByText('A categoria informada é inválida.')).toBeTruthy()
    expect(screen.getByLabelText('Valor (R$)')).toBeTruthy()
  })

  it('edits an income, replacing every field as the API expects', async () => {
    const { incomeApi } = await mount()
    await screen.findByText('R$ 1.250,50')
    await fireEvent.press(screen.getByRole('link', { name: 'Editar entrada de R$ 1.250,50 em 05/11/2026 (Salário)' }))
    expect(screen.getByLabelText('Valor (R$)').props.value).toBe('1250,50')
    await fireEvent.changeText(screen.getByLabelText('Valor (R$)'), '1300')
    await fireEvent.press(screen.getByRole('button', { name: 'Salvar entrada' }))
    expect(await screen.findByText('Entrada atualizada.')).toBeTruthy()
    expect(incomeApi.update).toHaveBeenCalledWith('i-1', {
      amount: '1300.00',
      date: '2026-11-05',
      description: 'Pagamento',
      categoryId: 'c-salary',
      subcategoryId: null,
      balanceType: 'cash',
    })
  })

  it('says that saving an old VA or VR income moves it to the unified benefit balance', async () => {
    const { incomeApi } = await mount()
    await screen.findByText('R$ 600,00')
    await fireEvent.press(screen.getByRole('link', { name: 'Editar entrada de R$ 600,00 em 01/11/2026 (Salário)' }))
    expect(screen.getByText(LEGACY_BALANCE_NOTICE)).toBeTruthy()
    expect(screen.getByRole('radio', { name: 'Cartão de benefícios (VA/VR)' })).toBeSelected()
    await fireEvent.press(screen.getByRole('button', { name: 'Salvar entrada' }))
    expect(incomeApi.update).toHaveBeenCalledWith('i-2', expect.objectContaining({ balanceType: 'food_meal_benefit' }))

    await fireEvent.press(await screen.findByRole('link', { name: 'Editar entrada de R$ 1.250,50 em 05/11/2026 (Salário)' }))
    expect(screen.queryByText(LEGACY_BALANCE_NOTICE)).toBeNull()
  })

  it('removes an income only after confirmation', async () => {
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined)
    const { incomeApi } = await mount()
    await screen.findByText('R$ 1.250,50')
    await fireEvent.press(screen.getByRole('link', { name: 'Excluir entrada de R$ 1.250,50 em 05/11/2026 (Salário)' }))
    expect(incomeApi.remove).not.toHaveBeenCalled()
    const buttons = (alert.mock.calls.at(-1)?.[2] ?? []) as { text: string; onPress?: () => void }[]
    await act(async () => { buttons.find((button) => button.text === 'Excluir')?.onPress?.() })
    expect(incomeApi.remove).toHaveBeenCalledWith('i-1')
    expect(await screen.findByText('Entrada excluída.')).toBeTruthy()
    alert.mockRestore()
  })

  // Code Review of PR #124: removing the income open in the editor left the form on screen, and saving
  // it only met a 404.
  it('closes the editor of the income it removes, and keeps the editor of another one', async () => {
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined)
    await mount()
    await screen.findByText('R$ 1.250,50')
    const confirm = async () => {
      const buttons = (alert.mock.calls.at(-1)?.[2] ?? []) as { text: string; onPress?: () => void }[]
      await act(async () => { buttons.find((button) => button.text === 'Excluir')?.onPress?.() })
    }

    await fireEvent.press(screen.getByRole('link', { name: 'Editar entrada de R$ 600,00 em 01/11/2026 (Salário)' }))
    await fireEvent.press(screen.getByRole('link', { name: 'Excluir entrada de R$ 1.250,50 em 05/11/2026 (Salário)' }))
    await confirm()
    expect(await screen.findByText('Entrada excluída.')).toBeTruthy()
    expect(screen.getByLabelText('Valor (R$)').props.value).toBe('600,00')

    await fireEvent.press(screen.getByRole('link', { name: 'Excluir entrada de R$ 600,00 em 01/11/2026 (Salário)' }))
    await confirm()
    expect(screen.queryByLabelText('Valor (R$)')).toBeNull()
    alert.mockRestore()
  })

  it('names each income by amount, date and category, so two incomes of one day differ', async () => {
    const sameDay = { ...PAYCHECK, id: 'i-3', amount: '40.00', categoryName: 'Presente' }
    await mount(fakeIncomeApi({ list: jest.fn(async () => ({ items: [PAYCHECK, sameDay] })) }))
    expect(await screen.findByRole('link', { name: 'Editar entrada de R$ 1.250,50 em 05/11/2026 (Salário)' })).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Editar entrada de R$ 40,00 em 05/11/2026 (Presente)' })).toBeTruthy()
  })

  it('reads the new wallet without showing the old list, and drops the open form', async () => {
    let resolveSecond: (value: { items: Income[] }) => void = () => undefined
    const list = jest.fn()
      .mockResolvedValueOnce({ items: [PAYCHECK] })
      .mockImplementationOnce(() => new Promise((resolve) => { resolveSecond = resolve }))
    const incomeApi = fakeIncomeApi({ list })
    const catalogApi = fakeCatalogApi()
    const { view } = await mount(incomeApi, 'personal', catalogApi)
    await screen.findByText('R$ 1.250,50')
    await fireEvent.press(screen.getByRole('button', { name: 'Nova entrada' }))

    // The same API instances: only the wallet changes, so only the wallet can trigger the new read.
    await view.rerender(<IncomesScreen walletId="house" incomeApi={incomeApi} catalogApi={catalogApi} now={NOW} />)
    expect(screen.queryByText('R$ 1.250,50')).toBeNull()
    expect(screen.queryByLabelText('Valor (R$)')).toBeNull()
    expect(screen.getByText('Carregando entradas…')).toBeTruthy()
    expect(list).toHaveBeenCalledTimes(2)

    await act(async () => { resolveSecond({ items: [{ ...PAYCHECK, id: 'i-9', amount: '80.00' }] }) })
    expect(screen.getByText('R$ 80,00')).toBeTruthy()
    expect(screen.queryByLabelText('Valor (R$)')).toBeNull()
  })

  it('asks for an income category when the wallet has none', async () => {
    const catalogApi = { listCategories: jest.fn(async () => ({ items: [] })) } as unknown as CatalogApi
    await mount(fakeIncomeApi(), 'personal', catalogApi)
    await screen.findByText('R$ 1.250,50')
    await fireEvent.press(screen.getByRole('button', { name: 'Nova entrada' }))
    expect(screen.getByText('Cadastre uma categoria de entrada em Categorias antes de lançar.')).toBeTruthy()
  })

  it('shows a retryable error when the incomes cannot be read', async () => {
    const list = jest.fn()
      .mockRejectedValueOnce(new ApiError('Não foi possível conectar à API. Verifique sua conexão.', 0))
      .mockResolvedValue({ items: [PAYCHECK] })
    await mount(fakeIncomeApi({ list }))
    expect(await screen.findByText('Não foi possível conectar à API. Verifique sua conexão.')).toBeTruthy()
    await fireEvent.press(screen.getByRole('button', { name: 'Tentar novamente' }))
    expect(await screen.findByText('R$ 1.250,50')).toBeTruthy()
  })
})
