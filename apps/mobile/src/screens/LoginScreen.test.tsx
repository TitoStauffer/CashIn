import { fireEvent, render, screen } from '@testing-library/react-native'

import { ApiError } from '../api/client'
import { LoginScreen } from './LoginScreen'

async function fill(email: string, password: string) {
  await fireEvent.changeText(screen.getByLabelText('E-mail'), email)
  await fireEvent.changeText(screen.getByLabelText('Senha'), password)
}

describe('LoginScreen', () => {
  it('signs in with the trimmed e-mail and the password as typed', async () => {
    const onSubmit = jest.fn(async () => undefined)
    await render(<LoginScreen onSubmit={onSubmit} onGoToRegister={jest.fn()} />)
    await fill('  pessoa@example.com ', ' Abcdef1!secure')
    await fireEvent.press(screen.getByRole('button', { name: 'Entrar' }))
    expect(onSubmit).toHaveBeenCalledWith('pessoa@example.com', ' Abcdef1!secure')
  })

  it('asks for both fields before calling the API', async () => {
    const onSubmit = jest.fn(async () => undefined)
    await render(<LoginScreen onSubmit={onSubmit} onGoToRegister={jest.fn()} />)
    await fill('pessoa@example.com', '')
    await fireEvent.press(screen.getByRole('button', { name: 'Entrar' }))
    expect(await screen.findByText('Informe e-mail e senha.')).toBeTruthy()
    expect(onSubmit).not.toHaveBeenCalled()
  })

  // The API answers a wrong password and an unconfirmed account alike, on purpose, and limits attempts
  // per IP; the screen shows whatever it says, in Portuguese.
  it.each([
    ['E-mail ou senha inválidos.', 401],
    ['Muitas tentativas de acesso. Aguarde alguns minutos e tente novamente.', 429],
    ['Não foi possível conectar à API. Verifique sua conexão.', 0],
  ])('shows the API message "%s" and lets the person try again', async (message, status) => {
    const onSubmit = jest.fn(async () => { throw new ApiError(message, status) })
    await render(<LoginScreen onSubmit={onSubmit} onGoToRegister={jest.fn()} />)
    await fill('pessoa@example.com', 'errada')
    await fireEvent.press(screen.getByRole('button', { name: 'Entrar' }))
    expect(await screen.findByText(message)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Entrar' })).toBeEnabled()
  })

  it('sends the form once while the login is in flight', async () => {
    let finish: () => void = () => undefined
    const onSubmit = jest.fn(() => new Promise<void>((resolve) => { finish = resolve }))
    await render(<LoginScreen onSubmit={onSubmit} onGoToRegister={jest.fn()} />)
    await fill('pessoa@example.com', 'Abcdef1!secure')
    await fireEvent.press(screen.getByRole('button', { name: 'Entrar' }))
    await fireEvent.press(screen.getByRole('button', { name: 'Entrar' }))
    expect(onSubmit).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button', { name: 'Entrar' })).toBeDisabled()
    finish()
  })

  it('shows the expired-session notice and goes to the sign-up', async () => {
    const onGoToRegister = jest.fn()
    await render(<LoginScreen onSubmit={jest.fn()} onGoToRegister={onGoToRegister} notice="Sua sessão expirou. Entre novamente." />)
    expect(screen.getByText('Sua sessão expirou. Entre novamente.')).toBeTruthy()
    await fireEvent.press(screen.getByRole('link', { name: 'Criar conta' }))
    expect(onGoToRegister).toHaveBeenCalledTimes(1)
  })

  it('masks the password field', async () => {
    await render(<LoginScreen onSubmit={jest.fn()} onGoToRegister={jest.fn()} />)
    expect(screen.getByLabelText('Senha').props.secureTextEntry).toBe(true)
  })
})
