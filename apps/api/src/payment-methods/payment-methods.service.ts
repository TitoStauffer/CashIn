import { PaymentMethodConflictError, PaymentMethodError } from "./payment-methods.errors.js";
import type { PaymentMethod, PaymentMethodNature, PaymentMethodRepository } from "./payment-methods.types.js";

const MAX_NAME_LENGTH = 100;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function normalizeName(name: string): string {
  const value = name.trim();
  if (!value) throw new PaymentMethodError("O nome é obrigatório.", 400);
  if (value.length > MAX_NAME_LENGTH) throw new PaymentMethodError(`O nome deve ter no máximo ${MAX_NAME_LENGTH} caracteres.`, 400);
  return value;
}

function mapRepositoryError(error: unknown): never {
  if (error instanceof PaymentMethodError) throw error;
  if (typeof error === "object" && error !== null && "code" in error) {
    if (error.code === "23505") throw new PaymentMethodConflictError("Já existe uma forma de pagamento com esse nome nesta carteira.");
    if (error.code === "23503") throw new PaymentMethodConflictError("A forma de pagamento possui despesas vinculadas e não pode ser removida.");
  }
  throw error;
}

export class PaymentMethodsService {
  constructor(private readonly repository: PaymentMethodRepository) {}

  list(userId: string, walletId: string): Promise<PaymentMethod[]> {
    return this.repository.list(userId, walletId);
  }

  async create(userId: string, walletId: string, name: string, nature: PaymentMethodNature): Promise<PaymentMethod> {
    try {
      return await this.repository.create(userId, walletId, normalizeName(name), nature);
    } catch (error) {
      return mapRepositoryError(error);
    }
  }

  async update(
    userId: string,
    walletId: string,
    paymentMethodId: string,
    changes: { name?: string; nature?: PaymentMethodNature; isActive?: boolean },
  ): Promise<PaymentMethod> {
    if (!UUID_PATTERN.test(paymentMethodId)) throw new PaymentMethodError("Forma de pagamento não encontrada.", 404);
    if (Object.keys(changes).length === 0) throw new PaymentMethodError("Informe ao menos uma alteração.", 400);
    const normalizedChanges = { ...changes, ...(changes.name === undefined ? {} : { name: normalizeName(changes.name) }) };
    try {
      const item = await this.repository.update(userId, walletId, paymentMethodId, normalizedChanges);
      if (!item) throw new PaymentMethodError("Forma de pagamento não encontrada.", 404);
      return item;
    } catch (error) {
      return mapRepositoryError(error);
    }
  }
}
