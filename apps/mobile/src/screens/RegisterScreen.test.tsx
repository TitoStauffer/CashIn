import { fireEvent, render, screen } from '@testing-library/react-native'

import { ApiError } from '../api/client'
import { CONFIRMATION_GUIDANCE, RegisterScreen } from './RegisterScreen'

async function fill(email: string, password: string, confirmation = password) {
  await fireEvent.changeText(screen.getByLabelText('E-mail'), email)
  await fireEvent.changeText(screen.getByLabelText('Senha'), password)
  await fireEvent.changeText(screen.getByLabelText('Repita a senha'), confirmation)
}

describe('RegisterScreen', () => {
  it('signs up and explains that the confirmation link opens the Web', async () => {
    const onSubmit = jest.fn(async () => 'Email enviado, favor confirmar seu cadastro')
    const onGoToLogin = jest.fn()
    await render(<RegisterScreen onSubmit={onSubmit} onGoToLogin={onGoToLogin} />)
    await fill(' pessoa@example.com ', 'Abcdef1!secure')
    await fireEvent.press(screen.getByRole('button', { name: 'Criar conta' }))

    expect(await screen.findByText('Email enviado, favor confirmar seu cadastro')).toBeTruthy()
    expect(screen.getByText(CONFIRMATION_GUIDANCE)).toBeTruthy()
    expect(onSubmit).toHaveBeenCalledWith('pessoa@example.com', 'Abcdef1!secure')
    await fireEvent.press(screen.getByRole('button', { name: 'Ir para o login' }))
    expect(onGoToLogin).toHaveBeenCalledTimes(1)
  })

  // The password rules and the duplicate address are the API's: the screen shows its message as is.
  it.each([
    ['A senha deve ter pelo menos 8 caracteres, incluindo uma letra maiúscula, uma letra minúscula, um número e um caractere especial.', 400],
    ['Muitas tentativas de cadastro. Aguarde alguns minutos e tente novamente.', 429],
  ])('shows the API refusal "%s" and keeps the form', async (message, status) => {
    await render(<RegisterScreen onSubmit={jest.fn(async () => { throw new ApiError(message, status) })} onGoToLogin={jest.fn()} />)
    await fill('pessoa@example.com', 'fraca')
    await fireEvent.press(screen.getByRole('button', { name: 'Criar conta' }))
    expect(await screen.findByText(message)).toBeTruthy()
    expect(screen.getByLabelText('E-mail')).toBeTruthy()
  })

  it('shows the API answer for an address already in use, which looks like a success on purpose', async () => {
    // The API never says an address exists (it would leak who has an account): it answers 202 again.
    await render(<RegisterScreen onSubmit={jest.fn(async () => 'Email enviado, favor confirmar seu cadastro')} onGoToLogin={jest.fn()} />)
    await fill('ja-existe@example.com', 'Abcdef1!secure')
    await fireEvent.press(screen.getByRole('button', { name: 'Criar conta' }))
    expect(await screen.findByText(CONFIRMATION_GUIDANCE)).toBeTruthy()
  })

  it('catches a mistyped repetition and empty fields before calling the API', async () => {
    const onSubmit = jest.fn(async () => 'ok')
    await render(<RegisterScreen onSubmit={onSubmit} onGoToLogin={jest.fn()} />)
    await fill('pessoa@example.com', 'Abcdef1!secure', 'Abcdef1!secur')
    await fireEvent.press(screen.getByRole('button', { name: 'Criar conta' }))
    expect(await screen.findByText('As senhas não coincidem.')).toBeTruthy()

    await fill('', 'Abcdef1!secure')
    await fireEvent.press(screen.getByRole('button', { name: 'Criar conta' }))
    expect(await screen.findByText('Informe e-mail e senha.')).toBeTruthy()
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('masks both password fields', async () => {
    await render(<RegisterScreen onSubmit={jest.fn()} onGoToLogin={jest.fn()} />)
    expect(screen.getByLabelText('Senha').props.secureTextEntry).toBe(true)
    expect(screen.getByLabelText('Repita a senha').props.secureTextEntry).toBe(true)
  })
})
