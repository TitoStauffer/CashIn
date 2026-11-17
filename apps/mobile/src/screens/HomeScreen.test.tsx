import { fireEvent, render, screen } from '@testing-library/react-native'

import { ApiError, type ApiClient } from '../api/client'
import { HomeScreen } from './HomeScreen'

jest.mock('../api/appClient', () => ({ getApiClient: jest.fn() }))

function clientAnswering(...answers: (() => Promise<unknown>)[]): { client: ApiClient; calls: string[] } {
  const calls: string[] = []
  const client = (async (path: string) => {
    calls.push(path)
    const next = answers.shift()
    if (!next) throw new Error('unexpected request')
    return next()
  }) as ApiClient
  return { client, calls }
}

describe('HomeScreen', () => {
  it('checks the API health and says it is connected', async () => {
    const { client, calls } = clientAnswering(async () => ({ status: 'ok', database: 'ok' }))
    await render(<HomeScreen resolveClient={() => client} />)

    expect(await screen.findByText('API conectada')).toBeTruthy()
    expect(calls).toEqual(['/health'])
  })

  it('shows the API error and checks again on retry', async () => {
    const { client, calls } = clientAnswering(
      async () => { throw new ApiError('Não foi possível conectar à API. Verifique sua conexão.', 0) },
      async () => ({ status: 'ok', database: 'ok' }),
    )
    await render(<HomeScreen resolveClient={() => client} />)

    expect(await screen.findByText('Não foi possível conectar à API. Verifique sua conexão.')).toBeTruthy()
    fireEvent.press(screen.getByRole('button', { name: 'Tentar novamente' }))
    expect(await screen.findByText('API conectada')).toBeTruthy()
    expect(calls).toEqual(['/health', '/health'])
  })

  it('shows a configuration error instead of crashing when the API address is missing', async () => {
    await render(<HomeScreen resolveClient={() => { throw new Error('O endereço da API não foi configurado neste aplicativo.') }} />)
    expect(await screen.findByText('O endereço da API não foi configurado neste aplicativo.')).toBeTruthy()
  })
})
