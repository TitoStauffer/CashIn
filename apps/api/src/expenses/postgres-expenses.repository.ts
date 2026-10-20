import type { Database } from "../database.js";
import type { Expense, ExpenseInput, ExpenseRepository } from "./expenses.types.js";

interface ExpenseRow {
  id: string;
  amount: string;
  date: string | Date;
  description: string | null;
  category_id: string;
  category_name: string;
  subcategory_id: string | null;
  subcategory_name: string | null;
  payment_method_id: string | null;
  payment_method_name: string | null;
  payment_method_nature: import("../payment-methods/payment-methods.types.js").PaymentMethodNature | null;
  created_at: string | Date;
  updated_at: string | Date;
}

function dateValue(value: string | Date): string {
  return value instanceof Date ? value.toISOString().slice(0, 10) : value.slice(0, 10);
}

function timestampValue(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function mapExpense(row: ExpenseRow): Expense {
  return {
    id: row.id,
    amount: row.amount,
    date: dateValue(row.date),
    description: row.description,
    categoryId: row.category_id,
    categoryName: row.category_name,
    subcategoryId: row.subcategory_id,
    subcategoryName: row.subcategory_name,
    paymentMethodId: row.payment_method_id,
    paymentMethodName: row.payment_method_name,
    paymentMethodNature: row.payment_method_nature,
    createdAt: timestampValue(row.created_at),
    updatedAt: timestampValue(row.updated_at),
  };
}

const resultColumns = `
  expense.id,
  expense.amount::text AS amount,
  expense.date,
  expense.description,
  expense.category_id,
  category.name AS category_name,
  expense.subcategory_id,
  subcategory.name AS subcategory_name,
  payment_method.id AS payment_method_id,
  payment_method.name AS payment_method_name,
  payment_method.nature AS payment_method_nature,
  expense.created_at,
  expense.updated_at`;

export class PostgresExpensesRepository implements ExpenseRepository {
  constructor(private readonly database: Database) {}

  async listExpenses(_userId: string, walletId: string, from?: string, to?: string): Promise<Expense[]> {
    const result = await this.database.query<ExpenseRow>(
      `SELECT ${resultColumns}
       FROM expenses AS expense
       JOIN categories AS category
         ON category.id = expense.category_id
        AND category.wallet_id = expense.wallet_id
        AND category.nature = 'expense'
       LEFT JOIN subcategories AS subcategory
         ON subcategory.id = expense.subcategory_id
        AND subcategory.wallet_id = expense.wallet_id
        AND subcategory.category_id = expense.category_id
       LEFT JOIN payment_methods AS payment_method
         ON payment_method.id = expense.payment_method_id
        AND payment_method.wallet_id = expense.wallet_id
       WHERE expense.wallet_id = $1
         AND ($2::date IS NULL OR expense.date >= $2::date)
         AND ($3::date IS NULL OR expense.date <= $3::date)
       ORDER BY expense.date DESC, expense.created_at DESC, expense.id DESC`,
      [walletId, from ?? null, to ?? null],
    );
    return result.rows.map(mapExpense);
  }

  async createExpense(userId: string, walletId: string, input: Required<ExpenseInput>): Promise<Expense | null> {
    const result = await this.database.query<ExpenseRow>(
      `WITH inserted AS (
         INSERT INTO expenses (user_id, wallet_id, category_id, subcategory_id, payment_method_id, amount, date, description)
         SELECT $1, $2, category.id, $4, $5::uuid, $6::numeric, $7::date, $8
         FROM categories AS category
         WHERE category.id = $3
           AND category.wallet_id = $2
           AND category.nature = 'expense'
           AND ($4::uuid IS NULL OR EXISTS (
             SELECT 1
             FROM subcategories AS subcategory
             WHERE subcategory.id = $4::uuid
               AND subcategory.wallet_id = $2
               AND subcategory.category_id = category.id
           ))
           AND ($5::uuid IS NULL OR EXISTS (
             SELECT 1 FROM payment_methods AS payment_method
             WHERE payment_method.id = $5::uuid
               AND payment_method.wallet_id = $2
               AND payment_method.is_active
           ))
         RETURNING *
       )
       SELECT ${resultColumns.replaceAll("expense.", "inserted.")}
       FROM inserted
       JOIN categories AS category
         ON category.id = inserted.category_id
        AND category.wallet_id = inserted.wallet_id
       LEFT JOIN subcategories AS subcategory
         ON subcategory.id = inserted.subcategory_id
        AND subcategory.wallet_id = inserted.wallet_id
        AND subcategory.category_id = inserted.category_id
       LEFT JOIN payment_methods AS payment_method
         ON payment_method.id = inserted.payment_method_id
        AND payment_method.wallet_id = inserted.wallet_id`,
      [userId, walletId, input.categoryId, input.subcategoryId, input.paymentMethodId, input.amount, input.date, input.description],
    );
    const row = result.rows[0];
    return row ? mapExpense(row) : null;
  }

  async updateExpense(
    _userId: string,
    walletId: string,
    expenseId: string,
    input: Required<ExpenseInput>,
  ): Promise<Expense | null> {
    const result = await this.database.query<ExpenseRow>(
      `WITH updated AS (
         UPDATE expenses AS expense
         SET category_id = category.id,
             subcategory_id = $4::uuid,
             payment_method_id = $5::uuid,
             amount = $6::numeric,
             date = $7::date,
             description = $8,
             updated_at = now()
         FROM categories AS category
         WHERE expense.id = $1
           AND expense.wallet_id = $2
           AND category.id = $3
           AND category.wallet_id = $2
           AND category.nature = 'expense'
           AND ($4::uuid IS NULL OR EXISTS (
             SELECT 1
             FROM subcategories AS subcategory
             WHERE subcategory.id = $4::uuid
               AND subcategory.wallet_id = $2
               AND subcategory.category_id = category.id
           ))
           AND ($5::uuid IS NULL OR EXISTS (
             SELECT 1 FROM payment_methods AS payment_method
             WHERE payment_method.id = $5::uuid
               AND payment_method.wallet_id = $2
               AND (payment_method.is_active OR payment_method.id = expense.payment_method_id)
           ))
         RETURNING expense.*
       )
       SELECT ${resultColumns.replaceAll("expense.", "updated.")}
       FROM updated
       JOIN categories AS category
         ON category.id = updated.category_id
        AND category.wallet_id = updated.wallet_id
       LEFT JOIN subcategories AS subcategory
         ON subcategory.id = updated.subcategory_id
        AND subcategory.wallet_id = updated.wallet_id
        AND subcategory.category_id = updated.category_id
       LEFT JOIN payment_methods AS payment_method
         ON payment_method.id = updated.payment_method_id
        AND payment_method.wallet_id = updated.wallet_id`,
      [expenseId, walletId, input.categoryId, input.subcategoryId, input.paymentMethodId, input.amount, input.date, input.description],
    );
    const row = result.rows[0];
    return row ? mapExpense(row) : null;
  }

  async deleteExpense(_userId: string, walletId: string, expenseId: string): Promise<boolean> {
    const result = await this.database.query(
      "DELETE FROM expenses WHERE id = $1 AND wallet_id = $2",
      [expenseId, walletId],
    );
    return result.rowCount === 1;
  }

  async hasExpense(_userId: string, walletId: string, expenseId: string): Promise<boolean> {
    const result = await this.database.query<{ exists: boolean }>(
      "SELECT EXISTS (SELECT 1 FROM expenses WHERE id = $1 AND wallet_id = $2) AS exists",
      [expenseId, walletId],
    );
    return result.rows[0]?.exists ?? false;
  }
}
