export interface InvestmentGoal {
  id: string;
  title: string;
  description: string;
  targetAmount: string;
  dueDate: string | null;
  status: "active" | "closed";
  categoryId: string | null;
  categoryName: string | null;
  subcategoryId: string | null;
  subcategoryName: string | null;
  contributedAmount: string;
  progressPercentage: number;
  createdAt: string;
  updatedAt: string;
}

export interface InvestmentContribution {
  id: string;
  amount: string;
  date: string;
  description: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface InvestmentGoalInput {
  title: string;
  description: string;
  targetAmount: string;
  dueDate?: string | null;
  categoryId?: string | null;
  subcategoryId?: string | null;
}

export interface InvestmentContributionInput {
  amount: string;
  date: string;
  description?: string | null;
}

export interface InvestmentGoalsRepository {
  listGoals(userId: string): Promise<InvestmentGoal[]>;
  getGoal(userId: string, goalId: string): Promise<InvestmentGoal | null>;
  createGoal(userId: string, input: Required<InvestmentGoalInput>): Promise<InvestmentGoal | null>;
  updateGoal(userId: string, goalId: string, input: Required<InvestmentGoalInput>): Promise<InvestmentGoal | null>;
  closeGoal(userId: string, goalId: string): Promise<InvestmentGoal | null>;
  hasGoal(userId: string, goalId: string): Promise<boolean>;
  listContributions(userId: string, goalId: string): Promise<InvestmentContribution[]>;
  createContribution(
    userId: string,
    goalId: string,
    input: Required<InvestmentContributionInput>,
  ): Promise<InvestmentContribution | null>;
  updateContribution(
    userId: string,
    goalId: string,
    contributionId: string,
    input: Required<InvestmentContributionInput>,
  ): Promise<InvestmentContribution | null>;
  deleteContribution(userId: string, goalId: string, contributionId: string): Promise<boolean>;
  hasContribution(userId: string, goalId: string, contributionId: string): Promise<boolean>;
}
