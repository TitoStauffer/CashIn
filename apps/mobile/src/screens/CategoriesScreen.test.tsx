import { act, fireEvent, render, screen } from '@testing-library/react-native'
import { Alert } from 'react-native'

import { ApiError } from '../api/client'
import type { CatalogApi, Category, CategoryNature } from '../catalog/catalogApi'
import { CategoriesScreen } from './CategoriesScreen'

const SALARY: Category = { id: 'c-salary', name: 'Salário', nature: 'income', subcategories: [] }
const MARKET: Category = {
  id: 'c-market',
  name: 'Mercado',
  nature: 'expense',
  subcategories: [{ id: 's-fruit', name: 'Hortifrúti', categoryId: 'c-market' }],
}

function fakeCatalogApi(overrides: Partial<CatalogApi> = {}): CatalogApi {
  return {
    listCategories: jest.fn(async (nature: CategoryNature) => ({ items: nature === 'income' ? [SALARY] : nature === 'expense' ? [MARKET] : [] })),
    createCategory: jest.fn(async () => SALARY),
    renameCategory: jest.fn(async () => SALARY),
    removeCategory: jest.fn(async () => undefined),
    createSubcategory: jest.fn(async () => MARKET.subcategories[0]),
    renameSubcategory: jest.fn(async () => MARKET.subcategories[0]),
    removeSubcategory: jest.fn(async () => undefined),
    ...overrides,
  } as unknown as CatalogApi
}

async function mount(catalogApi = fakeCatalogApi(), walletId = 'personal') {
  const view = await render(<CategoriesScreen walletId={walletId} catalogApi={catalogApi} />)
  return { catalogApi, view }
}

async function confirmAlert(alert: jest.SpyInstance, buttonText: string) {
  const buttons = (alert.mock.calls.at(-1)?.[2] ?? []) as { text: string; onPress?: () => void }[]
  await act(async () => { buttons.find((button) => button.text === buttonText)?.onPress?.() })
}

