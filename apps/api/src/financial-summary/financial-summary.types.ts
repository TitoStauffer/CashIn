export interface FinancialSummary {
  incomeTotal: string;
  expenseTotal: string;
  contributionTotal: string;
  availableBalance: string;
  incomeByCategory: FinancialSummaryCategory[];
  expenseByCategory: FinancialSummaryCategory[];
}

export interface FinancialSummaryCategory {
  categoryId: string;
  categoryName: string;
  amount: string;
}

export interface FinancialSummaryRepository {
  getSummary(walletId: string, from?: string, to?: string): Promise<FinancialSummary>;
}
