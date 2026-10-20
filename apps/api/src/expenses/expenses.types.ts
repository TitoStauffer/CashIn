export interface Expense {
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

export interface ExpenseInput {
  amount: string;
  date: string;
  description?: string | null;
  categoryId: string;
  subcategoryId?: string | null;
}

export interface ExpenseRepository {
  listExpenses(userId: string, walletId: string, from?: string, to?: string): Promise<Expense[]>;
  createExpense(userId: string, walletId: string, input: Required<ExpenseInput>): Promise<Expense | null>;
  updateExpense(userId: string, walletId: string, expenseId: string, input: Required<ExpenseInput>): Promise<Expense | null>;
  deleteExpense(userId: string, walletId: string, expenseId: string): Promise<boolean>;
  hasExpense(userId: string, walletId: string, expenseId: string): Promise<boolean>;
}
