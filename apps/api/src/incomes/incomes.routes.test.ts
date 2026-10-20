import assert from "node:assert/strict";
import test from "node:test";
import { createApp } from "../app.js";
import type { Database, QueryExecutor } from "../database.js";
import { hashToken } from "../auth/token.js";
import type { AuthRepository, AuthUser, PendingAccount, StoredUser } from "../auth/auth.types.js";
import type { Income, IncomeInput, IncomeRepository } from "./incomes.types.js";
import { WalletsTestFixture } from "../wallets/wallets-test-fixture.js";

const USER_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const USER_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CATEGORY_A = "11111111-1111-4111-8111-111111111111";
const CATEGORY_B = "22222222-2222-4222-8222-222222222222";
const SUBCATEGORY_A = "33333333-3333-4333-8333-333333333333";
const SESSION_A = "a".repeat(43);
const SESSION_B = "b".repeat(43);

class MemoryIncomeRepository implements IncomeRepository {
  readonly items = new Map<string, Income & { userId: string }>();
  private readonly categories = new Map<string, { userId: string; name: string; nature: string }>([
    [CATEGORY_A, { userId: USER_A, name: "Salário", nature: "income" }],
    [CATEGORY_B, { userId: USER_B, name: "Salário", nature: "income" }],
  ]);
  private readonly subcategories = new Map<string, { userId: string; categoryId: string; name: string }>([
    [SUBCATEGORY_A, { userId: USER_A, categoryId: CATEGORY_A, name: "Mensal" }],
  ]);
  private nextId = 1;

  private isValidReference(userId: string, input: Required<IncomeInput>): boolean {
    const category = this.categories.get(input.categoryId);
    if (!category || category.userId !== userId || category.nature !== "income") return false;
    if (!input.subcategoryId) return true;
    const subcategory = this.subcategories.get(input.subcategoryId);
    return subcategory?.userId === userId && subcategory.categoryId === input.categoryId;
  }

  async listIncomes(userId: string, _walletId: string, from?: string, to?: string): Promise<Income[]> {
    return [...this.items.values()]
      .filter((item) => item.userId === userId && (!from || item.date >= from) && (!to || item.date <= to))
      .sort((left, right) => right.date.localeCompare(left.date) || right.createdAt.localeCompare(left.createdAt))
      .map(({ userId: _userId, ...item }) => item);
  }

  async createIncome(userId: string, _walletId: string, input: Required<IncomeInput>): Promise<Income | null> {
    if (!this.isValidReference(userId, input)) return null;
    const id = `44444444-4444-4444-8444-${this.nextId.toString().padStart(12, "0")}`;
    this.nextId += 1;
    const category = this.categories.get(input.categoryId)!;
    const subcategory = input.subcategoryId ? this.subcategories.get(input.subcategoryId)! : null;
    const now = new Date().toISOString();
    const item: Income & { userId: string } = {
      id,
      userId,
      amount: input.amount,
      date: input.date,
      description: input.description,
      categoryId: input.categoryId,
      categoryName: category.name,
      subcategoryId: input.subcategoryId,
      subcategoryName: subcategory?.name ?? null,
      createdAt: now,
      updatedAt: now,
    };
    this.items.set(id, item);
    const { userId: _owner, ...result } = item;
    return result;
  }

  async updateIncome(userId: string, _walletId: string, incomeId: string, input: Required<IncomeInput>): Promise<Income | null> {
    const previous = this.items.get(incomeId);
    if (!previous || previous.userId !== userId || !this.isValidReference(userId, input)) return null;
    const category = this.categories.get(input.categoryId)!;
    const subcategory = input.subcategoryId ? this.subcategories.get(input.subcategoryId)! : null;
    const updated = {
      ...previous,
      amount: input.amount,
      date: input.date,
      description: input.description,
      categoryId: input.categoryId,
      categoryName: category.name,
      subcategoryId: input.subcategoryId,
      subcategoryName: subcategory?.name ?? null,
      updatedAt: new Date().toISOString(),
    };
    this.items.set(incomeId, updated);
    const { userId: _owner, ...result } = updated;
    return result;
  }

  async deleteIncome(userId: string, _walletId: string, incomeId: string): Promise<boolean> {
    const item = this.items.get(incomeId);
    if (!item || item.userId !== userId) return false;
    return this.items.delete(incomeId);
  }

  async hasIncome(userId: string, _walletId: string, incomeId: string): Promise<boolean> {
    return this.items.get(incomeId)?.userId === userId;
  }
}

class SessionAuthRepository implements AuthRepository {
  private readonly users = new Map<string, AuthUser>([
    [USER_A, { id: USER_A, email: "a@example.com" }],
    [USER_B, { id: USER_B, email: "b@example.com" }],
  ]);
  private readonly sessions = new Map<string, string>([
    [hashToken(SESSION_A), USER_A],
    [hashToken(SESSION_B), USER_B],
  ]);

