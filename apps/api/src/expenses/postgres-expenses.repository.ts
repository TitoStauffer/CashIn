import type { Database } from "../database.js";
import { ExpenseError, InvalidExpenseReferenceError } from "./expenses.errors.js";
import { calculateBillingCycle } from "../credit-cards/billing-cycle.js";
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
  credit_card_id: string | null;
  credit_card_statement_id: string | null;
  credit_card_name: string | null;
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
    creditCardId: row.credit_card_id,
    creditCardStatementId: row.credit_card_statement_id,
    creditCardName: row.credit_card_name,
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
  expense.payment_method_nature,
  statement.credit_card_id,
  expense.credit_card_statement_id,
  card.alias AS credit_card_name,
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
       LEFT JOIN credit_card_statements AS statement
         ON statement.id = expense.credit_card_statement_id
        AND statement.wallet_id = expense.wallet_id
       LEFT JOIN credit_cards AS card
         ON card.id = statement.credit_card_id
        AND card.wallet_id = statement.wallet_id
       WHERE expense.wallet_id = $1
         AND ($2::date IS NULL OR expense.date >= $2::date)
         AND ($3::date IS NULL OR expense.date <= $3::date)
       ORDER BY expense.date DESC, expense.created_at DESC, expense.id DESC`,
      [walletId, from ?? null, to ?? null],
    );
    return result.rows.map(mapExpense);
  }

  async createExpense(userId: string, walletId: string, input: Required<ExpenseInput>): Promise<Expense | null> {
    return this.database.transaction(async (transaction) => {
      if (!(await this.hasValidCategory(transaction, walletId, input))) return null;
      const statementId = await this.resolveStatement(transaction, walletId, input);
      const result = await transaction.query<ExpenseRow>(
      `WITH inserted AS (
         INSERT INTO expenses (user_id, wallet_id, category_id, subcategory_id, payment_method_id, payment_method_nature, credit_card_statement_id, amount, date, description)
         SELECT $1, $2, category.id, $4, method.id, method.nature, $9::uuid, $6::numeric, $7::date, $8
         FROM categories AS category
         LEFT JOIN payment_methods AS method
           ON method.id = $5::uuid
          AND method.wallet_id = $2
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
        AND payment_method.wallet_id = inserted.wallet_id
       LEFT JOIN credit_card_statements AS statement
         ON statement.id = inserted.credit_card_statement_id
        AND statement.wallet_id = inserted.wallet_id
       LEFT JOIN credit_cards AS card
         ON card.id = statement.credit_card_id
        AND card.wallet_id = statement.wallet_id`,
       [userId, walletId, input.categoryId, input.subcategoryId, input.paymentMethodId, input.amount, input.date, input.description, statementId],
      );
      const row = result.rows[0];
      return row ? mapExpense(row) : null;
    });
  }

  async updateExpense(
    _userId: string,
    walletId: string,
    expenseId: string,
    input: Required<ExpenseInput>,
  ): Promise<Expense | null> {
    return this.database.transaction(async (transaction) => {
      const existing = await transaction.query<{ credit_card_statement_id: string | null; credit_card_id: string | null; payment_method_id: string | null }>(
        `SELECT expense.credit_card_statement_id, statement.credit_card_id, expense.payment_method_id
         FROM expenses AS expense
         LEFT JOIN credit_card_statements AS statement
           ON statement.id = expense.credit_card_statement_id AND statement.wallet_id = expense.wallet_id
         WHERE expense.id = $1 AND expense.wallet_id = $2
         FOR UPDATE OF expense`,
        [expenseId, walletId],
      );
      const current = existing.rows[0];
      if (!current) return null;
      if (!(await this.hasValidCategory(transaction, walletId, input))) return null;
      if (current.credit_card_statement_id) {
        const statement = await transaction.query<{ paid_date: string | null }>(
          "SELECT paid_date FROM credit_card_statements WHERE id = $1 AND wallet_id = $2 FOR UPDATE",
          [current.credit_card_statement_id, walletId],
        );
        if (statement.rows[0]?.paid_date !== null && statement.rows[0]?.paid_date !== undefined) {
          throw new ExpenseError("Não é possível alterar uma compra de fatura já paga.", 409);
        }
      }
      const statementId = await this.resolveStatement(transaction, walletId, input, current.credit_card_id, current.payment_method_id);
      const result = await transaction.query<ExpenseRow>(
      `WITH updated AS (
         UPDATE expenses AS expense
         SET category_id = category.id,
             subcategory_id = $4::uuid,
             payment_method_id = $5::uuid,
             payment_method_nature = (
               SELECT payment_method.nature
               FROM payment_methods AS payment_method
               WHERE payment_method.id = $5::uuid
                 AND payment_method.wallet_id = $2
             ),
             credit_card_statement_id = $9::uuid,
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
        AND payment_method.wallet_id = updated.wallet_id
       LEFT JOIN credit_card_statements AS statement
         ON statement.id = updated.credit_card_statement_id
        AND statement.wallet_id = updated.wallet_id
       LEFT JOIN credit_cards AS card
         ON card.id = statement.credit_card_id
        AND card.wallet_id = statement.wallet_id`,
      [expenseId, walletId, input.categoryId, input.subcategoryId, input.paymentMethodId, input.amount, input.date, input.description, statementId],
      );
      const row = result.rows[0];
      if (current.credit_card_statement_id && current.credit_card_statement_id !== statementId) {
        await this.removeEmptyStatement(transaction, walletId, current.credit_card_statement_id);
      }
      return row ? mapExpense(row) : null;
    });
  }

  async deleteExpense(_userId: string, walletId: string, expenseId: string): Promise<boolean> {
    return this.database.transaction(async (transaction) => {
      const existing = await transaction.query<{ credit_card_statement_id: string | null }>(
        `SELECT expense.credit_card_statement_id
         FROM expenses AS expense
         WHERE expense.id = $1 AND expense.wallet_id = $2
         FOR UPDATE OF expense`,
        [expenseId, walletId],
      );
      const current = existing.rows[0];
      if (!current) return false;
      if (current.credit_card_statement_id) {
        const statement = await transaction.query<{ paid_date: string | null }>(
          "SELECT paid_date FROM credit_card_statements WHERE id = $1 AND wallet_id = $2 FOR UPDATE",
          [current.credit_card_statement_id, walletId],
        );
        if (statement.rows[0]?.paid_date !== null && statement.rows[0]?.paid_date !== undefined) {
          throw new ExpenseError("Não é possível excluir uma compra de fatura já paga.", 409);
        }
      }
      await transaction.query("DELETE FROM expenses WHERE id = $1 AND wallet_id = $2", [expenseId, walletId]);
      if (current.credit_card_statement_id) {
        await this.removeEmptyStatement(transaction, walletId, current.credit_card_statement_id);
      }
      return true;
    });
  }

  async hasExpense(_userId: string, walletId: string, expenseId: string): Promise<boolean> {
    const result = await this.database.query<{ exists: boolean }>(
      "SELECT EXISTS (SELECT 1 FROM expenses WHERE id = $1 AND wallet_id = $2) AS exists",
      [expenseId, walletId],
    );
    return result.rows[0]?.exists ?? false;
  }

  private async resolveStatement(
    transaction: import("../database.js").QueryExecutor,
    walletId: string,
    input: Required<ExpenseInput>,
    previouslySelectedCardId: string | null = null,
    previouslySelectedMethodId: string | null = null,
  ): Promise<string | null> {
    const method = input.paymentMethodId
      ? await transaction.query<{ nature: string; is_active: boolean }>(
          "SELECT nature, is_active FROM payment_methods WHERE id = $1 AND wallet_id = $2 AND (is_active OR id = $3)",
          [input.paymentMethodId, walletId, previouslySelectedMethodId],
        )
      : null;
    const paymentMethod = method?.rows[0] ?? null;
    if (input.paymentMethodId && !paymentMethod) throw new InvalidExpenseReferenceError();

    if (paymentMethod?.nature !== "credit_card") {
      if (input.creditCardId !== null) throw new ExpenseError("Selecione um cartão somente para despesas no crédito.", 400);
      return null;
    }
    if (!input.creditCardId) throw new ExpenseError("Selecione o cartão de crédito da compra.", 400);

    const cardResult = await transaction.query<{ id: string; closing_day: number; due_day: number }>(
      `SELECT id, closing_day, due_day
       FROM credit_cards
       WHERE id = $1 AND wallet_id = $2 AND (is_active OR id = $3)`,
      [input.creditCardId, walletId, previouslySelectedCardId],
    );
    const card = cardResult.rows[0];
    if (!card) throw new InvalidExpenseReferenceError();

    const cycle = calculateBillingCycle(input.date, card.closing_day, card.due_day);
    await transaction.query(
      `INSERT INTO credit_card_statements (wallet_id, credit_card_id, closing_date, due_date)
       VALUES ($1, $2, $3::date, $4::date)
       ON CONFLICT (credit_card_id, closing_date) DO NOTHING`,
      [walletId, card.id, cycle.closingDate, cycle.dueDate],
    );
    const statementResult = await transaction.query<{ id: string; paid_date: string | null }>(
      `SELECT id, paid_date
       FROM credit_card_statements
       WHERE wallet_id = $1 AND credit_card_id = $2 AND closing_date = $3::date
       FOR UPDATE`,
      [walletId, card.id, cycle.closingDate],
    );
    const statement = statementResult.rows[0];
    if (!statement) throw new InvalidExpenseReferenceError();
    if (statement.paid_date !== null) throw new ExpenseError("Não é possível incluir compras em uma fatura já paga.", 409);
    return statement.id;
  }

  private async hasValidCategory(
    transaction: import("../database.js").QueryExecutor,
    walletId: string,
    input: Required<ExpenseInput>,
  ): Promise<boolean> {
    const result = await transaction.query<{ valid: boolean }>(
      `SELECT EXISTS (
         SELECT 1
         FROM categories AS category
         WHERE category.id = $1 AND category.wallet_id = $2 AND category.nature = 'expense'
           AND ($3::uuid IS NULL OR EXISTS (
             SELECT 1 FROM subcategories AS subcategory
             WHERE subcategory.id = $3 AND subcategory.wallet_id = $2 AND subcategory.category_id = category.id
           ))
       ) AS valid`,
      [input.categoryId, walletId, input.subcategoryId],
    );
    return result.rows[0]?.valid ?? false;
  }

  private async removeEmptyStatement(
    transaction: import("../database.js").QueryExecutor,
    walletId: string,
    statementId: string,
  ): Promise<void> {
    await transaction.query(
      `DELETE FROM credit_card_statements AS statement
       WHERE statement.id = $1 AND statement.wallet_id = $2
         AND statement.paid_date IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM expenses
           WHERE credit_card_statement_id = statement.id AND wallet_id = statement.wallet_id
         )`,
      [statementId, walletId],
    );
  }
}
