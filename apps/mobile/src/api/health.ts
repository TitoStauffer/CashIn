import type { ApiClient } from './client'

export type HealthResponse = { status: 'ok'; database: 'ok' }

/** `GET /health`: whether the API and its database answer. It runs before any session or wallet. */
export function fetchHealth(request: ApiClient): Promise<HealthResponse> {
  return request<HealthResponse>('/health', { scopeToActiveWallet: false })
}
