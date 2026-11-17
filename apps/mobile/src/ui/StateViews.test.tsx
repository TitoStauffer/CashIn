import { fireEvent, render, screen } from '@testing-library/react-native'

import { EmptyState, ErrorState, LoadingState } from './StateViews'

describe('state views', () => {
  it('announces loading with its label', async () => {
    await render(<LoadingState label="Conectando à API…" />)
    expect(screen.getByLabelText('Conectando à API…')).toBeTruthy()
    expect(screen.getByText('Conectando à API…')).toBeTruthy()
  })

  it('shows the error message and retries on request', async () => {
    const onRetry = jest.fn()
    await render(<ErrorState message="Não foi possível conectar à API." onRetry={onRetry} />)

    expect(screen.getByText('Algo deu errado')).toBeTruthy()
    expect(screen.getByText('Não foi possível conectar à API.')).toBeTruthy()
    fireEvent.press(screen.getByRole('button', { name: 'Tentar novamente' }))
    expect(onRetry).toHaveBeenCalledTimes(1)
  })

  it('shows no retry button when there is nothing to retry', async () => {
    await render(<ErrorState message="Falhou." />)
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('shows the empty title and an optional message', async () => {
    await render(<EmptyState title="Nenhuma despesa" message="Lance a primeira." />)
    expect(screen.getByText('Nenhuma despesa')).toBeTruthy()
    expect(screen.getByText('Lance a primeira.')).toBeTruthy()
  })
})
