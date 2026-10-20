export interface Income {
  id: string;
  amount: string;
  date: string;
  description: string | null;
  categoryId: string;
  categoryName: string;
  subcategoryId: string | null;
  subcategoryName: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface IncomeInput {
  amount: string;
  date: string;
  description?: string | null;
  categoryId: string;
  subcategoryId?: string | null;
}

export interface IncomeRepository {
  listIncomes(userId: string, from?: string, to?: string): Promise<Income[]>;
  createIncome(userId: string, input: Required<IncomeInput>): Promise<Income | null>;
  updateIncome(userId: string, incomeId: string, input: Required<IncomeInput>): Promise<Income | null>;
  deleteIncome(userId: string, incomeId: string): Promise<boolean>;
  hasIncome(userId: string, incomeId: string): Promise<boolean>;
}
