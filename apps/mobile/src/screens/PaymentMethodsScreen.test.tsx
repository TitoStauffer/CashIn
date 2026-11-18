import { act, fireEvent, render, screen } from '@testing-library/react-native'

import { ApiError } from '../api/client'
import type { CatalogApi, PaymentMethod } from '../catalog/catalogApi'
import { paymentMethodChanges, PaymentMethodsScreen } from './PaymentMethodsScreen'

const PIX: PaymentMethod = { id: 'p-pix', name: 'Pix', nature: 'immediate', isActive: true }
const OLD_VR: PaymentMethod = { id: 'p-vr', name: 'VR antigo', nature: 'meal_benefit', isActive: false }

function fakeCatalogApi(overrides: Partial<CatalogApi> = {}): CatalogApi {
  return {
    listPaymentMethods: jest.fn(async () => ({ items: [PIX, OLD_VR] })),
    createPaymentMethod: jest.fn(async () => PIX),
    updatePaymentMethod: jest.fn(async () => PIX),
    ...overrides,
  } as unknown as CatalogApi
}

async function mount(catalogApi = fakeCatalogApi(), walletId = 'personal') {
  const view = await render(<PaymentMethodsScreen walletId={walletId} catalogApi={catalogApi} />)
  return { catalogApi, view }
}

