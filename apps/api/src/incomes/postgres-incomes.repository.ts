import type { Database } from "../database.js";
import type { Income, IncomeInput, IncomeRepository } from "./incomes.types.js";

interface IncomeRow {
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

function mapIncome(row: IncomeRow): Income {
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
  income.id,
  income.amount::text AS amount,
  income.date,
  income.description,
  income.category_id,
  category.name AS category_name,
  income.subcategory_id,
  subcategory.name AS subcategory_name,
  income.created_at,
  income.updated_at`;

export class PostgresIncomesRepository implements IncomeRepository {
  constructor(private readonly database: Database) {}

  async listIncomes(userId: string, from?: string, to?: string): Promise<Income[]> {
    const result = await this.database.query<IncomeRow>(
      `SELECT ${resultColumns}
       FROM incomes AS income
       JOIN categories AS category
         ON category.id = income.category_id
        AND category.user_id = income.user_id
        AND category.nature = 'income'
       LEFT JOIN subcategories AS subcategory
         ON subcategory.id = income.subcategory_id
        AND subcategory.user_id = income.user_id
        AND subcategory.category_id = income.category_id
       WHERE income.user_id = $1
         AND ($2::date IS NULL OR income.date >= $2::date)
         AND ($3::date IS NULL OR income.date <= $3::date)
       ORDER BY income.date DESC, income.created_at DESC, income.id DESC`,
      [userId, from ?? null, to ?? null],
    );
    return result.rows.map(mapIncome);
  }

  async createIncome(userId: string, input: Required<IncomeInput>): Promise<Income | null> {
    const result = await this.database.query<IncomeRow>(
      `WITH inserted AS (
         INSERT INTO incomes (user_id, category_id, subcategory_id, amount, date, description)
         SELECT $1, category.id, $3, $4::numeric, $5::date, $6
         FROM categories AS category
         WHERE category.id = $2
           AND category.user_id = $1
           AND category.nature = 'income'
           AND ($3::uuid IS NULL OR EXISTS (
             SELECT 1
             FROM subcategories AS subcategory
             WHERE subcategory.id = $3::uuid
               AND subcategory.user_id = $1
               AND subcategory.category_id = category.id
           ))
         RETURNING *
       )
       SELECT ${resultColumns.replaceAll("income.", "inserted.")}
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
    return row ? mapIncome(row) : null;
  }

  async updateIncome(
    userId: string,
    incomeId: string,
    input: Required<IncomeInput>,
  ): Promise<Income | null> {
    const result = await this.database.query<IncomeRow>(
      `WITH updated AS (
         UPDATE incomes AS income
         SET category_id = category.id,
             subcategory_id = $4::uuid,
             amount = $5::numeric,
             date = $6::date,
             description = $7,
             updated_at = now()
         FROM categories AS category
         WHERE income.id = $1
           AND income.user_id = $2
           AND category.id = $3
           AND category.user_id = $2
           AND category.nature = 'income'
           AND ($4::uuid IS NULL OR EXISTS (
             SELECT 1
             FROM subcategories AS subcategory
             WHERE subcategory.id = $4::uuid
               AND subcategory.user_id = $2
               AND subcategory.category_id = category.id
           ))
         RETURNING income.*
       )
       SELECT ${resultColumns.replaceAll("income.", "updated.")}
       FROM updated
       JOIN categories AS category
         ON category.id = updated.category_id
        AND category.user_id = updated.user_id
       LEFT JOIN subcategories AS subcategory
         ON subcategory.id = updated.subcategory_id
        AND subcategory.user_id = updated.user_id
        AND subcategory.category_id = updated.category_id`,
      [incomeId, userId, input.categoryId, input.subcategoryId, input.amount, input.date, input.description],
    );
    const row = result.rows[0];
    return row ? mapIncome(row) : null;
  }

  async deleteIncome(userId: string, incomeId: string): Promise<boolean> {
    const result = await this.database.query(
      "DELETE FROM incomes WHERE id = $1 AND user_id = $2",
      [incomeId, userId],
    );
    return result.rowCount === 1;
  }

  async hasIncome(userId: string, incomeId: string): Promise<boolean> {
    const result = await this.database.query<{ exists: boolean }>(
      "SELECT EXISTS (SELECT 1 FROM incomes WHERE id = $1 AND user_id = $2) AS exists",
      [incomeId, userId],
    );
    return result.rows[0]?.exists ?? false;
  }
}
