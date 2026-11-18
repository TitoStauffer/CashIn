import { act, fireEvent, render, screen } from '@testing-library/react-native'
import { Alert } from 'react-native'

import { ApiError } from '../api/client'
import type { Category } from '../catalog/catalogApi'
import type { CategorizationRule, CategorizationRuleInput, ImportApi } from '../imports/importApi'
import { ImportRulesScreen, RULE_CATEGORY_REQUIRED, RULE_DESCRIPTION_REQUIRED } from './ImportRulesScreen'

const FOOD: Category = { id: 'cat-food', name: 'Alimentação', nature: 'expense', subcategories: [{ id: 'sub-bakery', name: 'Padaria', categoryId: 'cat-food' }] }
const HOME: Category = { id: 'cat-home', name: 'Casa', nature: 'expense', subcategories: [] }
const SALARY: Category = { id: 'cat-salary', name: 'Salário', nature: 'income', subcategories: [] }

const BAKERY: CategorizationRule = {
  id: 'r1', type: 'expense', description: 'PADARIA BOM PAO', categoryId: 'cat-food', categoryName: 'Alimentação',
  subcategoryId: 'sub-bakery', subcategoryName: 'Padaria', isActive: false, isStale: false,
  createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z',
}
const STALE: CategorizationRule = {
  ...BAKERY, id: 'r2', description: 'ACADEMIA', categoryId: 'cat-gone', categoryName: null, subcategoryId: null, subcategoryName: null, isActive: true, isStale: true,
}

type RulesApi = Pick<ImportApi, 'listRules' | 'createRule' | 'updateRule' | 'deleteRule'>

function fakeApi(overrides: Partial<RulesApi> = {}): RulesApi {
  return {
    listRules: jest.fn(async () => ({ items: [BAKERY, STALE] })),
    createRule: jest.fn(async (input: CategorizationRuleInput) => ({ ...BAKERY, id: 'r-new', ...input })),
    updateRule: jest.fn(async (id: string, input: CategorizationRuleInput) => ({ ...BAKERY, id, ...input })),
    deleteRule: jest.fn(async () => undefined),
    ...overrides,
  } as RulesApi
}

const catalogApi = { listCategories: jest.fn(async (nature: string) => ({ items: nature === 'income' ? [SALARY] : [FOOD, HOME] })) }

async function mount(importApi = fakeApi()) {
  const view = await render(<ImportRulesScreen walletId="w1" importApi={importApi} catalogApi={catalogApi} />)
  await screen.findByText('PADARIA BOM PAO')
  return { importApi, view }
}

