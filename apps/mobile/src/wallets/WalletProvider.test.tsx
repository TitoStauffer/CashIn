import { act, fireEvent, render, screen } from '@testing-library/react-native'
import { Pressable, Text } from 'react-native'

import { ApiError } from '../api/client'
import type { SessionState } from '../auth/SessionProvider'
import type { Wallet, WalletApi } from './walletApi'
import { WALLET_UNAVAILABLE_NOTICE, WalletProvider, useWallets, type WalletState } from './WalletProvider'

let mockSession: SessionState = { status: 'signedIn', user: { id: 'user-1', email: 'pessoa@example.com' } }
jest.mock('../auth/SessionProvider', () => ({ useSession: () => ({ state: mockSession }) }))

const PERSONAL: Wallet = { id: 'personal', name: 'Pessoal', isPersonal: true, role: 'owner' }
const HOUSE: Wallet = { id: 'house', name: 'Casa', isPersonal: false, role: 'owner' }
const TRIP: Wallet = { id: 'trip', name: 'Viagem', isPersonal: false, role: 'member' }

function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial))
  return {
    read: jest.fn(async (userId: string) => values.get(userId) ?? null),
    save: jest.fn(async (userId: string, walletId: string) => { values.set(userId, walletId) }),
    values,
  }
}

function fakeWalletApi(lists: Wallet[][], overrides: Partial<WalletApi> = {}): WalletApi {
  const list = jest.fn()
  for (const items of lists) list.mockResolvedValueOnce({ items })
  list.mockResolvedValue({ items: lists.at(-1) ?? [] })
  return { list, create: jest.fn(async (name: string) => ({ id: 'new', name, isPersonal: false, role: 'owner' as const })), ...overrides } as unknown as WalletApi
}

function describeState(state: WalletState): string {
  if (state.status === 'ready') return `ready:${state.activeWalletId}:${state.wallets.map((w) => w.id).join(',')}:${state.notice ?? ''}`
  if (state.status === 'error') return `error:${state.message}`
  return state.status
}

function Probe() {
  const { state, selectWallet, createWallet, dismissNotice } = useWallets()
  return (
    <>
      <Text testID="state">{describeState(state)}</Text>
      <Pressable accessibilityRole="button" accessibilityLabel="usar casa" onPress={() => selectWallet('house')} />
      <Pressable accessibilityRole="button" accessibilityLabel="usar desconhecida" onPress={() => selectWallet('unknown')} />
      <Pressable accessibilityRole="button" accessibilityLabel="criar" onPress={() => void createWallet('Reforma')} />
      <Pressable accessibilityRole="button" accessibilityLabel="entendi" onPress={dismissNotice} />
    </>
  )
}

async function mount(walletApi: WalletApi, storage = memoryStorage()) {
  const setActiveWalletId = jest.fn()
  let notFound: ((walletId: string) => void) | null = null
  const registerWalletNotFoundHandler = jest.fn((handler: (walletId: string) => void) => {
    notFound = handler
    return () => { notFound = null }
  })
  const view = await render(
    <WalletProvider walletApi={walletApi} storage={storage} setActiveWalletId={setActiveWalletId} registerWalletNotFoundHandler={registerWalletNotFoundHandler}>
      <Probe />
    </WalletProvider>,
  )
  return { setActiveWalletId, storage, view, reportNotFound: (walletId: string) => act(async () => { notFound?.(walletId); await Promise.resolve() }) }
}

beforeEach(() => {
  mockSession = { status: 'signedIn', user: { id: 'user-1', email: 'pessoa@example.com' } }
})

