import type { Database } from "../database.js";
import type { FinancialSummary, FinancialSummaryRepository } from "./financial-summary.types.js";

interface SummaryRow {
  income_total: string;
  expense_total: string;
  contribution_total: string;
  available_balance: string;
}

export class PostgresFinancialSummaryRepository implements FinancialSummaryRepository {
  constructor(private readonly database: Database) {}

  async getSummary(userId: string, from?: string, to?: string): Promise<FinancialSummary> {
    const result = await this.database.query<SummaryRow>(
      `WITH totals AS (
         SELECT
           COALESCE((
             SELECT SUM(income.amount)
             FROM incomes AS income
             WHERE income.user_id = $1
               AND ($2::date IS NULL OR income.date >= $2::date)
               AND ($3::date IS NULL OR income.date <= $3::date)
           ), 0.00) AS income_total,
           COALESCE((
             SELECT SUM(expense.amount)
             FROM expenses AS expense
             WHERE expense.user_id = $1
               AND ($2::date IS NULL OR expense.date >= $2::date)
               AND ($3::date IS NULL OR expense.date <= $3::date)
           ), 0.00) AS expense_total,
           COALESCE((
             SELECT SUM(contribution.amount)
             FROM investment_contributions AS contribution
             WHERE contribution.user_id = $1
               AND ($2::date IS NULL OR contribution.date >= $2::date)
               AND ($3::date IS NULL OR contribution.date <= $3::date)
           ), 0.00) AS contribution_total
       )
       SELECT
         income_total::text AS income_total,
         expense_total::text AS expense_total,
         contribution_total::text AS contribution_total,
         (income_total - expense_total - contribution_total)::text AS available_balance
       FROM totals`,
      [userId, from ?? null, to ?? null],
    );
    const row = result.rows[0];
    if (!row) throw new Error("Financial summary query returned no row");
    return {
      incomeTotal: row.income_total,
      expenseTotal: row.expense_total,
      contributionTotal: row.contribution_total,
      availableBalance: row.available_balance,
    };
  }
}