describe('CategoriesScreen', () => {
  it('lists one nature at a time, with its subcategories', async () => {
    const { catalogApi } = await mount()
    expect(await screen.findByText('Salário')).toBeTruthy()
    expect(catalogApi.listCategories).toHaveBeenCalledWith('income')

    await fireEvent.press(screen.getByRole('radio', { name: 'Saídas' }))
    expect(await screen.findByText('Mercado')).toBeTruthy()
    expect(screen.getByText('Hortifrúti')).toBeTruthy()
    expect(screen.queryByText('Salário')).toBeNull()
    expect(catalogApi.listCategories).toHaveBeenLastCalledWith('expense')
  })

  it('creates a category in the chosen nature with the trimmed name, and reads the list again', async () => {
    const { catalogApi } = await mount()
    await screen.findByText('Salário')
    await fireEvent.changeText(screen.getByLabelText('Nome da nova categoria'), '  Freelas ')
    await fireEvent.press(screen.getByRole('button', { name: 'Criar categoria' }))
    expect(await screen.findByText('Categoria criada.')).toBeTruthy()
    expect(catalogApi.createCategory).toHaveBeenCalledWith('Freelas', 'income')
    expect(catalogApi.listCategories).toHaveBeenCalledTimes(2)
    expect(screen.getByLabelText('Nome da nova categoria').props.value).toBe('')
  })

  it('asks for a name before calling the API, and shows the API conflict in Portuguese', async () => {
    const createCategory = jest.fn(async () => { throw new ApiError('Já existe uma categoria com esse nome.', 409) })
    await mount(fakeCatalogApi({ createCategory }))
    await screen.findByText('Salário')
    await fireEvent.press(screen.getByRole('button', { name: 'Criar categoria' }))
    expect(await screen.findByText('Informe o nome da categoria.')).toBeTruthy()
    expect(createCategory).not.toHaveBeenCalled()

    await fireEvent.changeText(screen.getByLabelText('Nome da nova categoria'), 'Salário')
    await fireEvent.press(screen.getByRole('button', { name: 'Criar categoria' }))
    expect(await screen.findByText('Já existe uma categoria com esse nome.')).toBeTruthy()
  })

  it('renames a category and a subcategory', async () => {
    const { catalogApi } = await mount()
    await fireEvent.press(await screen.findByRole('radio', { name: 'Saídas' }))
    await screen.findByText('Mercado')

    await fireEvent.press(screen.getByRole('link', { name: 'Renomear Mercado' }))
    await fireEvent.changeText(screen.getByLabelText('Novo nome de Mercado'), ' Supermercado ')
    await fireEvent.press(screen.getByRole('button', { name: 'Salvar' }))
    expect(await screen.findByText('Categoria renomeada.')).toBeTruthy()
    expect(catalogApi.renameCategory).toHaveBeenCalledWith('c-market', 'Supermercado')

    await fireEvent.press(screen.getByRole('link', { name: 'Renomear Hortifrúti' }))
    await fireEvent.changeText(screen.getByLabelText('Novo nome de Hortifrúti'), 'Frutas')
    await fireEvent.press(screen.getByRole('button', { name: 'Salvar' }))
    expect(await screen.findByText('Subcategoria renomeada.')).toBeTruthy()
    expect(catalogApi.renameSubcategory).toHaveBeenCalledWith('c-market', 's-fruit', 'Frutas')
  })

  it('adds a subcategory to its category', async () => {
    const { catalogApi } = await mount()
    await fireEvent.press(await screen.findByRole('radio', { name: 'Saídas' }))
    await screen.findByText('Mercado')
    await fireEvent.press(screen.getByRole('link', { name: 'Adicionar subcategoria a Mercado' }))
    expect(await screen.findByText('Informe o nome da subcategoria.')).toBeTruthy()
    expect(catalogApi.createSubcategory).not.toHaveBeenCalled()

    await fireEvent.changeText(screen.getByLabelText('Nova subcategoria de Mercado'), ' Padaria ')
    await fireEvent.press(screen.getByRole('link', { name: 'Adicionar subcategoria a Mercado' }))
    expect(await screen.findByText('Subcategoria criada.')).toBeTruthy()
    expect(catalogApi.createSubcategory).toHaveBeenCalledWith('c-market', 'Padaria')
  })

  it('removes only after confirmation, and shows the API refusal when the item is in use', async () => {
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined)
    const removeCategory = jest.fn(async () => { throw new ApiError('O item possui registros vinculados e não pode ser excluído.', 409) })
    const { catalogApi } = await mount(fakeCatalogApi({ removeCategory }))
    await fireEvent.press(await screen.findByRole('radio', { name: 'Saídas' }))
    await screen.findByText('Mercado')

    await fireEvent.press(screen.getByRole('link', { name: 'Excluir Hortifrúti' }))
    expect(catalogApi.removeSubcategory).not.toHaveBeenCalled()
    await confirmAlert(alert, 'Excluir')
    expect(catalogApi.removeSubcategory).toHaveBeenCalledWith('c-market', 's-fruit')
    expect(await screen.findByText('Subcategoria excluída.')).toBeTruthy()

    await fireEvent.press(screen.getByRole('link', { name: 'Excluir Mercado' }))
    await confirmAlert(alert, 'Excluir')
    expect(removeCategory).toHaveBeenCalledWith('c-market')
    expect(await screen.findByText('O item possui registros vinculados e não pode ser excluído.')).toBeTruthy()
    alert.mockRestore()
  })

  it('reads the list again for the new wallet, without showing the old one meanwhile', async () => {
    let resolveSecond: (value: { items: Category[] }) => void = () => undefined
    const listCategories = jest.fn()
      .mockResolvedValueOnce({ items: [SALARY] })
      .mockImplementationOnce(() => new Promise((resolve) => { resolveSecond = resolve }))
    const catalogApi = fakeCatalogApi({ listCategories })
    const { view } = await mount(catalogApi, 'personal')
    await screen.findByText('Salário')
    await fireEvent.changeText(screen.getByLabelText('Nome da nova categoria'), 'Meio digitado')
    await fireEvent.press(screen.getByRole('link', { name: 'Renomear Salário' }))

    // The same API instance: only the wallet changes, so only the wallet can trigger the new read.
    await view.rerender(<CategoriesScreen walletId="house" catalogApi={catalogApi} />)
    expect(screen.queryByText('Salário')).toBeNull()
    expect(screen.queryByLabelText('Novo nome de Salário')).toBeNull()
    expect(screen.getByLabelText('Nome da nova categoria').props.value).toBe('')
    expect(screen.getByText('Carregando categorias…')).toBeTruthy()
    expect(listCategories).toHaveBeenCalledTimes(2)

    await act(async () => { resolveSecond({ items: [{ ...SALARY, id: 'c-rent', name: 'Aluguel recebido' }] }) })
    expect(screen.getByText('Aluguel recebido')).toBeTruthy()
  })

  it('shows a retryable error when the list cannot be read', async () => {
    const listCategories = jest.fn()
      .mockRejectedValueOnce(new ApiError('Não foi possível conectar à API. Verifique sua conexão.', 0))
      .mockResolvedValue({ items: [SALARY] })
    await mount(fakeCatalogApi({ listCategories }))
    expect(await screen.findByText('Não foi possível conectar à API. Verifique sua conexão.')).toBeTruthy()
    await fireEvent.press(screen.getByRole('button', { name: 'Tentar novamente' }))
    expect(await screen.findByText('Salário')).toBeTruthy()
  })
})
