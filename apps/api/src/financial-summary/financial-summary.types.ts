import type { IncomeBalanceType } from "../incomes/incomes.types.js";

export interface FinancialSummary {
  incomeTotal: string;
  expenseTotal: string;
  contributionTotal: string;
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

export interface FinancialSummaryRepository {
  getSummary(walletId: string, from?: string, to?: string): Promise<FinancialSummary>;
}