describe('ImportRulesScreen', () => {
  it('lists the rules with type, category and state, and offers no toggle on a stale one', async () => {
    await mount()
    expect(screen.getByText('Saída · Alimentação › Padaria · desativada')).toBeTruthy()
    expect(screen.getByText('Saída · Categoria removida')).toBeTruthy()
    expect(screen.getByText('A categoria foi removida. Edite a regra para ela voltar a classificar movimentações.')).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Ativar regra de saída “PADARIA BOM PAO”' })).toBeTruthy()
    expect(screen.queryByRole('link', { name: /(Ativar|Desativar) regra de saída “ACADEMIA”/ })).toBeNull()
  })

  it('creates a rule with every field, after checking description and category', async () => {
    const { importApi } = await mount()
    await fireEvent.press(screen.getByRole('button', { name: 'Nova regra' }))
    await fireEvent.press(screen.getByRole('button', { name: 'Confirmar e criar regra' }))
    expect(screen.getByText(RULE_DESCRIPTION_REQUIRED)).toBeTruthy()
    await fireEvent.changeText(screen.getByLabelText('Descrição exata da movimentação'), '  UBER TRIP ')
    await fireEvent.press(screen.getByRole('button', { name: 'Confirmar e criar regra' }))
    expect(screen.getByText(RULE_CATEGORY_REQUIRED)).toBeTruthy()
    expect(importApi.createRule).not.toHaveBeenCalled()

    await fireEvent.press(screen.getByRole('radio', { name: 'Casa' }))
    await fireEvent.press(screen.getByRole('button', { name: 'Confirmar e criar regra' }))
    expect(importApi.createRule).toHaveBeenCalledWith({ type: 'expense', description: 'UBER TRIP', categoryId: 'cat-home', subcategoryId: null, isActive: true })
    expect(await screen.findByText('Regra para “UBER TRIP” salva.')).toBeTruthy()
    expect(screen.queryByLabelText('Descrição exata da movimentação')).toBeNull()
  })

  it('keeps a deactivated rule deactivated when only its description is edited', async () => {
    const { importApi } = await mount()
    await fireEvent.press(screen.getByRole('link', { name: 'Editar regra de saída “PADARIA BOM PAO”' }))
    await fireEvent.changeText(screen.getByLabelText('Descrição exata da movimentação'), 'PADARIA BOM PÃO')
    await fireEvent.press(screen.getByRole('button', { name: 'Salvar regra' }))
    expect(importApi.updateRule).toHaveBeenCalledWith('r1', {
      type: 'expense', description: 'PADARIA BOM PÃO', categoryId: 'cat-food', subcategoryId: 'sub-bakery', isActive: false,
    })
  })

  it('drops the category of the old type when the type changes', async () => {
    const { importApi } = await mount()
    await fireEvent.press(screen.getByRole('link', { name: 'Editar regra de saída “PADARIA BOM PAO”' }))
    await fireEvent.press(screen.getByRole('radio', { name: 'Entrada' }))
    expect(screen.queryByRole('radio', { name: 'Alimentação' })).toBeNull()
    await fireEvent.press(screen.getByRole('button', { name: 'Salvar regra' }))
    expect(screen.getByText(RULE_CATEGORY_REQUIRED)).toBeTruthy()
    await fireEvent.press(screen.getByRole('radio', { name: 'Salário' }))
    await fireEvent.press(screen.getByRole('button', { name: 'Salvar regra' }))
    expect(importApi.updateRule).toHaveBeenCalledWith('r1', expect.objectContaining({ type: 'income', categoryId: 'cat-salary', subcategoryId: null }))
  })

  it('does not offer a removed category again when a stale rule is edited', async () => {
    const { importApi } = await mount()
    await fireEvent.press(screen.getByRole('link', { name: 'Editar regra de saída “ACADEMIA”' }))
    await fireEvent.press(screen.getByRole('button', { name: 'Salvar regra' }))
    expect(screen.getByText(RULE_CATEGORY_REQUIRED)).toBeTruthy()
    expect(importApi.updateRule).not.toHaveBeenCalled()
  })

  it('switches a rule on and off with all its fields, saying what the API did', async () => {
    const { importApi } = await mount()
    await fireEvent.press(screen.getByRole('link', { name: 'Ativar regra de saída “PADARIA BOM PAO”' }))
    expect(importApi.updateRule).toHaveBeenCalledWith('r1', {
      type: 'expense', description: 'PADARIA BOM PAO', categoryId: 'cat-food', subcategoryId: 'sub-bakery', isActive: true,
    })
    expect(await screen.findByText('Regra ativada.')).toBeTruthy()
  })

  it('deletes a rule only after confirmation', async () => {
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined)
    const { importApi } = await mount()
    await fireEvent.press(screen.getByRole('link', { name: 'Excluir regra de saída “PADARIA BOM PAO”' }))
    expect(importApi.deleteRule).not.toHaveBeenCalled()
    const buttons = (alert.mock.calls.at(-1)?.[2] ?? []) as { text: string; onPress?: () => void }[]
    await act(async () => { buttons.find((button) => button.text === 'Excluir')?.onPress?.() })
    expect(importApi.deleteRule).toHaveBeenCalledWith('r1')
    expect(await screen.findByText('Regra excluída.')).toBeTruthy()
    alert.mockRestore()
  })

  it('shows the API refusal of a repeated rule and keeps the form', async () => {
    const createRule = jest.fn(async () => { throw new ApiError('Já existe uma regra para esta descrição e tipo nesta carteira.', 409) })
    await mount(fakeApi({ createRule }))
    await fireEvent.press(screen.getByRole('button', { name: 'Nova regra' }))
    await fireEvent.changeText(screen.getByLabelText('Descrição exata da movimentação'), 'PADARIA BOM PAO')
    await fireEvent.press(screen.getByRole('radio', { name: 'Alimentação' }))
    await fireEvent.press(screen.getByRole('button', { name: 'Confirmar e criar regra' }))
    expect(await screen.findByText('Já existe uma regra para esta descrição e tipo nesta carteira.')).toBeTruthy()
    expect(screen.getByLabelText('Descrição exata da movimentação').props.value).toBe('PADARIA BOM PAO')
  })

  it('starts clean in another wallet, and shows a read error with retry', async () => {
    const listRules = jest.fn()
      .mockResolvedValueOnce({ items: [BAKERY] })
      .mockRejectedValueOnce(new ApiError('Carteira não encontrada.', 404))
      .mockResolvedValue({ items: [] })
    const importApi = fakeApi({ listRules })
    const { view } = await mount(importApi)
    await fireEvent.press(screen.getByRole('button', { name: 'Nova regra' }))
    await view.rerender(<ImportRulesScreen walletId="w2" importApi={importApi} catalogApi={catalogApi} />)
    expect(await screen.findByText('Carteira não encontrada.')).toBeTruthy()
    await fireEvent.press(screen.getByRole('button', { name: 'Tentar novamente' }))
    expect(await screen.findByText('Nenhuma regra nesta carteira.')).toBeTruthy()
    expect(screen.queryByLabelText('Descrição exata da movimentação')).toBeNull()
  })
})
