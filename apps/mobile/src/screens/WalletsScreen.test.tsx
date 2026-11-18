import { fireEvent, render, screen } from '@testing-library/react-native'

import { ApiError } from '../api/client'
import type { Wallet } from '../wallets/walletApi'
import type { WalletState } from '../wallets/WalletProvider'
import { WalletsScreen } from './WalletsScreen'

const PERSONAL: Wallet = { id: 'personal', name: 'Pessoal', isPersonal: true, role: 'owner' }
const HOUSE: Wallet = { id: 'house', name: 'Casa', isPersonal: false, role: 'owner' }
const TRIP: Wallet = { id: 'trip', name: 'Viagem', isPersonal: false, role: 'member' }

function renderScreen(state: WalletState, overrides: Partial<Parameters<typeof WalletsScreen>[0]> = {}) {
  const props = {
    state,
    onSelect: jest.fn(),
    onCreate: jest.fn(async () => undefined),
    onManage: jest.fn(),
    onRetry: jest.fn(),
    onDismissNotice: jest.fn(),
    ...overrides,
  }
  return render(<WalletsScreen {...props} />).then(() => props)
}

const ready = (activeWalletId = 'personal', notice?: string): WalletState => ({ status: 'ready', wallets: [PERSONAL, HOUSE, TRIP], activeWalletId, ...(notice ? { notice } : {}) })

describe('WalletsScreen', () => {
  it('marks the wallet in use and switches on press', async () => {
    const props = await renderScreen(ready('personal'))
    expect(screen.getByRole('radio', { name: 'Usar a carteira Pessoal' })).toBeSelected()
    expect(screen.getByRole('radio', { name: 'Usar a carteira Casa' })).not.toBeSelected()
    await fireEvent.press(screen.getByRole('radio', { name: 'Usar a carteira Casa' }))
    expect(props.onSelect).toHaveBeenCalledWith('house')
  })

  it('offers sharing only on shared wallets the person owns', async () => {
    const props = await renderScreen(ready())
    expect(screen.getByRole('link', { name: 'Compartilhar Casa' })).toBeTruthy()
    expect(screen.queryByRole('link', { name: 'Compartilhar Viagem' })).toBeNull()
    expect(screen.queryByRole('link', { name: 'Compartilhar Pessoal' })).toBeNull()
    await fireEvent.press(screen.getByRole('link', { name: 'Compartilhar Casa' }))
    expect(props.onManage).toHaveBeenCalledWith('house')
  })

  it('creates a wallet with the trimmed name and clears the field', async () => {
    const props = await renderScreen(ready())
    await fireEvent.changeText(screen.getByLabelText('Nome da nova carteira'), '  Reforma ')
    await fireEvent.press(screen.getByRole('button', { name: 'Criar carteira' }))
    expect(props.onCreate).toHaveBeenCalledWith('Reforma')
    expect(screen.getByLabelText('Nome da nova carteira').props.value).toBe('')
  })

  it('asks for a name before calling the API and shows the API refusal', async () => {
    const onCreate = jest.fn(async () => { throw new ApiError('Os dados enviados são inválidos.', 400) })
    await renderScreen(ready(), { onCreate })
    await fireEvent.press(screen.getByRole('button', { name: 'Criar carteira' }))
    expect(await screen.findByText('Informe o nome da carteira.')).toBeTruthy()
    expect(onCreate).not.toHaveBeenCalled()

    await fireEvent.changeText(screen.getByLabelText('Nome da nova carteira'), 'Reforma')
    await fireEvent.press(screen.getByRole('button', { name: 'Criar carteira' }))
    expect(await screen.findByText('Os dados enviados são inválidos.')).toBeTruthy()
  })

  it('shows the fallback notice and lets the person dismiss it', async () => {
    const props = await renderScreen(ready('personal', 'A carteira escolhida não está mais disponível. Voltamos para a sua carteira pessoal.'))
    expect(screen.getByText('A carteira escolhida não está mais disponível. Voltamos para a sua carteira pessoal.')).toBeTruthy()
    await fireEvent.press(screen.getByRole('link', { name: 'Entendi' }))
    expect(props.onDismissNotice).toHaveBeenCalledTimes(1)
  })

  it('shows loading and a retryable error', async () => {
    const props = await renderScreen({ status: 'error', message: 'Não foi possível carregar suas carteiras. Tente novamente.' })
    expect(screen.getByText('Não foi possível carregar suas carteiras. Tente novamente.')).toBeTruthy()
    await fireEvent.press(screen.getByRole('button', { name: 'Tentar novamente' }))
    expect(props.onRetry).toHaveBeenCalledTimes(1)
  })
})
