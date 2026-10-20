import { FinancialSummaryError } from "./financial-summary.errors.js";
import type { FinancialSummary, FinancialSummaryRepository } from "./financial-summary.types.js";

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function validateDate(value: string, label: string): void {
  if (!DATE_PATTERN.test(value)) throw new FinancialSummaryError(`${label} deve estar no formato AAAA-MM-DD.`, 400);
  const date = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new FinancialSummaryError(`${label} deve ser uma data válida.`, 400);
  }
}

export class FinancialSummaryService {
  constructor(private readonly repository: FinancialSummaryRepository) {}

  getSummary(userId: string, from?: string, to?: string): Promise<FinancialSummary> {
    if (from) validateDate(from, "O filtro from");
    if (to) validateDate(to, "O filtro to");
    if (from && to && from > to) {
      throw new FinancialSummaryError("O filtro from deve ser anterior ou igual ao filtro to.", 400);
    }
    return this.repository.getSummary(userId, from, to);
  }
}
