import type { Database } from "../database.js";
import type {
  InvestmentContribution,
  InvestmentContributionInput,
  InvestmentGoal,
  InvestmentGoalInput,
  InvestmentGoalsRepository,
} from "./investment-goals.types.js";

interface GoalRow {
  id: string;
  title: string;
  description: string;
  target_amount: string;
  due_date: string | Date | null;
  closed_at: string | Date | null;
  category_id: string | null;
  category_nature: "investment" | "investment_goal";
  category_name: string | null;
  subcategory_id: string | null;
  subcategory_name: string | null;
  contributed_amount: string;
  progress_percentage: string;
  created_at: string | Date;
  updated_at: string | Date;
}

interface ContributionRow {
  id: string;
  amount: string;
  date: string | Date;
  description: string | null;
  created_at: string | Date;
  updated_at: string | Date;
}

function dateValue(value: string | Date | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString().slice(0, 10) : value.slice(0, 10);
}

function timestampValue(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function mapGoal(row: GoalRow): InvestmentGoal {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    targetAmount: row.target_amount,
    dueDate: dateValue(row.due_date),
    status: row.closed_at === null ? "active" : "closed",
    categoryId: row.category_id,
    categoryName: row.category_name,
    subcategoryId: row.subcategory_id,
    subcategoryName: row.subcategory_name,
    contributedAmount: row.contributed_amount,
    progressPercentage: Number(row.progress_percentage),
    createdAt: timestampValue(row.created_at),
    updatedAt: timestampValue(row.updated_at),
  };
}

function mapContribution(row: ContributionRow): InvestmentContribution {
  return {
    id: row.id,
    amount: row.amount,
    date: dateValue(row.date)!,
    description: row.description,
    createdAt: timestampValue(row.created_at),
    updatedAt: timestampValue(row.updated_at),
  };
}

const goalColumns = `
  goal.id,
  goal.title,
  goal.description,
  goal.target_amount::text AS target_amount,
  goal.due_date,
  goal.closed_at,
  goal.category_id,
  category.name AS category_name,
  goal.subcategory_id,
  subcategory.name AS subcategory_name,
  COALESCE(contribution_totals.total, 0)::text AS contributed_amount,
  CASE
    WHEN goal.target_amount = 0 THEN 0::numeric
    ELSE ROUND(COALESCE(contribution_totals.total, 0) * 100 / goal.target_amount, 2)
  END::text AS progress_percentage,
  goal.created_at,
  goal.updated_at`;

const goalJoins = `
  LEFT JOIN categories AS category
    ON category.id = goal.category_id
   AND category.user_id = goal.user_id
   AND category.nature IN ('investment', 'investment_goal')
  LEFT JOIN subcategories AS subcategory
    ON subcategory.id = goal.subcategory_id
   AND subcategory.user_id = goal.user_id
   AND subcategory.category_id = goal.category_id
  LEFT JOIN LATERAL (
    SELECT SUM(contribution.amount) AS total
    FROM investment_contributions AS contribution
    WHERE contribution.goal_id = goal.id
      AND contribution.user_id = goal.user_id
  ) AS contribution_totals ON true`;

const contributionColumns = `
  contribution.id,
  contribution.amount::text AS amount,
  contribution.date,
  contribution.description,
  contribution.created_at,
  contribution.updated_at`;

export class PostgresInvestmentGoalsRepository implements InvestmentGoalsRepository {
  constructor(private readonly database: Database) {}

  async listGoals(userId: string): Promise<InvestmentGoal[]> {
    const result = await this.database.query<GoalRow>(
      `SELECT ${goalColumns}
       FROM investment_goals AS goal
       ${goalJoins}
       WHERE goal.user_id = $1
       ORDER BY goal.created_at DESC, goal.id DESC`,
      [userId],
    );
    return result.rows.map(mapGoal);
  }

  async getGoal(userId: string, goalId: string): Promise<InvestmentGoal | null> {
    const result = await this.database.query<GoalRow>(
      `SELECT ${goalColumns}
       FROM investment_goals AS goal
       ${goalJoins}
       WHERE goal.user_id = $1 AND goal.id = $2`,
      [userId, goalId],
    );
    const row = result.rows[0];
    return row ? mapGoal(row) : null;
  }

  async createGoal(userId: string, input: Required<InvestmentGoalInput>): Promise<InvestmentGoal | null> {
    const result = await this.database.query<GoalRow>(
      `WITH inserted AS (
         INSERT INTO investment_goals (user_id, title, description, target_amount, due_date, category_id, subcategory_id, category_nature)
         SELECT $1, $2, $3, $4::numeric, $5::date, category.id, $7::uuid, COALESCE(category.nature, 'investment')
         FROM (SELECT 1) AS source
         LEFT JOIN categories AS category
           ON category.id = $6::uuid
          AND category.user_id = $1
          AND category.nature IN ('investment', 'investment_goal')
         WHERE ($6::uuid IS NULL OR category.id IS NOT NULL)
           AND ($7::uuid IS NULL OR EXISTS (
             SELECT 1 FROM subcategories AS subcategory
             WHERE subcategory.id = $7::uuid
               AND subcategory.user_id = $1
               AND subcategory.category_id = category.id
           ))
         RETURNING *
       )
       SELECT ${goalColumns.replaceAll("goal.", "inserted.")}
       FROM inserted
       ${goalJoins.replaceAll("goal.", "inserted.")}`,
      [userId, input.title, input.description, input.targetAmount, input.dueDate, input.categoryId, input.subcategoryId],
    );
    const row = result.rows[0];
    return row ? mapGoal(row) : null;
  }

