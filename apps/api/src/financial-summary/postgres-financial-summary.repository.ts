import type { Database } from "../database.js";
import type { FinancialSummary, FinancialSummaryCategory, FinancialSummaryRepository } from "./financial-summary.types.js";

interface SummaryRow {
  income_total: string;
  expense_total: string;
  contribution_total: string;
  available_balance: string;
  income_by_category: FinancialSummaryCategory[];
  expense_by_category: FinancialSummaryCategory[];
}

export class PostgresFinancialSummaryRepository implements FinancialSummaryRepository {
  constructor(private readonly database: Database) {}

  async getSummary(walletId: string, from?: string, to?: string): Promise<FinancialSummary> {
    const result = await this.database.query<SummaryRow>(
      `WITH totals AS (
         SELECT
           COALESCE((
             SELECT SUM(income.amount)
             FROM incomes AS income
             WHERE income.wallet_id = $1
               AND ($2::date IS NULL OR income.date >= $2::date)
               AND ($3::date IS NULL OR income.date <= $3::date)
           ), 0.00) AS income_total,
           COALESCE((
             SELECT SUM(expense.amount)
             FROM expenses AS expense
             WHERE expense.wallet_id = $1
               AND ($2::date IS NULL OR expense.date >= $2::date)
               AND ($3::date IS NULL OR expense.date <= $3::date)
           ), 0.00) AS expense_total,
           COALESCE((
             SELECT SUM(contribution.amount)
             FROM investment_contributions AS contribution
             WHERE contribution.wallet_id = $1
               AND ($2::date IS NULL OR contribution.date >= $2::date)
               AND ($3::date IS NULL OR contribution.date <= $3::date)
           ), 0.00) AS contribution_total
       ),
       income_categories AS (
         SELECT COALESCE(
           json_agg(
             json_build_object(
               'categoryId', category.id,
               'categoryName', category.name,
               'amount', grouped.amount::text
             ) ORDER BY category.name, category.id
           ), '[]'::json
         ) AS items
         FROM (
           SELECT income.category_id, SUM(income.amount) AS amount
           FROM incomes AS income
           WHERE income.wallet_id = $1
             AND ($2::date IS NULL OR income.date >= $2::date)
             AND ($3::date IS NULL OR income.date <= $3::date)
           GROUP BY income.category_id
         ) AS grouped
         JOIN categories AS category
           ON category.id = grouped.category_id
          AND category.wallet_id = $1
          AND category.nature = 'income'
       ),
       expense_categories AS (
         SELECT COALESCE(
           json_agg(
             json_build_object(
               'categoryId', category.id,
               'categoryName', category.name,
               'amount', grouped.amount::text
             ) ORDER BY category.name, category.id
           ), '[]'::json
         ) AS items
         FROM (
           SELECT expense.category_id, SUM(expense.amount) AS amount
           FROM expenses AS expense
           WHERE expense.wallet_id = $1
             AND ($2::date IS NULL OR expense.date >= $2::date)
             AND ($3::date IS NULL OR expense.date <= $3::date)
           GROUP BY expense.category_id
         ) AS grouped
         JOIN categories AS category
           ON category.id = grouped.category_id
          AND category.wallet_id = $1
          AND category.nature = 'expense'
       )
       SELECT
         income_total::text AS income_total,
         expense_total::text AS expense_total,
         contribution_total::text AS contribution_total,
         (income_total - expense_total - contribution_total)::text AS available_balance,
         income_categories.items AS income_by_category,
         expense_categories.items AS expense_by_category
       FROM totals, income_categories, expense_categories`,
      [walletId, from ?? null, to ?? null],
    );
    const row = result.rows[0];
    if (!row) throw new Error("Financial summary query returned no row");
    return {
      incomeTotal: row.income_total,
      expenseTotal: row.expense_total,
      contributionTotal: row.contribution_total,
      availableBalance: row.available_balance,
      incomeByCategory: row.income_by_category,
      expenseByCategory: row.expense_by_category,
    };
  }
}
