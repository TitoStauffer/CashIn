import { fireEvent, render, screen } from '@testing-library/react-native'

import { HomeScreen } from './HomeScreen'

describe('HomeScreen', () => {
  it('names the account and signs out once', async () => {
    const onSignOut = jest.fn(() => new Promise<void>(() => undefined))
    await render(<HomeScreen user={{ id: '1', email: 'pessoa@example.com' }} onSignOut={onSignOut} />)

    expect(screen.getByText('Você entrou como pessoa@example.com')).toBeTruthy()
    await fireEvent.press(screen.getByRole('button', { name: 'Sair' }))
    await fireEvent.press(screen.getByRole('button', { name: 'Sair' }))
    expect(onSignOut).toHaveBeenCalledTimes(1)
  })
})
