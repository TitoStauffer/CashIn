import { afterEach, describe, expect, it, vi } from 'vitest'
import { DashboardApiError, dashboardApi } from './dashboardApi'
import { setRequestWalletId } from '../wallets/walletApi'

afterEach(() => { vi.unstubAllGlobals(); setRequestWalletId(null) })

describe('dashboard API', () => {
  it('loads the summary with explicit period, wallet credentials and cancellation', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ contributionsByGoal: [{ goalId: 'goal', amount: '0.30' }] })))
    vi.stubGlobal('fetch', fetchMock)
    setRequestWalletId('wallet-a')
    const controller = new AbortController()
    expect(await dashboardApi.summary('2026-10-01', '2026-10-31', controller.signal)).toEqual({ contributionsByGoal: [{ goalId: 'goal', amount: '0.30' }] })
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/financial-summary?from=2026-10-01&to=2026-10-31')
    expect(init.credentials).toBe('include')
    expect(init.signal).toBe(controller.signal)
    expect(new Headers(init.headers).get('X-Wallet-Id')).toBe('wallet-a')
  })

  it('loads goal metadata in a single request', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ items: [] })))
    vi.stubGlobal('fetch', fetchMock)
    expect(await dashboardApi.goals()).toEqual({ items: [] })
    expect(fetchMock).toHaveBeenCalledWith('/api/investment-goals', expect.objectContaining({ credentials: 'include' }))
  })

  it('preserves API error status and tolerates a non-JSON error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ message: 'Falha temporária' }), { status: 503 })).mockResolvedValueOnce(new Response('offline', { status: 502 })))
    await expect(dashboardApi.goals()).rejects.toMatchObject({ name: 'DashboardApiError', status: 503, message: 'Falha temporária' })
    await expect(dashboardApi.goals()).rejects.toEqual(new DashboardApiError('', 502))
  })
})
