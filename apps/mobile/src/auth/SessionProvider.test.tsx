import { act, fireEvent, render, screen } from '@testing-library/react-native'
import { Pressable, Text } from 'react-native'

import { ApiError } from '../api/client'
import type { AuthApi } from './authApi'
import { SESSION_EXPIRED_NOTICE, SessionProvider, useSession, type SessionState } from './SessionProvider'

const TOKEN = 'tokenDeSessaoMovel'.padEnd(43, 'x')
const USER = { id: '1', email: 'pessoa@example.com' }

function memoryTokenStore(initial: string | null) {
  let token = initial
  return {
    read: jest.fn(async () => token),
    save: jest.fn(async (value: string) => { token = value }),
    clear: jest.fn(async () => { token = null }),
    get current() { return token },
  }
}

function fakeAuthApi(overrides: Partial<AuthApi> = {}): AuthApi {
  return {
    register: jest.fn(async () => ({ message: 'ok' })),
    login: jest.fn(async () => ({ user: USER, token: TOKEN, expiresAt: '2026-12-17T00:00:00.000Z' })),
    me: jest.fn(async () => ({ user: USER })),
    logout: jest.fn(async () => undefined),
    ...overrides,
  }
}

function describeState(state: SessionState): string {
  if (state.status === 'signedIn') return `signedIn:${state.user.email}`
  if (state.status === 'signedOut') return `signedOut:${state.notice ?? ''}`
  if (state.status === 'unavailable') return `unavailable:${state.message}`
  return state.status
}

function Probe() {
  const { state, signIn, signOut, retryRestore } = useSession()
  return (
    <>
      <Text testID="state">{describeState(state)}</Text>
      <Pressable accessibilityRole="button" accessibilityLabel="entrar" onPress={() => void signIn('pessoa@example.com', 'Abcdef1!secure').catch(() => undefined)} />
      <Pressable accessibilityRole="button" accessibilityLabel="sair" onPress={() => void signOut()} />
      <Pressable accessibilityRole="button" accessibilityLabel="tentar" onPress={retryRestore} />
    </>
  )
}

async function mount(authApi: AuthApi, tokenStore: ReturnType<typeof memoryTokenStore>) {
  let unauthorized: (() => void) | null = null
  const registerUnauthorizedHandler = jest.fn((handler: () => void) => {
    unauthorized = handler
    return () => { unauthorized = null }
  })
  await render(
    <SessionProvider authApi={authApi} tokenStore={tokenStore} registerUnauthorizedHandler={registerUnauthorizedHandler}>
      <Probe />
    </SessionProvider>,
  )
  return { reportUnauthorized: () => act(() => { unauthorized?.() }) }
}

const stateText = () => screen.getByTestId('state').props.children as string

describe('SessionProvider', () => {
  it('keeps the person signed in across launches: a stored token is checked with GET /auth/me', async () => {
    const authApi = fakeAuthApi()
    await mount(authApi, memoryTokenStore(TOKEN))
    expect(await screen.findByText('signedIn:pessoa@example.com')).toBeTruthy()
    expect(authApi.me).toHaveBeenCalledTimes(1)
  })

  it('starts signed out without a stored token, and never asks the API', async () => {
    const authApi = fakeAuthApi()
    await mount(authApi, memoryTokenStore(null))
    expect(await screen.findByText('signedOut:')).toBeTruthy()
    expect(authApi.me).not.toHaveBeenCalled()
  })

  it('drops a token the API refuses and leads to the login with a notice', async () => {
    const tokenStore = memoryTokenStore(TOKEN)
    await mount(fakeAuthApi({ me: jest.fn(async () => { throw new ApiError('Autenticação necessária.', 401) }) }), tokenStore)
    expect(await screen.findByText(`signedOut:${SESSION_EXPIRED_NOTICE}`)).toBeTruthy()
    expect(tokenStore.current).toBeNull()
  })

  it('keeps the token and offers a retry when the API cannot be reached', async () => {
    const tokenStore = memoryTokenStore(TOKEN)
    const me = jest.fn()
      .mockRejectedValueOnce(new ApiError('Não foi possível conectar à API. Verifique sua conexão.', 0))
      .mockResolvedValueOnce({ user: USER })
    await mount(fakeAuthApi({ me }), tokenStore)
    expect(await screen.findByText('unavailable:Não foi possível conectar à API. Verifique sua conexão.')).toBeTruthy()
    expect(tokenStore.current).toBe(TOKEN)

    await fireEvent.press(screen.getByLabelText('tentar'))
    expect(await screen.findByText('signedIn:pessoa@example.com')).toBeTruthy()
  })

  it('stores the token from the token login only in the secure store', async () => {
    const tokenStore = memoryTokenStore(null)
    await mount(fakeAuthApi(), tokenStore)
    await screen.findByText('signedOut:')
    await fireEvent.press(screen.getByLabelText('entrar'))
    expect(await screen.findByText('signedIn:pessoa@example.com')).toBeTruthy()
    expect(tokenStore.save).toHaveBeenCalledWith(TOKEN)
  })

  it('stays signed out and stores nothing when the login is refused', async () => {
    const tokenStore = memoryTokenStore(null)
    await mount(fakeAuthApi({ login: jest.fn(async () => { throw new ApiError('E-mail ou senha inválidos.', 401) }) }), tokenStore)
    await screen.findByText('signedOut:')
    await fireEvent.press(screen.getByLabelText('entrar'))
    await act(async () => { await Promise.resolve() })
    expect(stateText()).toBe('signedOut:')
    expect(tokenStore.save).not.toHaveBeenCalled()
  })

  it('ends the session on the server and drops the token from the device on sign-out', async () => {
    const tokenStore = memoryTokenStore(TOKEN)
    const authApi = fakeAuthApi()
    await mount(authApi, tokenStore)
    await screen.findByText('signedIn:pessoa@example.com')
    await fireEvent.press(screen.getByLabelText('sair'))
    expect(await screen.findByText('signedOut:')).toBeTruthy()
    expect(authApi.logout).toHaveBeenCalledTimes(1)
    expect(tokenStore.current).toBeNull()
  })

  it('drops the token from the device even when the server cannot be reached on sign-out', async () => {
    const tokenStore = memoryTokenStore(TOKEN)
    await mount(fakeAuthApi({ logout: jest.fn(async () => { throw new ApiError('Não foi possível conectar à API. Verifique sua conexão.', 0) }) }), tokenStore)
    await screen.findByText('signedIn:pessoa@example.com')
    await fireEvent.press(screen.getByLabelText('sair'))
    expect(await screen.findByText('signedOut:')).toBeTruthy()
    expect(tokenStore.current).toBeNull()
  })

  it('ends the session when any later request answers 401', async () => {
    const tokenStore = memoryTokenStore(TOKEN)
    const { reportUnauthorized } = await mount(fakeAuthApi(), tokenStore)
    await screen.findByText('signedIn:pessoa@example.com')
    await reportUnauthorized()
    expect(await screen.findByText(`signedOut:${SESSION_EXPIRED_NOTICE}`)).toBeTruthy()
    expect(tokenStore.current).toBeNull()
  })
})
