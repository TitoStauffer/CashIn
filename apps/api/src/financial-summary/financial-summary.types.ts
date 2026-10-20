export interface FinancialSummary {
  incomeTotal: string;
  expenseTotal: string;
  contributionTotal: string;
  availableBalance: string;
}

export interface FinancialSummaryRepository {
  getSummary(userId: string, from?: string, to?: string): Promise<FinancialSummary>;
}
