import { createApiRequest } from '../api/request'

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

// Refunds and chargebacks reduce the statement total; they are never income.
export type CreditCardStatementCredit = {
  id: string
  amount: string
  date: string
  description: string | null
  originalExpenseId: string | null
}

// A statement may be paid in full or in parts, and a payment may come from a reconciled bank
// statement line.
export type CreditCardStatementPaymentSource = 'manual' | 'bank_statement'

export type CreditCardStatementPayment = {
  id: string
  amount: string
  date: string
  source: CreditCardStatementPaymentSource
}

export type CreditCardStatement = {
  id: string
  creditCardId: string
  creditCardName: string
  closingDate: string
  dueDate: string
  paidDate: string | null
  paidAmount: string | null
  purchasesAmount?: string
  creditsAmount?: string
  // Purchases minus credits.
  totalAmount: string
  paymentsAmount?: string
  // Total minus payments; never negative, so an overpayment reads as settled instead of as debt.
  outstandingAmount: string
  purchases: CreditCardPurchase[]
  credits?: CreditCardStatementCredit[]
  payments?: CreditCardStatementPayment[]
}


export class CreditCardApiError extends Error {
  readonly status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = 'CreditCardApiError'
    this.status = status
  }
}

const request = createApiRequest(CreditCardApiError)

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

  // Without an amount the payment settles the outstanding balance in full.
  payStatement(cardId: string, statementId: string, date: string, amount?: string) {
    return request<CreditCardStatement>(`${cardPath(cardId)}/statements/${encodeURIComponent(statementId)}/pay`, {
      method: 'POST',
      body: JSON.stringify(amount ? { date, amount } : { date }),
    })
  },
}
