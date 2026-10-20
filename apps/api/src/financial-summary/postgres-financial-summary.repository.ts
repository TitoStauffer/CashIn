import type { Database } from "../database.js";
import type { FinancialSummary, FinancialSummaryBalance, FinancialSummaryCategory, FinancialSummaryRepository } from "./financial-summary.types.js";

interface SummaryRow {
  income_total: string;
  expense_total: string;
  contribution_total: string;
  available_balance: string;
  cash_balance: string;
  card_payment_total: string;
  benefit_balances: FinancialSummaryBalance[];
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
           ), 0.00) AS contribution_total,
           COALESCE((
             SELECT SUM(income.amount)
             FROM incomes AS income
             WHERE income.wallet_id = $1
               AND income.balance_type = 'cash'
               AND ($2::date IS NULL OR income.date >= $2::date)
               AND ($3::date IS NULL OR income.date <= $3::date)
           ), 0.00) AS cash_income_total,
           COALESCE((
             SELECT SUM(expense.amount)
             FROM expenses AS expense
             WHERE expense.wallet_id = $1
               AND (expense.payment_method_nature IS NULL OR expense.payment_method_nature = 'immediate')
               AND ($2::date IS NULL OR expense.date >= $2::date)
               AND ($3::date IS NULL OR expense.date <= $3::date)
           ), 0.00) AS cash_expense_total,
           COALESCE((
             SELECT SUM(statement.paid_amount)
             FROM credit_card_statements AS statement
             WHERE statement.wallet_id = $1
               AND statement.paid_date IS NOT NULL
               AND ($2::date IS NULL OR statement.paid_date >= $2::date)
               AND ($3::date IS NULL OR statement.paid_date <= $3::date)
           ), 0.00) AS card_payment_total
       ),
       benefit_balances AS (
         SELECT json_agg(
           json_build_object('balanceType', benefit.balance_type, 'amount', (benefit.income_total - benefit.expense_total)::text)
           ORDER BY benefit.balance_type
         ) AS items
         FROM (
           SELECT balance_type,
             COALESCE((
               SELECT SUM(income.amount)
               FROM incomes AS income
               WHERE income.wallet_id = $1
                 AND income.balance_type = kinds.balance_type
                 AND ($2::date IS NULL OR income.date >= $2::date)
                 AND ($3::date IS NULL OR income.date <= $3::date)
             ), 0.00) AS income_total,
             COALESCE((
               SELECT SUM(expense.amount)
               FROM expenses AS expense
               WHERE expense.wallet_id = $1
                 AND expense.payment_method_nature = kinds.balance_type
                 AND ($2::date IS NULL OR expense.date >= $2::date)
                 AND ($3::date IS NULL OR expense.date <= $3::date)
             ), 0.00) AS expense_total
           FROM (VALUES ('food_benefit'), ('meal_benefit'), ('home_office_benefit')) AS kinds(balance_type)
         ) AS benefit
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
         (cash_income_total - cash_expense_total - contribution_total - card_payment_total)::text AS cash_balance,
         (cash_income_total - cash_expense_total - contribution_total - card_payment_total)::text AS available_balance,
         benefit_balances.items AS benefit_balances,
         income_categories.items AS income_by_category,
         expense_categories.items AS expense_by_category
       FROM totals, benefit_balances, income_categories, expense_categories`,
      [walletId, from ?? null, to ?? null],
    );
    const row = result.rows[0];
    if (!row) throw new Error("Financial summary query returned no row");
    return {
      incomeTotal: row.income_total,
      expenseTotal: row.expense_total,
      contributionTotal: row.contribution_total,
      availableBalance: row.available_balance,
      cashBalance: row.cash_balance,
      benefitBalances: row.benefit_balances,
      incomeByCategory: row.income_by_category,
      expenseByCategory: row.expense_by_category,
    };
  }
}
