import assert from "node:assert/strict";
import test from "node:test";
import { createApp } from "../app.js";
import type { Database, QueryExecutor } from "../database.js";
import { hashToken } from "../auth/token.js";
import type { AuthRepository, AuthUser, PendingAccount, StoredUser } from "../auth/auth.types.js";
import { WalletsTestFixture } from "../wallets/wallets-test-fixture.js";
import { PaymentMethodConflictError } from "./payment-methods.errors.js";
import type { PaymentMethod, PaymentMethodNature, PaymentMethodRepository } from "./payment-methods.types.js";

const USER_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SESSION_A = "a".repeat(43);
const SESSION_HASH = hashToken(SESSION_A);

function normalizeName(name: string): string {
  return name.trim().normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

class MemoryPaymentMethodRepository implements PaymentMethodRepository {
  readonly items = new Map<string, PaymentMethod>();
  private nextId = 1;

  async list(_userId: string, _walletId: string): Promise<PaymentMethod[]> {
    return [...this.items.values()];
  }

  async create(_userId: string, _walletId: string, name: string, nature: PaymentMethodNature): Promise<PaymentMethod> {
    if ([...this.items.values()].some((item) => normalizeName(item.name) === normalizeName(name))) {
      throw new PaymentMethodConflictError("duplicate");
    }
    const item = { id: `00000000-0000-4000-8000-${this.nextId.toString().padStart(12, "0")}`, name, nature, isActive: true };
    this.nextId += 1;
    this.items.set(item.id, item);
    return item;
  }

  async update(_userId: string, _walletId: string, paymentMethodId: string, changes: { name?: string; nature?: PaymentMethodNature; isActive?: boolean }): Promise<PaymentMethod | null> {
    const current = this.items.get(paymentMethodId);
    if (!current) return null;
    if (changes.name && [...this.items.values()].some((item) => item.id !== paymentMethodId && normalizeName(item.name) === normalizeName(changes.name!))) {
      throw new PaymentMethodConflictError("duplicate");
    }
    const updated = { ...current, ...changes };
    this.items.set(paymentMethodId, updated);
    return updated;
  }
}

class SessionAuthRepository implements AuthRepository {
  async findUserByEmail(_email: string): Promise<StoredUser | null> { return null; }
  async createPendingAccount(_email: string, _passwordHash: string, _tokenHash: string, _expiresAt: Date): Promise<PendingAccount | null> { return null; }
  async deleteUnverifiedUser(_userId: string): Promise<void> {}
  async verifyEmail(_tokenHash: string, _now: Date): Promise<boolean> { return false; }
  async createSession(_userId: string, _tokenHash: string, _expiresAt: Date): Promise<void> {}
  async findUserBySession(tokenHash: string): Promise<AuthUser | null> {
    return tokenHash === SESSION_HASH ? { id: USER_A, email: "a@example.com" } : null;
  }
  async deleteSession(_tokenHash: string): Promise<void> {}
}

function createTestApp(repository = new MemoryPaymentMethodRepository()) {
  const executor: QueryExecutor = { query: async <Row>() => ({ rows: [] as Row[], rowCount: 0 }) };
  const database: Database = { ...executor, transaction: async (work) => work(executor) };
  return {
    app: createApp(database, {
      authRepository: new SessionAuthRepository(),
      paymentMethodRepository: repository,
      walletRepository: new WalletsTestFixture(),
    }),
    repository,
  };
}

const authCookie = `cashin_session=${SESSION_A}`;

test("payment methods are authenticated, wallet-scoped, accent-insensitive, and deactivatable", async () => {
  const { app } = createTestApp();
  assert.equal((await app.inject({ method: "GET", url: "/payment-methods" })).statusCode, 401);

  const created = await app.inject({
    method: "POST", url: "/payment-methods", headers: { cookie: authCookie },
    payload: { name: "Vale-Alimentação", nature: "food_benefit" },
  });
  assert.equal(created.statusCode, 201);
  assert.equal(created.json().isActive, true);
  const paymentMethodId = created.json().id as string;

  const duplicate = await app.inject({
    method: "POST", url: "/payment-methods", headers: { cookie: authCookie },
    payload: { name: "vale-alimentacao", nature: "food_benefit" },
  });
  assert.equal(duplicate.statusCode, 409);

  const renamed = await app.inject({
    method: "PATCH", url: `/payment-methods/${paymentMethodId}`, headers: { cookie: authCookie },
    payload: { name: "Cartão refeição", nature: "meal_benefit" },
  });
  assert.equal(renamed.statusCode, 200);
  assert.equal(renamed.json().nature, "food_meal_benefit");

  const deactivated = await app.inject({
    method: "PATCH", url: `/payment-methods/${paymentMethodId}`, headers: { cookie: authCookie },
    payload: { isActive: false },
  });
  assert.equal(deactivated.statusCode, 200);
  assert.equal(deactivated.json().isActive, false);

  const list = await app.inject({ method: "GET", url: "/payment-methods", headers: { cookie: authCookie } });
  assert.equal(list.statusCode, 200);
  assert.equal(list.json().items[0].id, paymentMethodId);
  await app.close();
});

test("payment method endpoint rejects invalid nature, unknown properties, and empty patches", async () => {
  const { app } = createTestApp();
  const invalidNature = await app.inject({
    method: "POST", url: "/payment-methods", headers: { cookie: authCookie },
    payload: { name: "Outro", nature: "unknown" },
  });
  assert.equal(invalidNature.statusCode, 400);

  const unknownProperty = await app.inject({
    method: "POST", url: "/payment-methods", headers: { cookie: authCookie },
    payload: { name: "Outro", nature: "immediate", walletId: USER_A },
  });
  assert.equal(unknownProperty.statusCode, 400);

  const emptyPatch = await app.inject({
    method: "PATCH", url: "/payment-methods/00000000-0000-4000-8000-000000000001", headers: { cookie: authCookie }, payload: {},
  });
  assert.equal(emptyPatch.statusCode, 400);
  await app.close();
});
