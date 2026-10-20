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
  expense.created_at,
  expense.updated_at`;

export class PostgresExpensesRepository implements ExpenseRepository {
  constructor(private readonly database: Database) {}

  async listExpenses(userId: string, from?: string, to?: string): Promise<Expense[]> {
    const result = await this.database.query<ExpenseRow>(
      `SELECT ${resultColumns}
       FROM expenses AS expense
       JOIN categories AS category
         ON category.id = expense.category_id
        AND category.user_id = expense.user_id
        AND category.nature = 'expense'
       LEFT JOIN subcategories AS subcategory
         ON subcategory.id = expense.subcategory_id
        AND subcategory.user_id = expense.user_id
        AND subcategory.category_id = expense.category_id
       WHERE expense.user_id = $1
         AND ($2::date IS NULL OR expense.date >= $2::date)
         AND ($3::date IS NULL OR expense.date <= $3::date)
       ORDER BY expense.date DESC, expense.created_at DESC, expense.id DESC`,
      [userId, from ?? null, to ?? null],
    );
    return result.rows.map(mapExpense);
  }

  async createExpense(userId: string, input: Required<ExpenseInput>): Promise<Expense | null> {
    const result = await this.database.query<ExpenseRow>(
      `WITH inserted AS (
         INSERT INTO expenses (user_id, category_id, subcategory_id, amount, date, description)
         SELECT $1, category.id, $3, $4::numeric, $5::date, $6
         FROM categories AS category
         WHERE category.id = $2
           AND category.user_id = $1
           AND category.nature = 'expense'
           AND ($3::uuid IS NULL OR EXISTS (
             SELECT 1
             FROM subcategories AS subcategory
             WHERE subcategory.id = $3::uuid
               AND subcategory.user_id = $1
               AND subcategory.category_id = category.id
           ))
         RETURNING *
       )
       SELECT ${resultColumns.replaceAll("expense.", "inserted.")}
       FROM inserted
       JOIN categories AS category
         ON category.id = inserted.category_id
        AND category.user_id = inserted.user_id
       LEFT JOIN subcategories AS subcategory
         ON subcategory.id = inserted.subcategory_id
        AND subcategory.user_id = inserted.user_id
        AND subcategory.category_id = inserted.category_id`,
      [userId, input.categoryId, input.subcategoryId, input.amount, input.date, input.description],
    );
    const row = result.rows[0];
    return row ? mapExpense(row) : null;
  }

  async updateExpense(
    userId: string,
    expenseId: string,
    input: Required<ExpenseInput>,
  ): Promise<Expense | null> {
    const result = await this.database.query<ExpenseRow>(
      `WITH updated AS (
         UPDATE expenses AS expense
         SET category_id = category.id,
             subcategory_id = $4::uuid,
             amount = $5::numeric,
             date = $6::date,
             description = $7,
             updated_at = now()
         FROM categories AS category
         WHERE expense.id = $1
           AND expense.user_id = $2
           AND category.id = $3
           AND category.user_id = $2
           AND category.nature = 'expense'
           AND ($4::uuid IS NULL OR EXISTS (
             SELECT 1
             FROM subcategories AS subcategory
             WHERE subcategory.id = $4::uuid
               AND subcategory.user_id = $2
               AND subcategory.category_id = category.id
           ))
         RETURNING expense.*
       )
       SELECT ${resultColumns.replaceAll("expense.", "updated.")}
       FROM updated
       JOIN categories AS category
         ON category.id = updated.category_id
        AND category.user_id = updated.user_id
       LEFT JOIN subcategories AS subcategory
         ON subcategory.id = updated.subcategory_id
        AND subcategory.user_id = updated.user_id
        AND subcategory.category_id = updated.category_id`,
      [expenseId, userId, input.categoryId, input.subcategoryId, input.amount, input.date, input.description],
    );
    const row = result.rows[0];
    return row ? mapExpense(row) : null;
  }

  async deleteExpense(userId: string, expenseId: string): Promise<boolean> {
    const result = await this.database.query(
      "DELETE FROM expenses WHERE id = $1 AND user_id = $2",
      [expenseId, userId],
    );
    return result.rowCount === 1;
  }

  async hasExpense(userId: string, expenseId: string): Promise<boolean> {
    const result = await this.database.query<{ exists: boolean }>(
      "SELECT EXISTS (SELECT 1 FROM expenses WHERE id = $1 AND user_id = $2) AS exists",
      [expenseId, userId],
    );
    return result.rows[0]?.exists ?? false;
  }
}
