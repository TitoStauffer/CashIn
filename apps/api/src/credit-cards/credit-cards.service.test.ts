import assert from "node:assert/strict";
import test from "node:test";
import { CreditCardError } from "./credit-cards.errors.js";
import { CreditCardsService } from "./credit-cards.service.js";
import type { CreditCard, CreditCardRepository, CreditCardStatement } from "./credit-cards.types.js";

const cardId = "11111111-1111-4111-8111-111111111111";
const statementId = "22222222-2222-4222-8222-222222222222";

const card: CreditCard = { id: cardId, nickname: "Gold", closingDay: 10, dueDay: 20, isActive: true };
const statement: CreditCardStatement = {
  id: statementId, creditCardId: cardId, creditCardName: "Gold", closingDate: "2026-10-10", dueDate: "2026-10-20",
  paidDate: null, paidAmount: null, totalAmount: "12.34", purchases: [],
};

class MemoryCreditCardRepository implements CreditCardRepository {
  readonly calls: string[] = [];
  updateResult: CreditCard | null = card;
  statementsResult: CreditCardStatement[] | null = [statement];
  payResult: CreditCardStatement | null = statement;
  payError: unknown;

  async list(_walletId: string): Promise<CreditCard[]> { this.calls.push("list"); return [card]; }
  async create(_walletId: string, input: { nickname: string; closingDay: number; dueDay: number }): Promise<CreditCard> {
    this.calls.push(`create:${input.nickname}`); return card;
  }
  async update(_walletId: string, _creditCardId: string, changes: { nickname?: string; closingDay?: number; dueDay?: number; isActive?: boolean }): Promise<CreditCard | null> {
    this.calls.push(`update:${changes.nickname ?? ""}`); return this.updateResult;
  }
  async listStatements(_walletId: string, _creditCardId: string, from?: string, to?: string): Promise<CreditCardStatement[] | null> {
    this.calls.push(`statements:${from ?? ""}:${to ?? ""}`); return this.statementsResult;
  }
  async payStatement(_walletId: string, _creditCardId: string, _statementId: string, date: string): Promise<CreditCardStatement | null> {
    this.calls.push(`pay:${date}`);
    if (this.payError) throw this.payError;
    return this.payResult;
  }
}

test("credit-card service validates creation and normalizes nickname", async () => {
  const repository = new MemoryCreditCardRepository();
  const service = new CreditCardsService(repository);
  assert.deepEqual(await service.list("wallet"), [card]);
  assert.deepEqual(await service.create("wallet", { nickname: " Gold ", closingDay: 31, dueDay: 1 }), card);
  assert.ok(repository.calls.includes("create:Gold"));
  await assert.rejects(() => service.create("wallet", { nickname: " ", closingDay: 1, dueDay: 1 }), CreditCardError);
  await assert.rejects(() => service.create("wallet", { nickname: "Gold", closingDay: 0, dueDay: 1 }), CreditCardError);
  await assert.rejects(() => service.create("wallet", { nickname: "Gold", closingDay: 1, dueDay: 32 }), CreditCardError);
});

test("credit-card service validates partial updates and handles missing cards", async () => {
  const repository = new MemoryCreditCardRepository();
  const service = new CreditCardsService(repository);
  assert.deepEqual(await service.update("wallet", cardId, { nickname: " Platinum " }), card);
  await assert.rejects(() => service.update("wallet", "invalid", { nickname: "Valid" }), /Cartão não encontrado/);
  await assert.rejects(() => service.update("wallet", cardId, {}), /Informe ao menos uma alteração/);
  await assert.rejects(() => service.update("wallet", cardId, { closingDay: 32 }), /dia de fechamento/);
  repository.updateResult = null;
  await assert.rejects(() => service.update("wallet", cardId, { isActive: false }), /Cartão não encontrado/);
});

test("credit-card service validates statement queries and returns wallet-scoped results", async () => {
  const repository = new MemoryCreditCardRepository();
  const service = new CreditCardsService(repository);
  assert.deepEqual(await service.listStatements("wallet", cardId, "2026-10-01", "2026-10-31"), [statement]);
  await assert.rejects(() => service.listStatements("wallet", "invalid"), /Cartão não encontrado/);
  await assert.rejects(() => service.listStatements("wallet", cardId, "2026-02-30"), /data válida/);
  await assert.rejects(() => service.listStatements("wallet", cardId, "2026-11-01", "2026-10-01"), /anterior ou igual/);
  repository.statementsResult = null;
  await assert.rejects(() => service.listStatements("wallet", cardId), /Cartão não encontrado/);
});

test("credit-card service validates payment and maps repository reference errors", async () => {
  const repository = new MemoryCreditCardRepository();
  const service = new CreditCardsService(repository);
  assert.deepEqual(await service.payStatement("wallet", cardId, statementId, "2026-10-20"), statement);
  await assert.rejects(() => service.payStatement("wallet", "invalid", statementId, "2026-10-20"), /Fatura não encontrada/);
  await assert.rejects(() => service.payStatement("wallet", cardId, statementId, "2026-10-20T12:00:00"), /formato AAAA-MM-DD/);
  repository.payResult = null;
  await assert.rejects(() => service.payStatement("wallet", cardId, statementId, "2026-10-20"), /Fatura não encontrada/);
  repository.payError = { code: "23503" };
  await assert.rejects(
    () => service.payStatement("wallet", cardId, statementId, "2026-10-20"),
    (error: unknown) => error instanceof CreditCardError && error.statusCode === 404,
  );
  repository.payError = new CreditCardError("Esta fatura já foi paga.", 409);
  await assert.rejects(
    () => service.payStatement("wallet", cardId, statementId, "2026-10-20"),
    (error: unknown) => error instanceof CreditCardError && error.statusCode === 409,
  );
});
