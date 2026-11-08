import type { IncomeBalanceType } from "../incomes/incomes.types.js";

export interface FinancialSummary {
  incomeTotal: string;
  expenseTotal: string;
  cashIncomeTotal: string;
  cashExpenseTotal: string;
  creditPurchaseTotal: string;
  // Refunds and chargebacks on a statement, in the period of their own date. They are already
  // subtracted from `expenseTotal`, `creditPurchaseTotal` and the category of the purchase each one
  // reverses; `cardCreditTotal` is here so a client can say why the expense fell. The unlinked part
  // is the share with no known purchase, which lowers the totals but no category.
  cardCreditTotal: string;
  unlinkedCardCreditTotal: string;
  cardPaymentTotal: string;
  // Transfers between wallets are not income nor expense, so they only move the cash balance: what
  // left this wallet and what arrived in it, each as its own total.
  transferOutTotal: string;
  transferInTotal: string;
  contributionTotal: string;
  contributionsByGoal: FinancialSummaryGoalContribution[];
  availableBalance: string;
  cashBalance: string;
  benefitBalances: FinancialSummaryBalance[];
  incomeByCategory: FinancialSummaryCategory[];
  expenseByCategory: FinancialSummaryCategory[];
}

export interface FinancialSummaryBalance {
  balanceType: Exclude<IncomeBalanceType, "cash">;
  amount: string;
}

export interface FinancialSummaryCategory {
  categoryId: string;
  categoryName: string;
  amount: string;
}

export interface FinancialSummaryGoalContribution {
  goalId: string;
  amount: string;
}

export interface FinancialSummaryRepository {
  getSummary(walletId: string, from?: string, to?: string): Promise<FinancialSummary>;
}
