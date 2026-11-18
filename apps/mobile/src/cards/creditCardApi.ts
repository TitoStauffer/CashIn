import type { ApiClient } from '../api/client'
import type { CreditCard } from '../expenses/expenseApi'

export type { CreditCard }

export type StatementPurchase = { id: string; amount: string; date: string; description: string | null; categoryName: string; subcategoryName: string | null }
export type StatementCredit = { id: string; amount: string; date: string; description: string | null; originalExpenseId: string | null }
export type StatementPayment = { id: string; amount: string; date: string; source: 'manual' | 'bank_statement' }

/** A statement as the API computes it: every amount here comes from the server, never from the app. */
export type CreditCardStatement = {
  id: string
  creditCardId: string
  creditCardName: string
  closingDate: string
  dueDate: string
  paidDate: string | null
  paidAmount: string | null
  purchasesAmount: string
  creditsAmount: string
  totalAmount: string
  paymentsAmount: string
  outstandingAmount: string
  purchases: StatementPurchase[]
  credits: StatementCredit[]
  payments: StatementPayment[]
}

export type CreditCardInput = { nickname: string; closingDay: number; dueDay: number }

/**
 * The card and statement routes of `docs/api.md`, in the active wallet. A card is never deleted, only
 * deactivated. Refunds reach a statement through imports; there is no route to add one by hand. A
 * payment without `amount` settles the outstanding balance; with it, the payment is partial.
 */
export function createCreditCardApi(request: ApiClient) {
  const card = (creditCardId: string) => `/credit-cards/${encodeURIComponent(creditCardId)}`
  return {
    list: () => request<{ items: CreditCard[] }>('/credit-cards'),
    create: (input: CreditCardInput) => request<CreditCard>('/credit-cards', { method: 'POST', body: input }),
    update: (creditCardId: string, changes: Partial<CreditCardInput> & { isActive?: boolean }) =>
      request<CreditCard>(card(creditCardId), { method: 'PATCH', body: changes }),
    listStatements: (creditCardId: string, from: string, to: string) =>
      request<{ items: CreditCardStatement[] }>(`${card(creditCardId)}/statements?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`),
    payStatement: (creditCardId: string, statementId: string, payment: { date: string; amount?: string }) =>
      request<CreditCardStatement>(`${card(creditCardId)}/statements/${encodeURIComponent(statementId)}/pay`, { method: 'POST', body: payment }),
  }
}

export type CreditCardApi = ReturnType<typeof createCreditCardApi>
