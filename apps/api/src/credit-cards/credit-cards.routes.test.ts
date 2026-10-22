import assert from "node:assert/strict";
import test from "node:test";
import { createApp } from "../app.js";
import type { Database, QueryExecutor } from "../database.js";
import { hashToken } from "../auth/token.js";
import type { AuthRepository, AuthUser, PendingAccount, StoredUser } from "../auth/auth.types.js";
import type { CreditCard, CreditCardRepository, CreditCardStatement } from "./credit-cards.types.js";
import { WalletsTestFixture } from "../wallets/wallets-test-fixture.js";

const userId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const sessionToken = "a".repeat(43);

class SessionRepository implements AuthRepository {
  async findUserByEmail(_email: string): Promise<StoredUser | null> { return null; }
  async createPendingAccount(_email: string, _passwordHash: string, _tokenHash: string, _expiresAt: Date): Promise<PendingAccount | null> { return null; }
  async deleteUnverifiedUser(_userId: string): Promise<void> {}
  async verifyEmail(_tokenHash: string, _now: Date): Promise<boolean> { return false; }
  async createSession(_userId: string, _tokenHash: string, _expiresAt: Date): Promise<void> {}
  async findUserBySession(tokenHash: string): Promise<AuthUser | null> {
    return tokenHash === hashToken(sessionToken) ? { id: userId, email: "user@example.com" } : null;
  }
  async deleteSession(_tokenHash: string): Promise<void> {}
}

class MemoryCreditCardRepository implements CreditCardRepository {
  readonly cards: CreditCard[] = [];
  private readonly statement: CreditCardStatement = {
    id: "22222222-2222-4222-8222-222222222222", creditCardId: "11111111-1111-4111-8111-111111111111",
    creditCardName: "Gold", closingDate: "2026-10-10", dueDate: "2026-10-20", paidDate: null,
    paidAmount: null, totalAmount: "10.00", purchases: [],
  };

  async list(walletId: string): Promise<CreditCard[]> { return walletId === userId ? this.cards : []; }
  async create(walletId: string, input: { nickname: string; closingDay: number; dueDay: number }): Promise<CreditCard> {
    const card = { id: "11111111-1111-4111-8111-111111111111", ...input, isActive: true };
    if (walletId === userId) this.cards.push(card);
    return card;
  }
  async update(walletId: string, creditCardId: string, changes: { nickname?: string; closingDay?: number; dueDay?: number; isActive?: boolean }): Promise<CreditCard | null> {
    if (walletId !== userId) return null;
    const existing = this.cards.find((card) => card.id === creditCardId);
    if (!existing) return null;
    Object.assign(existing, changes);
    return existing;
  }
  async listStatements(walletId: string, creditCardId: string, _from?: string, _to?: string): Promise<CreditCardStatement[] | null> {
    return walletId === userId && this.cards.some((card) => card.id === creditCardId) ? [this.statement] : null;
  }
  async payStatement(walletId: string, creditCardId: string, statementId: string, date: string): Promise<CreditCardStatement | null> {
    if (walletId !== userId || this.statement.creditCardId !== creditCardId || this.statement.id !== statementId) return null;
    this.statement.paidDate = date;
    this.statement.paidAmount = this.statement.totalAmount;
    return this.statement;
  }
}

function createTestApp(repository = new MemoryCreditCardRepository()) {
  const executor: QueryExecutor = { query: async <Row>() => ({ rows: [] as Row[], rowCount: 0 }) };
  const database: Database = { ...executor, transaction: async (work) => work(executor) };
  return {
    app: createApp(database, {
      authRepository: new SessionRepository(),
      creditCardRepository: repository,
      walletRepository: new WalletsTestFixture(),
    }),
    repository,
  };
}

test("credit-card routes require authentication and validate days", async () => {
  const { app } = createTestApp();
  assert.equal((await app.inject({ method: "GET", url: "/credit-cards" })).statusCode, 401);
  const invalid = await app.inject({
    method: "POST", url: "/credit-cards", headers: { cookie: `cashin_session=${sessionToken}` },
    payload: { nickname: "Gold", closingDay: 32, dueDay: 10 },
  });
  assert.equal(invalid.statusCode, 400);
  const created = await app.inject({
    method: "POST", url: "/credit-cards", headers: { cookie: `cashin_session=${sessionToken}` },
    payload: { nickname: " Gold ", closingDay: 31, dueDay: 10 },
  });
  assert.equal(created.statusCode, 201);
  assert.equal(created.json().nickname, "Gold");
  const listed = await app.inject({ method: "GET", url: "/credit-cards", headers: { cookie: `cashin_session=${sessionToken}` } });
  assert.equal(listed.statusCode, 200);
  assert.equal(listed.json().items[0].id, created.json().id);
  const cardId = created.json().id as string;
  const updated = await app.inject({
    method: "PATCH", url: `/credit-cards/${cardId}`, headers: { cookie: `cashin_session=${sessionToken}` },
    payload: { nickname: "Platinum" },
  });
  assert.equal(updated.statusCode, 200);
  assert.equal(updated.json().nickname, "Platinum");
  const statements = await app.inject({
    method: "GET", url: `/credit-cards/${cardId}/statements?from=2026-10-01&to=2026-10-31`,
    headers: { cookie: `cashin_session=${sessionToken}` },
  });
  assert.equal(statements.statusCode, 200);
  assert.equal(statements.json().items.length, 1);
  const payment = await app.inject({
    method: "POST", url: `/credit-cards/${cardId}/statements/22222222-2222-4222-8222-222222222222/pay`,
    headers: { cookie: `cashin_session=${sessionToken}` }, payload: { date: "2026-10-20" },
  });
  assert.equal(payment.statusCode, 200);
  assert.equal(payment.json().paidDate, "2026-10-20");
  await app.close();
});
