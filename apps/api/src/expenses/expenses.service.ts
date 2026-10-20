import { ExpenseError, InvalidExpenseReferenceError } from "./expenses.errors.js";
import type { Expense, ExpenseInput, ExpenseRepository } from "./expenses.types.js";

const AMOUNT_PATTERN = /^(?:0|[1-9]\d{0,11})(?:\.\d{1,2})?$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function validateDate(value: string, field: string): void {
  if (!DATE_PATTERN.test(value)) {
    throw new ExpenseError(`${field} deve estar no formato AAAA-MM-DD.`, 400);
  }
  const date = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new ExpenseError(`${field} deve ser uma data válida.`, 400);
  }
}

function normalizeInput(input: ExpenseInput): Required<ExpenseInput> {
  if (!AMOUNT_PATTERN.test(input.amount) || Number(input.amount) <= 0) {
    throw new ExpenseError("O valor deve ser positivo e ter no máximo duas casas decimais.", 400);
  }
  validateDate(input.date, "A data");
  if (!UUID_PATTERN.test(input.categoryId)) {
    throw new ExpenseError("A categoria informada é inválida.", 400);
  }
  const subcategoryId = input.subcategoryId ?? null;
  if (subcategoryId !== null && !UUID_PATTERN.test(subcategoryId)) {
    throw new ExpenseError("A subcategoria informada é inválida.", 400);
  }
  const description = input.description?.trim() || null;
  return { ...input, amount: input.amount, description, subcategoryId };
}

function mapReferenceError(error: unknown): never {
  if (error instanceof ExpenseError) throw error;
  if (typeof error === "object" && error !== null && "code" in error && error.code === "23503") {
    throw new InvalidExpenseReferenceError();
  }
  throw error;
}

export class ExpensesService {
  constructor(private readonly repository: ExpenseRepository) {}

  listExpenses(userId: string, from?: string, to?: string): Promise<Expense[]> {
    if (from) validateDate(from, "O filtro from");
    if (to) validateDate(to, "O filtro to");
    if (from && to && from > to) {
      throw new ExpenseError("O filtro from deve ser anterior ou igual ao filtro to.", 400);
    }
    return this.repository.listExpenses(userId, from, to);
  }

  async createExpense(userId: string, input: ExpenseInput): Promise<Expense> {
    try {
      const expense = await this.repository.createExpense(userId, normalizeInput(input));
      if (!expense) throw new InvalidExpenseReferenceError();
      return expense;
    } catch (error) {
      return mapReferenceError(error);
    }
  }

  async updateExpense(userId: string, expenseId: string, input: ExpenseInput): Promise<Expense> {
    if (!UUID_PATTERN.test(expenseId)) throw new ExpenseError("Lançamento não encontrado.", 404);
    try {
      const expense = await this.repository.updateExpense(userId, expenseId, normalizeInput(input));
      if (!expense) {
        if (await this.repository.hasExpense(userId, expenseId)) throw new InvalidExpenseReferenceError();
        throw new ExpenseError("Lançamento não encontrado.", 404);
      }
      return expense;
    } catch (error) {
      return mapReferenceError(error);
    }
  }

  async deleteExpense(userId: string, expenseId: string): Promise<void> {
    if (!UUID_PATTERN.test(expenseId)) throw new ExpenseError("Lançamento não encontrado.", 404);
    const deleted = await this.repository.deleteExpense(userId, expenseId);
    if (!deleted) throw new ExpenseError("Lançamento não encontrado.", 404);
  }
}
