import assert from "node:assert/strict";
import test from "node:test";
import { createApp } from "../app.js";
import type { Database, QueryExecutor } from "../database.js";
import type { AuthRepository, AuthUser, PendingAccount, StoredUser } from "../auth/auth.types.js";
import { hashToken } from "../auth/token.js";
import type { FinancialSummary, FinancialSummaryRepository } from "./financial-summary.types.js";

const USER_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SESSION = "a".repeat(43);
const expected: FinancialSummary = {
  incomeTotal: "100.00",
  expenseTotal: "25.00",
  contributionTotal: "10.00",
  availableBalance: "65.00",
  incomeByCategory: [],
  expenseByCategory: [],
};

class SessionAuthRepository implements AuthRepository {
  async findUserByEmail(_email: string): Promise<StoredUser | null> { return null; }
  async createPendingAccount(_email: string, _passwordHash: string, _tokenHash: string, _expiresAt: Date): Promise<PendingAccount | null> { return null; }
  async deleteUnverifiedUser(_userId: string): Promise<void> {}
  async verifyEmail(_tokenHash: string, _now: Date): Promise<boolean> { return false; }
  async createSession(_userId: string, _tokenHash: string, _expiresAt: Date): Promise<void> {}
  async findUserBySession(tokenHash: string): Promise<AuthUser | null> {
    return tokenHash === hashToken(SESSION) ? { id: USER_ID, email: "owner@example.com" } : null;
  }
  async deleteSession(_tokenHash: string): Promise<void> {}
}

class MemorySummaryRepository implements FinancialSummaryRepository {
  calls: Array<{ userId: string; from?: string; to?: string }> = [];
  async getSummary(userId: string, from?: string, to?: string): Promise<FinancialSummary> {
    this.calls.push({ userId, from, to });
    return expected;
  }
}

function createDatabase(): Database {
  const executor: QueryExecutor = { query: async <Row>() => ({ rows: [] as Row[], rowCount: 0 }) };
  return { ...executor, transaction: async (work) => work(executor) };
}

test("GET /financial-summary is authenticated, returns separate totals and forwards inclusive date bounds", async () => {
  const summaryRepository = new MemorySummaryRepository();
  const app = createApp(createDatabase(), {
    authRepository: new SessionAuthRepository(),
    financialSummaryRepository: summaryRepository,
  });

  assert.equal((await app.inject({ method: "GET", url: "/financial-summary" })).statusCode, 401);
  const response = await app.inject({
    method: "GET",
    url: "/financial-summary?from=2026-10-01&to=2026-10-31",
    headers: { cookie: `cashin_session=${SESSION}` },
  });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), expected);
  assert.deepEqual(summaryRepository.calls, [{ userId: USER_ID, from: "2026-10-01", to: "2026-10-31" }]);

  const invalidRange = await app.inject({
    method: "GET",
    url: "/financial-summary?from=2026-11-01&to=2026-10-31",
    headers: { cookie: `cashin_session=${SESSION}` },
  });
  assert.equal(invalidRange.statusCode, 400);
  const invalidDate = await app.inject({
    method: "GET",
    url: "/financial-summary?from=2026-02-30",
    headers: { cookie: `cashin_session=${SESSION}` },
  });
  assert.equal(invalidDate.statusCode, 400);
  await app.close();
});