  async updateGoal(
    userId: string,
    goalId: string,
    input: Required<InvestmentGoalInput>,
  ): Promise<InvestmentGoal | null> {
    const result = await this.database.query<GoalRow>(
      `WITH updated AS (
         UPDATE investment_goals AS goal
         SET title = $3,
             description = $4,
             target_amount = $5::numeric,
             due_date = $6::date,
             category_id = category.id,
             subcategory_id = $8::uuid,
             category_nature = COALESCE(category.nature, 'investment'),
             updated_at = now()
         FROM (SELECT 1) AS source
         LEFT JOIN categories AS category
           ON category.id = $7::uuid
          AND category.user_id = $2
          AND category.nature IN ('investment', 'investment_goal')
         WHERE goal.id = $1
           AND goal.user_id = $2
           AND ($7::uuid IS NULL OR category.id IS NOT NULL)
           AND ($8::uuid IS NULL OR EXISTS (
             SELECT 1 FROM subcategories AS subcategory
             WHERE subcategory.id = $8::uuid
               AND subcategory.user_id = $2
               AND subcategory.category_id = category.id
           ))
         RETURNING goal.*
       )
       SELECT ${goalColumns.replaceAll("goal.", "updated.")}
       FROM updated
       ${goalJoins.replaceAll("goal.", "updated.")}`,
      [goalId, userId, input.title, input.description, input.targetAmount, input.dueDate, input.categoryId, input.subcategoryId],
    );
    const row = result.rows[0];
    return row ? mapGoal(row) : null;
  }

  async closeGoal(userId: string, goalId: string): Promise<InvestmentGoal | null> {
    const result = await this.database.query<GoalRow>(
      `WITH updated AS (
         UPDATE investment_goals AS goal
         SET closed_at = COALESCE(goal.closed_at, now()), updated_at = now()
         WHERE goal.id = $1 AND goal.user_id = $2
         RETURNING goal.*
       )
       SELECT ${goalColumns.replaceAll("goal.", "updated.")}
       FROM updated
       ${goalJoins.replaceAll("goal.", "updated.")}`,
      [goalId, userId],
    );
    const row = result.rows[0];
    return row ? mapGoal(row) : null;
  }

  async hasGoal(userId: string, goalId: string): Promise<boolean> {
    const result = await this.database.query<{ exists: boolean }>(
      "SELECT EXISTS (SELECT 1 FROM investment_goals WHERE id = $1 AND user_id = $2) AS exists",
      [goalId, userId],
    );
    return result.rows[0]?.exists ?? false;
  }

  async listContributions(userId: string, goalId: string): Promise<InvestmentContribution[]> {
    const result = await this.database.query<ContributionRow>(
      `SELECT ${contributionColumns}
       FROM investment_contributions AS contribution
       WHERE contribution.user_id = $1 AND contribution.goal_id = $2
       ORDER BY contribution.date DESC, contribution.created_at DESC, contribution.id DESC`,
      [userId, goalId],
    );
    return result.rows.map(mapContribution);
  }

  async createContribution(
    userId: string,
    goalId: string,
    input: Required<InvestmentContributionInput>,
  ): Promise<InvestmentContribution | null> {
    const result = await this.database.query<ContributionRow>(
      `INSERT INTO investment_contributions (user_id, goal_id, amount, date, description)
       SELECT $1, goal.id, $3::numeric, $4::date, $5
       FROM investment_goals AS goal
       WHERE goal.id = $2 AND goal.user_id = $1 AND goal.closed_at IS NULL
       RETURNING ${contributionColumns.replaceAll("contribution.", "")}`,
      [userId, goalId, input.amount, input.date, input.description],
    );
    const row = result.rows[0];
    return row ? mapContribution(row) : null;
  }

  async updateContribution(
    userId: string,
    goalId: string,
    contributionId: string,
    input: Required<InvestmentContributionInput>,
  ): Promise<InvestmentContribution | null> {
    const result = await this.database.query<ContributionRow>(
      `UPDATE investment_contributions AS contribution
       SET amount = $4::numeric, date = $5::date, description = $6, updated_at = now()
       FROM investment_goals AS goal
       WHERE contribution.id = $1
         AND contribution.user_id = $2
         AND contribution.goal_id = $3
         AND goal.id = contribution.goal_id
         AND goal.user_id = contribution.user_id
       RETURNING ${contributionColumns}`,
      [contributionId, userId, goalId, input.amount, input.date, input.description],
    );
    const row = result.rows[0];
    return row ? mapContribution(row) : null;
  }

  async deleteContribution(userId: string, goalId: string, contributionId: string): Promise<boolean> {
    const result = await this.database.query(
      "DELETE FROM investment_contributions WHERE id = $1 AND user_id = $2 AND goal_id = $3",
      [contributionId, userId, goalId],
    );
    return result.rowCount === 1;
  }

  async hasContribution(userId: string, goalId: string, contributionId: string): Promise<boolean> {
    const result = await this.database.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM investment_contributions
         WHERE id = $1 AND user_id = $2 AND goal_id = $3
       ) AS exists`,
      [contributionId, userId, goalId],
    );
    return result.rows[0]?.exists ?? false;
  }
}
