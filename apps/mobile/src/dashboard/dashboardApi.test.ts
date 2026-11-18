import type { ApiClient, ApiRequestOptions } from '../api/client'
import { createDashboardApi, type DashboardApi } from './dashboardApi'

function recordingClient() {
  const calls: { path: string; options?: ApiRequestOptions }[] = []
  const client = (async (path: string, options?: ApiRequestOptions) => {
    calls.push({ path, options })
    return { items: [] }
  }) as ApiClient
  return { api: createDashboardApi(client), calls }
}

// The contract is `docs/dashboard-summary-contract.md` and `docs/api.md`, "Metas de investimento".
// Both reads belong to the active wallet, so neither opts out of X-Wallet-Id.
describe('createDashboardApi', () => {
  it.each([
    ['summary', (api: DashboardApi) => api.summary('2026-11-01', '2026-11-30'), '/financial-summary?from=2026-11-01&to=2026-11-30'],
    ['goals', (api: DashboardApi) => api.goals(), '/investment-goals'],
  ])('%s reads the documented route in the active wallet', async (_name, call, path) => {
    const { api, calls } = recordingClient()
    await call(api)
    expect(calls).toEqual([{ path, options: undefined }])
  })
})
