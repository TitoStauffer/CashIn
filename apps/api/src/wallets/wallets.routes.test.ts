import assert from "node:assert/strict";
import test from "node:test";
import { createApp } from "../app.js";
import type { AuthRepository, AuthUser, PendingAccount, StoredUser } from "../auth/auth.types.js";
import { hashToken } from "../auth/token.js";
import type { Database, QueryExecutor } from "../database.js";
import type { Wallet, WalletRepository } from "./wallets.types.js";

const USER_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const USER_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const PERSONAL_A = "11111111-1111-4111-8111-111111111111";
const SHARED_B = "22222222-2222-4222-8222-222222222222";
const UNKNOWN_WALLET = "33333333-3333-4333-8333-333333333333";
const SESSION_A = "a".repeat(43);
const SESSION_B = "b".repeat(43);

class TestAuthRepository implements AuthRepository {
  private readonly users = new Map<string, AuthUser>([
    [USER_A, { id: USER_A, email: "a@example.com" }],
    [USER_B, { id: USER_B, email: "b@example.com" }],
  ]);
  private readonly sessions = new Map([[hashToken(SESSION_A), USER_A], [hashToken(SESSION_B), USER_B]]);

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

class TestWalletRepository implements WalletRepository {
  readonly wallets: Wallet[] = [
    { id: PERSONAL_A, name: "Pessoal", isPersonal: true, role: "owner" },
    { id: SHARED_B, name: "Carteira B", isPersonal: false, role: "member" },
  ];
  readonly memberships = new Map<string, Set<string>>([
    [USER_A, new Set([PERSONAL_A])],
    [USER_B, new Set([SHARED_B])],
  ]);

  async listForUser(userId: string): Promise<Wallet[]> {
    return this.wallets.filter((wallet) => this.memberships.get(userId)?.has(wallet.id));
  }

  async findPersonalForUser(userId: string): Promise<Wallet | null> {
    return this.wallets.find((wallet) => wallet.isPersonal && this.memberships.get(userId)?.has(wallet.id)) ?? null;
  }

  async findAccessibleWallet(userId: string, walletId: string): Promise<Wallet | null> {
    return this.wallets.find((wallet) => wallet.id === walletId && this.memberships.get(userId)?.has(wallet.id)) ?? null;
  }

  async createForUser(userId: string, name: string): Promise<Wallet> {
    if (this.wallets.some((wallet) => wallet.name.toLowerCase() === name.toLowerCase())) {
      throw { code: "23505" };
    }
    const wallet: Wallet = { id: UNKNOWN_WALLET, name, isPersonal: false, role: "owner" };
    this.wallets.push(wallet);
    this.memberships.get(userId)?.add(wallet.id);
    return wallet;
  }
}

function createDatabase(): Database {
  const executor: QueryExecutor = { query: async <Row>() => ({ rows: [] as Row[], rowCount: 0 }) };
  return { ...executor, transaction: async (work) => work(executor) };
}

function createTestApp(walletRepository = new TestWalletRepository()) {
  const app = createApp(createDatabase(), {
    authRepository: new TestAuthRepository(),
    walletRepository,
  });
  app.get("/test-wallet-context", { preHandler: [app.authenticate, app.resolveWalletContext] }, async (request) => ({
    walletId: request.currentWalletId,
  }));
  return { app, walletRepository };
}

function cookie(session: string): string { return `cashin_session=${session}`; }

test("wallet routes list and create wallets with normalized names and duplicate validation", async () => {
  const { app } = createTestApp();
  const headers = { cookie: cookie(SESSION_A) };
  try {
    const list = await app.inject({ method: "GET", url: "/wallets", headers });
    assert.equal(list.statusCode, 200);
    assert.deepEqual(list.json(), { items: [{ id: PERSONAL_A, name: "Pessoal", isPersonal: true, role: "owner" }] });

    const created = await app.inject({ method: "POST", url: "/wallets", headers, payload: { name: "  Viagem  " } });
    assert.equal(created.statusCode, 201);
    assert.deepEqual(created.json(), { id: UNKNOWN_WALLET, name: "Viagem", isPersonal: false, role: "owner" });

    const duplicate = await app.inject({ method: "POST", url: "/wallets", headers, payload: { name: "viagem" } });
    assert.equal(duplicate.statusCode, 409);
    const blank = await app.inject({ method: "POST", url: "/wallets", headers, payload: { name: "   " } });
    assert.equal(blank.statusCode, 400);
    const tooLong = await app.inject({ method: "POST", url: "/wallets", headers, payload: { name: "x".repeat(101) } });
    assert.equal(tooLong.statusCode, 400);
  } finally {
    await app.close();
  }
});

test("wallet context defaults to personal, allows members, and hides inaccessible wallets", async () => {
  const { app } = createTestApp();
  try {
    const personal = await app.inject({ method: "GET", url: "/test-wallet-context", headers: { cookie: cookie(SESSION_A) } });
    assert.equal(personal.statusCode, 200);
    assert.deepEqual(personal.json(), { walletId: PERSONAL_A });

    const member = await app.inject({
      method: "GET",
      url: "/test-wallet-context",
      headers: { cookie: cookie(SESSION_B), "x-wallet-id": SHARED_B },
    });
    assert.equal(member.statusCode, 200);
    assert.deepEqual(member.json(), { walletId: SHARED_B });

    const unknown = await app.inject({
      method: "GET",
      url: "/test-wallet-context",
      headers: { cookie: cookie(SESSION_A), "x-wallet-id": UNKNOWN_WALLET },
    });
    assert.equal(unknown.statusCode, 404);
    const malformed = await app.inject({
      method: "GET",
      url: "/test-wallet-context",
      headers: { cookie: cookie(SESSION_A), "x-wallet-id": "not-a-uuid" },
    });
    assert.equal(malformed.statusCode, 404);
  } finally {
    await app.close();
  }
});
