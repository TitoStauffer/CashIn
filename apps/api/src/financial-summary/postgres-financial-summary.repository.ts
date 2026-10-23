import type { Database } from "../database.js";
import type {
  FinancialSummary,
  FinancialSummaryBalance,
  FinancialSummaryCategory,
  FinancialSummaryGoalContribution,
  FinancialSummaryRepository,
} from "./financial-summary.types.js";

interface SummaryRow {
  income_total: string;
  expense_total: string;
  cash_income_total: string;
  cash_expense_total: string;
  credit_purchase_total: string;
  contribution_total: string;
  contributions_by_goal: FinancialSummaryGoalContribution[];
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
      `WITH filtered_contributions AS (
         SELECT goal_id, amount
         FROM investment_contributions
         WHERE wallet_id = $1
           AND ($2::date IS NULL OR date >= $2::date)
           AND ($3::date IS NULL OR date <= $3::date)
       ),
       totals AS (
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
             FROM filtered_contributions AS contribution
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
             SELECT SUM(expense.amount)
             FROM expenses AS expense
             WHERE expense.wallet_id = $1
               AND expense.payment_method_nature = 'credit_card'
               AND ($2::date IS NULL OR expense.date >= $2::date)
               AND ($3::date IS NULL OR expense.date <= $3::date)
           ), 0.00) AS credit_purchase_total,
           COALESCE((
             SELECT SUM(statement.paid_amount)
             FROM credit_card_statements AS statement
             WHERE statement.wallet_id = $1
               AND statement.paid_date IS NOT NULL
               AND ($2::date IS NULL OR statement.paid_date >= $2::date)
               AND ($3::date IS NULL OR statement.paid_date <= $3::date)
           ), 0.00) AS card_payment_total
       ),
       goal_contributions AS (
         SELECT COALESCE(
           json_agg(
             json_build_object('goalId', grouped.goal_id, 'amount', trunc(grouped.amount, 2)::text)
             ORDER BY grouped.goal_id
           ), '[]'::json
         ) AS items
         FROM (
           SELECT goal_id, SUM(amount) AS amount
           FROM filtered_contributions
           GROUP BY goal_id
         ) AS grouped
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
                 AND income.balance_type = ANY(kinds.source_types)
                 AND ($2::date IS NULL OR income.date >= $2::date)
                 AND ($3::date IS NULL OR income.date <= $3::date)
             ), 0.00) AS income_total,
             COALESCE((
               SELECT SUM(expense.amount)
               FROM expenses AS expense
               WHERE expense.wallet_id = $1
                 AND expense.payment_method_nature = ANY(kinds.source_types)
                 AND ($2::date IS NULL OR expense.date >= $2::date)
                 AND ($3::date IS NULL OR expense.date <= $3::date)
             ), 0.00) AS expense_total
           FROM (VALUES
             ('food_meal_benefit', ARRAY['food_benefit', 'meal_benefit', 'food_meal_benefit']::text[]),
             ('home_office_benefit', ARRAY['home_office_benefit']::text[])
           ) AS kinds(balance_type, source_types)
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
         trunc(cash_income_total, 2)::text AS cash_income_total,
         trunc(cash_expense_total, 2)::text AS cash_expense_total,
         trunc(credit_purchase_total, 2)::text AS credit_purchase_total,
         trunc(card_payment_total, 2)::text AS card_payment_total,
         contribution_total::text AS contribution_total,
         goal_contributions.items AS contributions_by_goal,
         (cash_income_total - cash_expense_total - contribution_total - card_payment_total)::text AS cash_balance,
         (cash_income_total - cash_expense_total - contribution_total - card_payment_total)::text AS available_balance,
         benefit_balances.items AS benefit_balances,
         income_categories.items AS income_by_category,
         expense_categories.items AS expense_by_category
       FROM totals, goal_contributions, benefit_balances, income_categories, expense_categories`,
      [walletId, from ?? null, to ?? null],
    );
    const row = result.rows[0];
    if (!row) throw new Error("Financial summary query returned no row");
    return {
      incomeTotal: row.income_total,
      expenseTotal: row.expense_total,
      cashIncomeTotal: row.cash_income_total,
      cashExpenseTotal: row.cash_expense_total,
      creditPurchaseTotal: row.credit_purchase_total,
      cardPaymentTotal: row.card_payment_total,
      contributionTotal: row.contribution_total,
      contributionsByGoal: row.contributions_by_goal,
      availableBalance: row.available_balance,
      cashBalance: row.cash_balance,
      benefitBalances: row.benefit_balances,
      incomeByCategory: row.income_by_category,
      expenseByCategory: row.expense_by_category,
    };
  }
}
