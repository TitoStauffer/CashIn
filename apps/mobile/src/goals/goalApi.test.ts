import type { ApiClient, ApiRequestOptions } from '../api/client'
import { createGoalApi, type GoalApi, type GoalInput } from './goalApi'

function recordingClient() {
  const calls: { path: string; options?: ApiRequestOptions }[] = []
  const client = (async (path: string, options?: ApiRequestOptions) => {
    calls.push({ path, options })
    return { items: [] }
  }) as ApiClient
  return { api: createGoalApi(client), calls }
}

const GOAL: GoalInput = { title: 'Viagem', description: 'Férias', targetAmount: '5000.00', dueDate: null, categoryId: null, subcategoryId: null }
const CONTRIBUTION = { amount: '0.10', date: '2026-11-18', description: null }

// The contract is `docs/api.md`, section "Metas de investimento e aportes". Every route belongs to the
// active wallet, so none of them opts out of X-Wallet-Id.
describe('createGoalApi', () => {
  it.each([
    ['list', (api: GoalApi) => api.list(), '/investment-goals', undefined, undefined],
    ['create', (api: GoalApi) => api.create(GOAL), '/investment-goals', 'POST', GOAL],
    ['update', (api: GoalApi) => api.update('g1', GOAL), '/investment-goals/g1', 'PUT', GOAL],
    ['close', (api: GoalApi) => api.close('g1'), '/investment-goals/g1/close', 'POST', undefined],
    ['listContributions', (api: GoalApi) => api.listContributions('g1'), '/investment-goals/g1/contributions', undefined, undefined],
    ['createContribution', (api: GoalApi) => api.createContribution('g1', CONTRIBUTION), '/investment-goals/g1/contributions', 'POST', CONTRIBUTION],
    ['removeContribution', (api: GoalApi) => api.removeContribution('g1', 'c2'), '/investment-goals/g1/contributions/c2', 'DELETE', undefined],
  ])('%s calls the documented route in the active wallet', async (_name, call, path, method, body) => {
    const { api, calls } = recordingClient()
    await call(api)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.path).toBe(path)
    expect(calls[0]?.options?.scopeToActiveWallet).toBeUndefined()
    expect(calls[0]?.options?.method).toBe(method)
    expect(calls[0]?.options?.body).toEqual(body)
  })

  it('encodes goal and contribution ids, so they cannot leave their route', async () => {
    const { api, calls } = recordingClient()
    await api.removeContribution('g/../1', 'c?2')
    expect(calls[0]?.path).toBe('/investment-goals/g%2F..%2F1/contributions/c%3F2')
  })
})