  async findUserByEmail(_email: string): Promise<StoredUser | null> { return null; }
  async createPendingAccount(_email: string, _passwordHash: string, _tokenHash: string, _expiresAt: Date): Promise<PendingAccount | null> { return null; }
  async deleteUnverifiedUser(_userId: string): Promise<void> {}
  async verifyEmail(_tokenHash: string, _now: Date): Promise<boolean> { return false; }
  async createSession(_userId: string, _tokenHash: string, _expiresAt: Date): Promise<void> {}
  async findUserBySession(tokenHash: string): Promise<AuthUser | null> {
    const userId = this.sessions.get(tokenHash);
    return userId ? this.users.get(userId) ?? null : null;
  }
  async deleteSession(tokenHash: string): Promise<void> { this.sessions.delete(tokenHash); }
}

function createTestApp(repository = new MemoryIncomeRepository()) {
  const executor: QueryExecutor = { query: async <Row>() => ({ rows: [] as Row[], rowCount: 0 }) };
  const database: Database = { ...executor, transaction: async (work) => work(executor) };
  return {
    app: createApp(database, { authRepository: new SessionAuthRepository(), incomeRepository: repository, walletRepository: new WalletsTestFixture() }),
    repository,
  };
}

function authCookie(session = SESSION_A): string {
  return `cashin_session=${session}`;
}

const validPayload = {
  amount: "1250.50",
  date: "2026-10-18",
  description: "Salário mensal",
  categoryId: CATEGORY_A,
  subcategoryId: SUBCATEGORY_A,
};

test("income CRUD is authenticated, owner-scoped, and uses decimal strings", async () => {
  const { app } = createTestApp();
  assert.equal((await app.inject({ method: "GET", url: "/incomes" })).statusCode, 401);

  const created = await app.inject({
    method: "POST", url: "/incomes", headers: { cookie: authCookie() }, payload: validPayload,
  });
  assert.equal(created.statusCode, 201);
  assert.equal(created.json().amount, "1250.50");
  assert.equal(created.json().categoryName, "Salário");
  assert.equal(created.json().subcategoryName, "Mensal");
  const incomeId = created.json().id as string;

  const otherUserList = await app.inject({ method: "GET", url: "/incomes", headers: { cookie: authCookie(SESSION_B) } });
  assert.deepEqual(otherUserList.json().items, []);
  const hiddenRecord = await app.inject({ method: "PUT", url: `/incomes/${incomeId}`, headers: { cookie: authCookie(SESSION_B) }, payload: validPayload });
  assert.equal(hiddenRecord.statusCode, 404);
  const hiddenDelete = await app.inject({ method: "DELETE", url: `/incomes/${incomeId}`, headers: { cookie: authCookie(SESSION_B) } });
  assert.equal(hiddenDelete.statusCode, 404);

  const updated = await app.inject({
    method: "PUT",
    url: `/incomes/${incomeId}`,
    headers: { cookie: authCookie() },
    payload: { amount: "200", date: "2026-10-19", categoryId: CATEGORY_A },
  });
  assert.equal(updated.statusCode, 200);
  assert.equal(updated.json().description, null);
  assert.equal(updated.json().subcategoryId, null);
  const deleted = await app.inject({ method: "DELETE", url: `/incomes/${incomeId}`, headers: { cookie: authCookie() } });
  assert.equal(deleted.statusCode, 204);
  await app.close();
});

test("income filters are inclusive, ordered, and reject invalid values or references", async () => {
  const { app } = createTestApp();
  for (const date of ["2026-10-18", "2026-10-19", "2026-10-20"]) {
    await app.inject({
      method: "POST", url: "/incomes", headers: { cookie: authCookie() },
      payload: { ...validPayload, date },
    });
  }
  const filtered = await app.inject({
    method: "GET", url: "/incomes?from=2026-10-18&to=2026-10-19", headers: { cookie: authCookie() },
  });
  assert.equal(filtered.statusCode, 200);
  assert.deepEqual(filtered.json().items.map((item: Income) => item.date), ["2026-10-19", "2026-10-18"]);

  const invalidAmount = await app.inject({
    method: "POST", url: "/incomes", headers: { cookie: authCookie() }, payload: { ...validPayload, amount: "1.234" },
  });
  assert.equal(invalidAmount.statusCode, 400);
  const invalidDate = await app.inject({
    method: "POST", url: "/incomes", headers: { cookie: authCookie() }, payload: { ...validPayload, date: "2026-02-30" },
  });
  assert.equal(invalidDate.statusCode, 400);
  const foreignCategory = await app.inject({
    method: "POST", url: "/incomes", headers: { cookie: authCookie() }, payload: { ...validPayload, categoryId: CATEGORY_B },
  });
  assert.equal(foreignCategory.statusCode, 400);
  const foreignSubcategory = await app.inject({
    method: "POST", url: "/incomes", headers: { cookie: authCookie() }, payload: { ...validPayload, subcategoryId: CATEGORY_B },
  });
  assert.equal(foreignSubcategory.statusCode, 400);
  const reversedRange = await app.inject({
    method: "GET", url: "/incomes?from=2026-10-20&to=2026-10-18", headers: { cookie: authCookie() },
  });
  assert.equal(reversedRange.statusCode, 400);
  await app.close();
});