describe('WalletProvider', () => {
  it('keeps the wallet chosen on this device across launches', async () => {
    const { setActiveWalletId } = await mount(fakeWalletApi([[PERSONAL, HOUSE]]), memoryStorage({ 'user-1': 'house' }))
    expect(await screen.findByText('ready:house:personal,house:')).toBeTruthy()
    expect(setActiveWalletId).toHaveBeenLastCalledWith('house')
  })

  it('starts on the personal wallet when nothing was chosen', async () => {
    const { setActiveWalletId, storage } = await mount(fakeWalletApi([[HOUSE, PERSONAL]]))
    expect(await screen.findByText('ready:personal:house,personal:')).toBeTruthy()
    expect(setActiveWalletId).toHaveBeenLastCalledWith('personal')
    expect(storage.save).toHaveBeenCalledWith('user-1', 'personal')
  })

  it('falls back to the personal wallet with a notice when the chosen one is gone', async () => {
    await mount(fakeWalletApi([[PERSONAL, TRIP]]), memoryStorage({ 'user-1': 'house' }))
    expect(await screen.findByText(`ready:personal:personal,trip:${WALLET_UNAVAILABLE_NOTICE}`)).toBeTruthy()
    await fireEvent.press(screen.getByLabelText('entendi'))
    expect(screen.getByText('ready:personal:personal,trip:')).toBeTruthy()
  })

  it('switches the wallet sent in X-Wallet-Id and remembers it', async () => {
    const { setActiveWalletId, storage } = await mount(fakeWalletApi([[PERSONAL, HOUSE]]))
    await screen.findByText('ready:personal:personal,house:')
    await fireEvent.press(screen.getByLabelText('usar casa'))
    expect(screen.getByText('ready:house:personal,house:')).toBeTruthy()
    expect(setActiveWalletId).toHaveBeenLastCalledWith('house')
    expect(storage.values.get('user-1')).toBe('house')
  })

  it('ignores a wallet that is not one of the account', async () => {
    const { setActiveWalletId } = await mount(fakeWalletApi([[PERSONAL, HOUSE]]))
    await screen.findByText('ready:personal:personal,house:')
    setActiveWalletId.mockClear()
    await fireEvent.press(screen.getByLabelText('usar desconhecida'))
    expect(screen.getByText('ready:personal:personal,house:')).toBeTruthy()
    expect(setActiveWalletId).not.toHaveBeenCalled()
  })

  it('makes a newly created wallet the active one', async () => {
    const { setActiveWalletId } = await mount(fakeWalletApi([[PERSONAL]]))
    await screen.findByText('ready:personal:personal:')
    await fireEvent.press(screen.getByLabelText('criar'))
    expect(await screen.findByText('ready:new:personal,new:')).toBeTruthy()
    expect(setActiveWalletId).toHaveBeenLastCalledWith('new')
  })

  it('checks the wallets again on a 404 for the active wallet and falls back when it was removed', async () => {
    const { reportNotFound } = await mount(fakeWalletApi([[PERSONAL, HOUSE], [PERSONAL]]), memoryStorage({ 'user-1': 'house' }))
    await screen.findByText('ready:house:personal,house:')
    await reportNotFound('house')
    expect(await screen.findByText(`ready:personal:personal:${WALLET_UNAVAILABLE_NOTICE}`)).toBeTruthy()
  })

  it('ignores a 404 for a wallet that is not the active one', async () => {
    const walletApi = fakeWalletApi([[PERSONAL, HOUSE]])
    const { reportNotFound } = await mount(walletApi, memoryStorage({ 'user-1': 'house' }))
    await screen.findByText('ready:house:personal,house:')
    await reportNotFound('trip')
    expect(walletApi.list).toHaveBeenCalledTimes(1)
  })

  it('shows the API message when the wallets cannot be loaded', async () => {
    await mount(fakeWalletApi([], { list: jest.fn(async () => { throw new ApiError('Não foi possível conectar à API. Verifique sua conexão.', 0) }) }))
    expect(await screen.findByText('error:Não foi possível conectar à API. Verifique sua conexão.')).toBeTruthy()
  })

  it('clears the active wallet and asks nothing while signed out', async () => {
    mockSession = { status: 'signedOut' }
    const walletApi = fakeWalletApi([[PERSONAL]])
    const { setActiveWalletId } = await mount(walletApi)
    expect(screen.getByText('idle')).toBeTruthy()
    expect(setActiveWalletId).toHaveBeenCalledWith(null)
    expect(walletApi.list).not.toHaveBeenCalled()
  })
})
