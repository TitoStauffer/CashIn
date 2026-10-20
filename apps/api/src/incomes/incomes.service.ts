import { IncomeError, InvalidIncomeReferenceError } from "./incomes.errors.js";
import { INCOME_BALANCE_TYPES, type Income, type IncomeInput, type IncomeRepository } from "./incomes.types.js";
import { isPositiveMoneyAmount } from "../shared/money.js";

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function validateDate(value: string, field: string): void {
  if (!DATE_PATTERN.test(value)) {
    throw new IncomeError(`${field} deve estar no formato AAAA-MM-DD.`, 400);
  }
  const date = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new IncomeError(`${field} deve ser uma data válida.`, 400);
  }
}

function normalizeInput(input: IncomeInput): Required<IncomeInput> {
  if (!isPositiveMoneyAmount(input.amount)) {
    throw new IncomeError("O valor deve ser positivo e ter no máximo duas casas decimais.", 400);
  }
  validateDate(input.date, "A data");
  if (!UUID_PATTERN.test(input.categoryId)) {
    throw new IncomeError("A categoria informada é inválida.", 400);
  }
  const subcategoryId = input.subcategoryId ?? null;
  if (subcategoryId !== null && !UUID_PATTERN.test(subcategoryId)) {
    throw new IncomeError("A subcategoria informada é inválida.", 400);
  }
  const description = input.description?.trim() || null;
  const balanceType = input.balanceType ?? "cash";
  if (!INCOME_BALANCE_TYPES.includes(balanceType)) {
    throw new IncomeError("O destino da entrada informado é inválido.", 400);
  }
  return { ...input, amount: input.amount, description, subcategoryId, balanceType };
}

function mapReferenceError(error: unknown): never {
  if (error instanceof IncomeError) throw error;
  if (typeof error === "object" && error !== null && "code" in error && error.code === "23503") {
    throw new InvalidIncomeReferenceError();
  }
  throw error;
}

export class IncomesService {
  constructor(private readonly repository: IncomeRepository) {}

  listIncomes(userId: string, walletId: string, from?: string, to?: string): Promise<Income[]> {
    if (from) validateDate(from, "O filtro from");
    if (to) validateDate(to, "O filtro to");
    if (from && to && from > to) {
      throw new IncomeError("O filtro from deve ser anterior ou igual ao filtro to.", 400);
    }
    return this.repository.listIncomes(userId, walletId, from, to);
  }

  async createIncome(userId: string, walletId: string, input: IncomeInput): Promise<Income> {
    try {
      const income = await this.repository.createIncome(userId, walletId, normalizeInput(input));
      if (!income) throw new InvalidIncomeReferenceError();
      return income;
    } catch (error) {
      return mapReferenceError(error);
    }
  }

  async updateIncome(userId: string, walletId: string, incomeId: string, input: IncomeInput): Promise<Income> {
    if (!UUID_PATTERN.test(incomeId)) throw new IncomeError("Lançamento não encontrado.", 404);
    try {
      const income = await this.repository.updateIncome(userId, walletId, incomeId, normalizeInput(input));
      if (!income) {
        if (await this.repository.hasIncome(userId, walletId, incomeId)) throw new InvalidIncomeReferenceError();
        throw new IncomeError("Lançamento não encontrado.", 404);
      }
      return income;
    } catch (error) {
      return mapReferenceError(error);
    }
  }

  async deleteIncome(userId: string, walletId: string, incomeId: string): Promise<void> {
    if (!UUID_PATTERN.test(incomeId)) throw new IncomeError("Lançamento não encontrado.", 404);
    const deleted = await this.repository.deleteIncome(userId, walletId, incomeId);
    if (!deleted) throw new IncomeError("Lançamento não encontrado.", 404);
  }
}
