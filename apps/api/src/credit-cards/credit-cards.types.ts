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

export interface CreditCardStatement {
  id: string;
  creditCardId: string;
  creditCardName: string;
  closingDate: string;
  dueDate: string;
  paidDate: string | null;
  paidAmount: string | null;
  totalAmount: string;
  purchases: CreditCardPurchase[];
}

export interface CreditCardRepository {
  list(walletId: string): Promise<CreditCard[]>;
  create(walletId: string, input: { nickname: string; closingDay: number; dueDay: number }): Promise<CreditCard>;
  update(walletId: string, creditCardId: string, changes: { nickname?: string; closingDay?: number; dueDay?: number; isActive?: boolean }): Promise<CreditCard | null>;
  listStatements(walletId: string, creditCardId: string, from?: string, to?: string): Promise<CreditCardStatement[] | null>;
  payStatement(walletId: string, creditCardId: string, statementId: string, date: string): Promise<CreditCardStatement | null>;
}
