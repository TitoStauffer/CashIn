import type { IncomeBalanceType } from "../incomes/incomes.types.js";

export interface FinancialSummary {
  incomeTotal: string;
  expenseTotal: string;
  cashIncomeTotal: string;
  cashExpenseTotal: string;
  creditPurchaseTotal: string;
  cardPaymentTotal: string;
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
