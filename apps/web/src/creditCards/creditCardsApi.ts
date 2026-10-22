import { withActiveWallet } from '../wallets/walletApi'

export type CreditCard = {
  id: string
  nickname: string
  closingDay: number
  dueDay: number
  isActive: boolean
}

export type CreditCardInput = {
  nickname: string
  closingDay: number
  dueDay: number
}

export type CreditCardPurchase = {
  id: string
  amount: string
  date: string
  description: string | null
  categoryName: string
  subcategoryName: string | null
}

export type CreditCardStatement = {
  id: string
  creditCardId: string
  creditCardName: string
  closingDate: string
  dueDate: string
  paidDate: string | null
  paidAmount: string | null
  totalAmount: string
  purchases: CreditCardPurchase[]
}

type ErrorResponse = { message?: string }

export class CreditCardApiError extends Error {
  readonly status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = 'CreditCardApiError'
    this.status = status
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`/api${path}`, withActiveWallet({
    ...init,
    credentials: 'include',
    headers: {
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...init.headers,
    },
  }))

  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as ErrorResponse | null
    throw new CreditCardApiError(body?.message ?? '', response.status)
  }

  if (response.status === 204) return undefined as T
  return (await response.json()) as T
}

function cardPath(cardId: string) {
  return `/credit-cards/${encodeURIComponent(cardId)}`
}

export const creditCardsApi = {
  list(signal?: AbortSignal) {
    return request<{ items: CreditCard[] }>('/credit-cards', { signal })
  },

  create(input: CreditCardInput) {
    return request<CreditCard>('/credit-cards', { method: 'POST', body: JSON.stringify(input) })
  },

  update(cardId: string, input: Partial<CreditCardInput> & { isActive?: boolean }) {
    return request<CreditCard>(cardPath(cardId), { method: 'PATCH', body: JSON.stringify(input) })
  },

  statements(cardId: string, from: string, to: string, signal?: AbortSignal) {
    const query = new URLSearchParams({ from, to })
    return request<{ items: CreditCardStatement[] }>(`${cardPath(cardId)}/statements?${query}`, { signal })
  },

  payStatement(cardId: string, statementId: string, date: string) {
    return request<CreditCardStatement>(`${cardPath(cardId)}/statements/${encodeURIComponent(statementId)}/pay`, {
      method: 'POST',
      body: JSON.stringify({ date }),
    })
  },
}