describe('PaymentMethodsScreen', () => {
  it('lists active and inactive methods with their nature', async () => {
    await mount()
    expect(await screen.findByText('Pix')).toBeTruthy()
    expect(screen.getByText('Imediata (dinheiro, débito ou Pix) · Ativa')).toBeTruthy()
    expect(screen.getByText('Vale-refeição (VR) · histórico · Inativa')).toBeTruthy()
  })

  it('creates a method with the trimmed name and the chosen nature', async () => {
    const { catalogApi } = await mount()
    await screen.findByText('Pix')
    await fireEvent.press(screen.getByRole('button', { name: 'Nova forma de pagamento' }))
    await fireEvent.changeText(screen.getByLabelText('Nome da forma de pagamento'), ' Nubank ')
    await fireEvent.press(screen.getByRole('radio', { name: 'Cartão de crédito' }))
    await fireEvent.press(screen.getByRole('button', { name: 'Salvar forma de pagamento' }))
    expect(await screen.findByText('Forma de pagamento criada.')).toBeTruthy()
    expect(catalogApi.createPaymentMethod).toHaveBeenCalledWith('Nubank', 'credit_card')
    expect(catalogApi.listPaymentMethods).toHaveBeenCalledTimes(2)
  })

  it('asks for a name before calling the API, and shows the API conflict in Portuguese', async () => {
    const createPaymentMethod = jest.fn(async () => { throw new ApiError('Já existe uma forma de pagamento com esse nome nesta carteira.', 409) })
    await mount(fakeCatalogApi({ createPaymentMethod }))
    await screen.findByText('Pix')
    await fireEvent.press(screen.getByRole('button', { name: 'Nova forma de pagamento' }))
    await fireEvent.press(screen.getByRole('button', { name: 'Salvar forma de pagamento' }))
    expect(await screen.findByText('Informe o nome da forma de pagamento.')).toBeTruthy()
    expect(createPaymentMethod).not.toHaveBeenCalled()

    await fireEvent.changeText(screen.getByLabelText('Nome da forma de pagamento'), 'Pix')
    await fireEvent.press(screen.getByRole('button', { name: 'Salvar forma de pagamento' }))
    expect(await screen.findByText('Já existe uma forma de pagamento com esse nome nesta carteira.')).toBeTruthy()
  })

  // Code Review of PR #123: the API normalizes every nature it receives, so sending the unchanged VR
  // nature with a new name reclassified the method as the unified VA/VR benefit.
  it('renames a historical VR method without sending its nature', async () => {
    const { catalogApi } = await mount()
    await screen.findByText('VR antigo')
    await fireEvent.press(screen.getByRole('link', { name: 'Editar VR antigo' }))
    expect(screen.getByRole('radio', { name: 'Vale-refeição (VR) · histórico (legado)' })).toBeSelected()
    await fireEvent.changeText(screen.getByLabelText('Nome da forma de pagamento'), 'VR 2025')
    await fireEvent.press(screen.getByRole('button', { name: 'Salvar forma de pagamento' }))
    expect(await screen.findByText('Forma de pagamento atualizada.')).toBeTruthy()
    expect(catalogApi.updatePaymentMethod).toHaveBeenCalledWith('p-vr', { name: 'VR 2025' })
  })

  it('sends only the nature when only the nature changed, and nothing when nothing changed', async () => {
    const { catalogApi } = await mount()
    await screen.findByText('Pix')
    await fireEvent.press(screen.getByRole('link', { name: 'Editar Pix' }))
    await fireEvent.changeText(screen.getByLabelText('Nome da forma de pagamento'), ' Pix ')
    await fireEvent.press(screen.getByRole('button', { name: 'Salvar forma de pagamento' }))
    expect(catalogApi.updatePaymentMethod).not.toHaveBeenCalled()
    expect(screen.queryByLabelText('Nome da forma de pagamento')).toBeNull()

    await fireEvent.press(screen.getByRole('link', { name: 'Editar Pix' }))
    await fireEvent.press(screen.getByRole('radio', { name: 'Cartão de crédito' }))
    await fireEvent.press(screen.getByRole('button', { name: 'Salvar forma de pagamento' }))
    expect(await screen.findByText('Forma de pagamento atualizada.')).toBeTruthy()
    expect(catalogApi.updatePaymentMethod).toHaveBeenCalledWith('p-pix', { nature: 'credit_card' })
  })

  it('compares the edit with the original method', () => {
    expect(paymentMethodChanges(OLD_VR, 'VR antigo', 'meal_benefit')).toEqual({})
    expect(paymentMethodChanges(OLD_VR, 'VR 2025', 'food_meal_benefit')).toEqual({ name: 'VR 2025', nature: 'food_meal_benefit' })
  })

  it('deactivates and activates a method instead of deleting it', async () => {
    const { catalogApi } = await mount()
    await screen.findByText('Pix')
    await fireEvent.press(screen.getByRole('link', { name: 'Desativar Pix' }))
    expect(await screen.findByText('Forma de pagamento desativada.')).toBeTruthy()
    expect(catalogApi.updatePaymentMethod).toHaveBeenCalledWith('p-pix', { isActive: false })

    await fireEvent.press(screen.getByRole('link', { name: 'Ativar VR antigo' }))
    expect(await screen.findByText('Forma de pagamento ativada.')).toBeTruthy()
    expect(catalogApi.updatePaymentMethod).toHaveBeenLastCalledWith('p-vr', { isActive: true })
  })

  it('reads the list again for the new wallet, without showing the old one meanwhile', async () => {
    let resolveSecond: (value: { items: PaymentMethod[] }) => void = () => undefined
    const listPaymentMethods = jest.fn()
      .mockResolvedValueOnce({ items: [PIX] })
      .mockImplementationOnce(() => new Promise((resolve) => { resolveSecond = resolve }))
    const catalogApi = fakeCatalogApi({ listPaymentMethods })
    const { view } = await mount(catalogApi, 'personal')
    await screen.findByText('Pix')
    await fireEvent.press(screen.getByRole('link', { name: 'Editar Pix' }))

    // The same API instance: only the wallet changes, so only the wallet can trigger the new read.
    await view.rerender(<PaymentMethodsScreen walletId="house" catalogApi={catalogApi} />)
    expect(screen.queryByText('Pix')).toBeNull()
    expect(screen.queryByLabelText('Nome da forma de pagamento')).toBeNull()
    expect(screen.getByText('Carregando formas de pagamento…')).toBeTruthy()
    expect(listPaymentMethods).toHaveBeenCalledTimes(2)

    await act(async () => { resolveSecond({ items: [{ ...PIX, id: 'p-cash', name: 'Dinheiro' }] }) })
    expect(screen.getByText('Dinheiro')).toBeTruthy()
  })

  it('shows a retryable error when the list cannot be read', async () => {
    const listPaymentMethods = jest.fn()
      .mockRejectedValueOnce(new ApiError('Não foi possível conectar à API. Verifique sua conexão.', 0))
      .mockResolvedValue({ items: [PIX] })
    await mount(fakeCatalogApi({ listPaymentMethods }))
    expect(await screen.findByText('Não foi possível conectar à API. Verifique sua conexão.')).toBeTruthy()
    await fireEvent.press(screen.getByRole('button', { name: 'Tentar novamente' }))
    expect(await screen.findByText('Pix')).toBeTruthy()
  })
})
