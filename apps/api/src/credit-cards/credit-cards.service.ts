import { CreditCardError } from "./credit-cards.errors.js";
import type { CreditCard, CreditCardRepository, CreditCardStatement } from "./credit-cards.types.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MAX_NICKNAME_LENGTH = 100;

function normalizeNickname(value: string): string {
  const nickname = value.trim();
  if (!nickname) throw new CreditCardError("Informe o apelido do cartão.", 400);
  if (nickname.length > MAX_NICKNAME_LENGTH) throw new CreditCardError(`O apelido deve ter no máximo ${MAX_NICKNAME_LENGTH} caracteres.`, 400);
  return nickname;
}

function validateDay(value: number, field: string): void {
  if (!Number.isInteger(value) || value < 1 || value > 31) {
    throw new CreditCardError(`${field} deve ser um dia entre 1 e 31.`, 400);
  }
}

function validateDate(value: string, field: string): void {
  if (!DATE_PATTERN.test(value)) throw new CreditCardError(`${field} deve estar no formato AAAA-MM-DD.`, 400);
  const date = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new CreditCardError(`${field} deve ser uma data válida.`, 400);
  }
}

function mapRepositoryError(error: unknown): never {
  if (error instanceof CreditCardError) throw error;
  if (typeof error === "object" && error !== null && "code" in error && error.code === "23503") {
    throw new CreditCardError("Cartão ou fatura não encontrado nesta carteira.", 404);
  }
  throw error;
}

export class CreditCardsService {
  constructor(private readonly repository: CreditCardRepository) {}

  list(walletId: string): Promise<CreditCard[]> {
    return this.repository.list(walletId);
  }

  async create(walletId: string, input: { nickname: string; closingDay: number; dueDay: number }): Promise<CreditCard> {
    const nickname = normalizeNickname(input.nickname);
    validateDay(input.closingDay, "O dia de fechamento");
    validateDay(input.dueDay, "O dia de vencimento");
    return this.repository.create(walletId, { ...input, nickname });
  }

  async update(
    walletId: string,
    creditCardId: string,
    changes: { nickname?: string; closingDay?: number; dueDay?: number; isActive?: boolean },
  ): Promise<CreditCard> {
    if (!UUID_PATTERN.test(creditCardId)) throw new CreditCardError("Cartão não encontrado.", 404);
    if (Object.keys(changes).length === 0) throw new CreditCardError("Informe ao menos uma alteração.", 400);
    if (changes.nickname !== undefined) changes.nickname = normalizeNickname(changes.nickname);
    if (changes.closingDay !== undefined) validateDay(changes.closingDay, "O dia de fechamento");
    if (changes.dueDay !== undefined) validateDay(changes.dueDay, "O dia de vencimento");
    const card = await this.repository.update(walletId, creditCardId, changes);
    if (!card) throw new CreditCardError("Cartão não encontrado.", 404);
    return card;
  }

  async listStatements(walletId: string, creditCardId: string, from?: string, to?: string): Promise<CreditCardStatement[]> {
    if (!UUID_PATTERN.test(creditCardId)) throw new CreditCardError("Cartão não encontrado.", 404);
    if (from) validateDate(from, "O filtro from");
    if (to) validateDate(to, "O filtro to");
    if (from && to && from > to) throw new CreditCardError("O filtro from deve ser anterior ou igual ao filtro to.", 400);
    const statements = await this.repository.listStatements(walletId, creditCardId, from, to);
    if (!statements) throw new CreditCardError("Cartão não encontrado.", 404);
    return statements;
  }

  async payStatement(walletId: string, creditCardId: string, statementId: string, date: string): Promise<CreditCardStatement> {
    if (!UUID_PATTERN.test(creditCardId) || !UUID_PATTERN.test(statementId)) {
      throw new CreditCardError("Fatura não encontrada.", 404);
    }
    validateDate(date, "A data de pagamento");
    try {
      const statement = await this.repository.payStatement(walletId, creditCardId, statementId, date);
      if (!statement) throw new CreditCardError("Fatura não encontrada.", 404);
      return statement;
    } catch (error) {
      return mapRepositoryError(error);
    }
  }
}
