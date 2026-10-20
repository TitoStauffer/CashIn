import { ClosedInvestmentGoalError, InvestmentGoalError, InvalidInvestmentGoalReferenceError } from "./investment-goals.errors.js";
import type {
  InvestmentContribution,
  InvestmentContributionInput,
  InvestmentGoal,
  InvestmentGoalInput,
  InvestmentGoalsRepository,
} from "./investment-goals.types.js";

const AMOUNT_PATTERN = /^(?:0|[1-9]\d{0,11})(?:\.\d{1,2})?$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_TITLE_LENGTH = 120;
const MAX_DESCRIPTION_LENGTH = 1000;

function validateDate(value: string, label: string): void {
  if (!DATE_PATTERN.test(value)) throw new InvestmentGoalError(`${label} deve estar no formato AAAA-MM-DD.`, 400);
  const date = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new InvestmentGoalError(`${label} deve ser uma data válida.`, 400);
  }
}

function normalizeAmount(value: string, label: string): string {
  if (!AMOUNT_PATTERN.test(value) || Number(value) <= 0) {
    throw new InvestmentGoalError(`${label} deve ser positivo e ter no máximo duas casas decimais.`, 400);
  }
  return value;
}

function normalizeGoal(input: InvestmentGoalInput): Required<InvestmentGoalInput> {
  const title = input.title.trim();
  const description = input.description.trim();
  if (!title || title.length > MAX_TITLE_LENGTH) {
    throw new InvestmentGoalError(`O título é obrigatório e deve ter até ${MAX_TITLE_LENGTH} caracteres.`, 400);
  }
  if (!description || description.length > MAX_DESCRIPTION_LENGTH) {
    throw new InvestmentGoalError(`A descrição é obrigatória e deve ter até ${MAX_DESCRIPTION_LENGTH} caracteres.`, 400);
  }
  const targetAmount = normalizeAmount(input.targetAmount, "O valor-alvo");
  const dueDate = input.dueDate ?? null;
  if (dueDate !== null) validateDate(dueDate, "A data limite");
  const categoryId = input.categoryId ?? null;
  const subcategoryId = input.subcategoryId ?? null;
  if (categoryId !== null && !UUID_PATTERN.test(categoryId)) {
    throw new InvestmentGoalError("A categoria informada é inválida.", 400);
  }
  if (subcategoryId !== null && !UUID_PATTERN.test(subcategoryId)) {
    throw new InvestmentGoalError("A subcategoria informada é inválida.", 400);
  }
  if (subcategoryId !== null && categoryId === null) {
    throw new InvestmentGoalError("Informe uma categoria para selecionar uma subcategoria.", 400);
  }
  return { title, description, targetAmount, dueDate, categoryId, subcategoryId };
}

function normalizeContribution(input: InvestmentContributionInput): Required<InvestmentContributionInput> {
  const amount = normalizeAmount(input.amount, "O valor do aporte");
  validateDate(input.date, "A data do aporte");
  const description = input.description?.trim() || null;
  if (description && description.length > MAX_DESCRIPTION_LENGTH) {
    throw new InvestmentGoalError(`A descrição deve ter até ${MAX_DESCRIPTION_LENGTH} caracteres.`, 400);
  }
  return { amount, date: input.date, description };
}

function mapReferenceError(error: unknown): never {
  if (error instanceof InvestmentGoalError) throw error;
  if (typeof error === "object" && error !== null && "code" in error && error.code === "23503") {
    throw new InvalidInvestmentGoalReferenceError();
  }
  throw error;
}

export class InvestmentGoalsService {
  constructor(private readonly repository: InvestmentGoalsRepository) {}

  listGoals(userId: string): Promise<InvestmentGoal[]> {
    return this.repository.listGoals(userId);
  }

  async getGoal(userId: string, goalId: string): Promise<InvestmentGoal> {
    if (!UUID_PATTERN.test(goalId)) throw new InvestmentGoalError("Meta de investimento não encontrada.", 404);
    const goal = await this.repository.getGoal(userId, goalId);
    if (!goal) throw new InvestmentGoalError("Meta de investimento não encontrada.", 404);
    return goal;
  }

  async createGoal(userId: string, input: InvestmentGoalInput): Promise<InvestmentGoal> {
    try {
      const goal = await this.repository.createGoal(userId, normalizeGoal(input));
      if (!goal) throw new InvalidInvestmentGoalReferenceError();
      return goal;
    } catch (error) {
      return mapReferenceError(error);
    }
  }

  async updateGoal(userId: string, goalId: string, input: InvestmentGoalInput): Promise<InvestmentGoal> {
    if (!UUID_PATTERN.test(goalId)) throw new InvestmentGoalError("Meta de investimento não encontrada.", 404);
    try {
      const goal = await this.repository.updateGoal(userId, goalId, normalizeGoal(input));
      if (!goal) {
        if (await this.repository.hasGoal(userId, goalId)) throw new InvalidInvestmentGoalReferenceError();
        throw new InvestmentGoalError("Meta de investimento não encontrada.", 404);
      }
      return goal;
    } catch (error) {
      return mapReferenceError(error);
    }
  }

  async closeGoal(userId: string, goalId: string): Promise<InvestmentGoal> {
    if (!UUID_PATTERN.test(goalId)) throw new InvestmentGoalError("Meta de investimento não encontrada.", 404);
    const goal = await this.repository.closeGoal(userId, goalId);
    if (!goal) throw new InvestmentGoalError("Meta de investimento não encontrada.", 404);
    return goal;
  }

  async listContributions(userId: string, goalId: string): Promise<InvestmentContribution[]> {
    await this.requireGoal(userId, goalId);
    return this.repository.listContributions(userId, goalId);
  }

  async createContribution(
    userId: string,
    goalId: string,
    input: InvestmentContributionInput,
  ): Promise<InvestmentContribution> {
    await this.requireGoal(userId, goalId);
    try {
      const contribution = await this.repository.createContribution(userId, goalId, normalizeContribution(input));
      if (!contribution) {
        if (!(await this.repository.hasGoal(userId, goalId))) throw new InvestmentGoalError("Meta de investimento não encontrada.", 404);
        throw new ClosedInvestmentGoalError();
      }
      return contribution;
    } catch (error) {
      return mapReferenceError(error);
    }
  }

  async updateContribution(
    userId: string,
    goalId: string,
    contributionId: string,
    input: InvestmentContributionInput,
  ): Promise<InvestmentContribution> {
    await this.requireGoal(userId, goalId);
    if (!UUID_PATTERN.test(contributionId)) throw new InvestmentGoalError("Aporte não encontrado.", 404);
    const contribution = await this.repository.updateContribution(
      userId,
      goalId,
      contributionId,
      normalizeContribution(input),
    );
    if (!contribution) throw new InvestmentGoalError("Aporte não encontrado.", 404);
    return contribution;
  }

  async deleteContribution(userId: string, goalId: string, contributionId: string): Promise<void> {
    await this.requireGoal(userId, goalId);
    if (!UUID_PATTERN.test(contributionId)) throw new InvestmentGoalError("Aporte não encontrado.", 404);
    const deleted = await this.repository.deleteContribution(userId, goalId, contributionId);
    if (!deleted) throw new InvestmentGoalError("Aporte não encontrado.", 404);
  }

  private async requireGoal(userId: string, goalId: string): Promise<void> {
    if (!UUID_PATTERN.test(goalId) || !(await this.repository.hasGoal(userId, goalId))) {
      throw new InvestmentGoalError("Meta de investimento não encontrada.", 404);
    }
  }
}
