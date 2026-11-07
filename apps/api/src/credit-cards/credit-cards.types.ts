export interface CreditCard {
  id: string;
  nickname: string;
  closingDay: number;
  dueDay: number;
  isActive: boolean;
}

export interface CreditCardPurchase {
  id: string;
  amount: string;
  date: string;
  description: string | null;
  categoryName: string;
  subcategoryName: string | null;
}

// Refunds and chargebacks reduce the statement total; they are never income.
export interface CreditCardStatementCredit {
  id: string;
  amount: string;
  date: string;
  description: string | null;
  originalExpenseId: string | null;
}

// A statement may be paid in full or in parts, and a payment may come from a reconciled bank
// statement line. paidDate/paidAmount keep meaning "settled in full".
export interface CreditCardStatementPayment {
  id: string;
  amount: string;
  date: string;
  source: CreditCardStatementPaymentSource;
}

export const CREDIT_CARD_PAYMENT_SOURCES = ["manual", "bank_statement"] as const;
export type CreditCardStatementPaymentSource = (typeof CREDIT_CARD_PAYMENT_SOURCES)[number];

export interface CreditCardStatement {
  id: string;
  creditCardId: string;
  creditCardName: string;
  closingDate: string;
  dueDate: string;
  paidDate: string | null;
  paidAmount: string | null;
  purchasesAmount: string;
  creditsAmount: string;
  // Purchases minus credits.
  totalAmount: string;
  paymentsAmount: string;
  // Total minus payments; never negative, so an overpayment reads as settled instead of as debt.
  outstandingAmount: string;
  purchases: CreditCardPurchase[];
  credits: CreditCardStatementCredit[];
  payments: CreditCardStatementPayment[];
}

export interface CreditCardRepository {
  list(walletId: string): Promise<CreditCard[]>;
  create(walletId: string, input: { nickname: string; closingDay: number; dueDay: number }): Promise<CreditCard>;
  update(walletId: string, creditCardId: string, changes: { nickname?: string; closingDay?: number; dueDay?: number; isActive?: boolean }): Promise<CreditCard | null>;
  listStatements(walletId: string, creditCardId: string, from?: string, to?: string): Promise<CreditCardStatement[] | null>;
  // A payment without an amount settles the outstanding balance in full.
  payStatement(walletId: string, creditCardId: string, statementId: string, date: string, amount?: string): Promise<CreditCardStatement | null>;
}
