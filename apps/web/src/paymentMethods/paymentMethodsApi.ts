import { withActiveWallet } from '../wallets/walletApi'

export type PaymentMethodNature =
  | 'immediate'
  | 'credit_card'
  | 'food_benefit'
  | 'meal_benefit'
  | 'food_meal_benefit'
  | 'home_office_benefit'

export type PaymentMethod = {
  id: string
  name: string
  nature: PaymentMethodNature
  isActive: boolean
}

export type PaymentMethodInput = {
  name: string
  nature: PaymentMethodNature
}

type PaymentMethodListResponse = { items: PaymentMethod[] }
type ErrorResponse = { message?: string }

export const paymentMethodNatures: Array<{ value: PaymentMethodNature; label: string }> = [
  { value: 'immediate', label: 'Imediata (dinheiro, débito ou Pix)' },
  { value: 'credit_card', label: 'Cartão de crédito' },
  { value: 'food_meal_benefit', label: 'Cartão de benefícios (VA/VR)' },
  { value: 'home_office_benefit', label: 'Auxílio home office (AHO)' },
]

export function getPaymentMethodNatureLabel(nature: PaymentMethodNature | null) {
  if (nature === 'food_benefit') return 'Vale-alimentação (VA) · histórico'
  if (nature === 'meal_benefit') return 'Vale-refeição (VR) · histórico'
  return paymentMethodNatures.find((item) => item.value === nature)?.label ?? ''
}

export class PaymentMethodApiError extends Error {
  readonly status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = 'PaymentMethodApiError'
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
    throw new PaymentMethodApiError(body?.message ?? '', response.status)
  }

  if (response.status === 204) return undefined as T
  return (await response.json()) as T
}

function paymentMethodPath(paymentMethodId: string) {
  return `/payment-methods/${encodeURIComponent(paymentMethodId)}`
}

export const paymentMethodsApi = {
  list(signal?: AbortSignal) {
    return request<PaymentMethodListResponse>('/payment-methods', { signal })
  },

  create(input: PaymentMethodInput) {
    return request<PaymentMethod>('/payment-methods', { method: 'POST', body: JSON.stringify(input) })
  },

  update(paymentMethodId: string, input: Partial<PaymentMethodInput> & { isActive?: boolean }) {
    return request<PaymentMethod>(paymentMethodPath(paymentMethodId), {
      method: 'PATCH',
      body: JSON.stringify(input),
    })
  },
}
