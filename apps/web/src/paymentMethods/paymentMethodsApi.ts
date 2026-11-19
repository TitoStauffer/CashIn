import { createApiRequest } from '../api/request'

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

/**
 * The fields of an edit that differ from the original method. The API normalizes every nature it
 * receives, so sending an unchanged historical VA or VR nature would reclassify the method.
 */
export function paymentMethodChanges(original: PaymentMethod, name: string, nature: PaymentMethodNature): Partial<PaymentMethodInput> {
  return {
    ...(name !== original.name ? { name } : {}),
    ...(nature !== original.nature ? { nature } : {}),
  }
}

export class PaymentMethodApiError extends Error {
  readonly status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = 'PaymentMethodApiError'
    this.status = status
  }
}

const request = createApiRequest(PaymentMethodApiError)

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
