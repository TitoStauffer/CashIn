import { act, renderHook } from '@testing-library/react-native'

import { ApiError } from '../api/client'
import { ACTION_FAILED, useActionRunner } from './useActionRunner'

describe('useActionRunner', () => {
  it('runs one action at a time, shows its message and reads the data again', async () => {
    const afterSuccess = jest.fn()
    let finish: () => void = () => undefined
    const action = jest.fn(() => new Promise<string>((resolve) => { finish = () => resolve('Salvo.') }))
    const { result } = await renderHook(() => useActionRunner(afterSuccess))

    let first: Promise<void> = Promise.resolve()
    await act(async () => {
      first = result.current.run(action)
      void result.current.run(action)
    })
    expect(action).toHaveBeenCalledTimes(1)
    expect(result.current.busy).toBe(true)

    await act(async () => { finish(); await first })
    expect(result.current.feedback).toEqual({ tone: 'info', message: 'Salvo.' })
    expect(result.current.busy).toBe(false)
    expect(afterSuccess).toHaveBeenCalledTimes(1)
  })

  it('does not report an action that ends after the scope changed', async () => {
    const afterSuccess = jest.fn()
    let finish: () => void = () => undefined
    const { result, rerender } = await renderHook(({ scope }: { scope: string }) => useActionRunner(afterSuccess, scope), { initialProps: { scope: 'personal' } })
    let pending: Promise<void> = Promise.resolve()
    await act(async () => { pending = result.current.run(() => new Promise<string>((resolve) => { finish = () => resolve('Salvo.') })) })

    await rerender({ scope: 'house' })
    await act(async () => { finish(); await pending })
    expect(result.current.feedback).toBeNull()
    expect(afterSuccess).not.toHaveBeenCalled()
    expect(result.current.busy).toBe(false)
  })

  it('shows the API refusal and does not read the data again', async () => {
    const afterSuccess = jest.fn()
    const { result } = await renderHook(() => useActionRunner(afterSuccess))
    await act(async () => { await result.current.run(async () => { throw new ApiError('Já existe.', 409) }) })
    expect(result.current.feedback).toEqual({ tone: 'error', message: 'Já existe.' })
    expect(afterSuccess).not.toHaveBeenCalled()

    await act(async () => { await result.current.run(async () => { throw new Error('') }) })
    expect(result.current.feedback).toEqual({ tone: 'error', message: ACTION_FAILED })
  })
})
