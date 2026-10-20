import assert from "node:assert/strict";
import test from "node:test";
import { createApp } from "../app.js";
import type { Database, QueryExecutor } from "../database.js";
import type { AuthRepository, AuthUser, PendingAccount, StoredUser } from "../auth/auth.types.js";
import { hashToken } from "../auth/token.js";
import type {
  InvestmentContribution,
  InvestmentContributionInput,
  InvestmentGoal,
  InvestmentGoalInput,
  InvestmentGoalsRepository,
} from "./investment-goals.types.js";

const USER_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const USER_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SESSION_A = "a".repeat(43);
const SESSION_B = "b".repeat(43);

class SessionAuthRepository implements AuthRepository {
  private readonly sessions = new Map([[hashToken(SESSION_A), USER_A], [hashToken(SESSION_B), USER_B]]);
  async findUserByEmail(_email: string): Promise<StoredUser | null> { return null; }
  async createPendingAccount(_email: string, _passwordHash: string, _tokenHash: string, _expiresAt: Date): Promise<PendingAccount | null> { return null; }
  async deleteUnverifiedUser(_userId: string): Promise<void> {}
  async verifyEmail(_tokenHash: string, _now: Date): Promise<boolean> { return false; }
  async createSession(_userId: string, _tokenHash: string, _expiresAt: Date): Promise<void> {}
  async findUserBySession(tokenHash: string): Promise<AuthUser | null> {
    const id = this.sessions.get(tokenHash);
    return id ? { id, email: `${id}@example.com` } : null;
  }
  async deleteSession(tokenHash: string): Promise<void> { this.sessions.delete(tokenHash); }
}

class MemoryInvestmentGoalsRepository implements InvestmentGoalsRepository {
  readonly goals = new Map<string, InvestmentGoal & { userId: string }>();
  readonly contributions = new Map<string, InvestmentContribution & { userId: string; goalId: string }>();
  private nextId = 1;

  private createId(): string {
    const id = `00000000-0000-4000-8000-${this.nextId.toString(16).padStart(12, "0")}`;
    this.nextId += 1;
    return id;
  }

  private toGoal(goal: InvestmentGoal & { userId: string }): InvestmentGoal {
    const { userId: _userId, ...result } = goal;
    const contributions = [...this.contributions.values()].filter((item) => item.goalId === goal.id && item.userId === goal.userId);
    const total = contributions.reduce((sum, item) => sum + Math.round(Number(item.amount) * 100), 0);
    return { ...result, contributedAmount: (total / 100).toFixed(2), progressPercentage: Number((total / 100 / Number(goal.targetAmount) * 100).toFixed(2)) };
  }

  async listGoals(userId: string): Promise<InvestmentGoal[]> {
    return [...this.goals.values()].filter((goal) => goal.userId === userId).map((goal) => this.toGoal(goal));
  }
  async getGoal(userId: string, goalId: string): Promise<InvestmentGoal | null> {
    const goal = this.goals.get(goalId);
    return goal?.userId === userId ? this.toGoal(goal) : null;
  }
  async createGoal(userId: string, input: Required<InvestmentGoalInput>): Promise<InvestmentGoal> {
    const goal = {
      id: this.createId(), userId, ...input, status: "active" as const,
      categoryName: null, subcategoryName: null, contributedAmount: "0.00", progressPercentage: 0,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    };
    this.goals.set(goal.id, goal);
    return this.toGoal(goal);
  }
  async updateGoal(userId: string, goalId: string, input: Required<InvestmentGoalInput>): Promise<InvestmentGoal | null> {
    const goal = this.goals.get(goalId);
    if (!goal || goal.userId !== userId || goal.status === "closed") return null;
    Object.assign(goal, input);
    return this.toGoal(goal);
  }
  async closeGoal(userId: string, goalId: string): Promise<InvestmentGoal | null> {
    const goal = this.goals.get(goalId);
    if (!goal || goal.userId !== userId) return null;
    goal.status = "closed";
    return this.toGoal(goal);
  }
  async hasGoal(userId: string, goalId: string): Promise<boolean> { return this.goals.get(goalId)?.userId === userId; }
  async listContributions(userId: string, goalId: string): Promise<InvestmentContribution[]> {
    return [...this.contributions.values()].filter((item) => item.userId === userId && item.goalId === goalId)
      .map(({ userId: _userId, goalId: _goalId, ...item }) => item);
  }
  async createContribution(userId: string, goalId: string, input: Required<InvestmentContributionInput>): Promise<InvestmentContribution | null> {
    const goal = this.goals.get(goalId);
    if (!goal || goal.userId !== userId || goal.status === "closed") return null;
    const contribution = { id: this.createId(), userId, goalId, ...input, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    this.contributions.set(contribution.id, contribution);
    const { userId: _userId, goalId: _goalId, ...result } = contribution;
    return result;
  }
  async updateContribution(userId: string, goalId: string, contributionId: string, input: Required<InvestmentContributionInput>): Promise<InvestmentContribution | null> {
    const item = this.contributions.get(contributionId);
    const goal = this.goals.get(goalId);
    if (!item || item.userId !== userId || item.goalId !== goalId || goal?.status === "closed") return null;
    Object.assign(item, input);
    const { userId: _userId, goalId: _goalId, ...result } = item;
    return result;
  }
  async deleteContribution(userId: string, goalId: string, contributionId: string): Promise<boolean> {
    const item = this.contributions.get(contributionId);
    const goal = this.goals.get(goalId);
    return item?.userId === userId && item.goalId === goalId && goal?.status === "active"
      ? this.contributions.delete(contributionId)
      : false;
  }
  async hasContribution(userId: string, goalId: string, contributionId: string): Promise<boolean> {
    const item = this.contributions.get(contributionId);
    return item?.userId === userId && item.goalId === goalId;
  }
}

function createDatabase(): Database {
  const executor: QueryExecutor = { query: async <Row>() => ({ rows: [] as Row[], rowCount: 0 }) };
  return { ...executor, transaction: async (work) => work(executor) };
}

function createTestApp(repository = new MemoryInvestmentGoalsRepository()) {
  const app = createApp(createDatabase(), {
    authRepository: new SessionAuthRepository(),
    investmentGoalsRepository: repository,
  });
  return { app, repository };
}

function authCookie(session = SESSION_A): string { return `cashin_session=${session}`; }

test("investment goal and contribution endpoints require authentication and validate payloads", async () => {
  const { app } = createTestApp();
  assert.equal((await app.inject({ method: "GET", url: "/investment-goals" })).statusCode, 401);
  const invalid = await app.inject({
    method: "POST", url: "/investment-goals", headers: { cookie: authCookie() },
    payload: { title: "Reserva", description: "Viagem", targetAmount: "0" },
  });
  assert.equal(invalid.statusCode, 400);
  const create = await app.inject({
    method: "POST", url: "/investment-goals", headers: { cookie: authCookie() },
    payload: { title: "Reserva", description: "Viagem", targetAmount: "5000.00", dueDate: null },
  });
  assert.equal(create.statusCode, 201);
  assert.equal(create.json().dueDate, null);
  await app.close();
});

test("investment goal progress follows contribution CRUD and goals stay isolated by owner", async () => {
  const { app } = createTestApp();
  const goal = await app.inject({
    method: "POST", url: "/investment-goals", headers: { cookie: authCookie() },
    payload: { title: "Reserva", description: "Emergência", targetAmount: "100.00" },
  });
  const goalId = goal.json().id as string;
  const contribution = await app.inject({
    method: "POST", url: `/investment-goals/${goalId}/contributions`, headers: { cookie: authCookie() },
    payload: { amount: "25.50", date: "2026-10-19" },
  });
  const contributionId = contribution.json().id as string;
  const updated = await app.inject({
    method: "PUT", url: `/investment-goals/${goalId}/contributions/${contributionId}`, headers: { cookie: authCookie() },
    payload: { amount: "40.00", date: "2026-10-19", description: "Aporte" },
  });
  assert.equal(updated.statusCode, 200);
  const fetched = await app.inject({ method: "GET", url: `/investment-goals/${goalId}`, headers: { cookie: authCookie() } });
  assert.equal(fetched.json().contributedAmount, "40.00");
  assert.equal(fetched.json().progressPercentage, 40);

  const removable = await app.inject({
    method: "POST", url: `/investment-goals/${goalId}/contributions`, headers: { cookie: authCookie() },
    payload: { amount: "5.00", date: "2026-10-19" },
  });
  assert.equal((await app.inject({
    method: "DELETE", url: `/investment-goals/${goalId}/contributions/${removable.json().id}`, headers: { cookie: authCookie() },
  })).statusCode, 204);

  const foreign = await app.inject({ method: "GET", url: `/investment-goals/${goalId}`, headers: { cookie: authCookie(SESSION_B) } });
  assert.equal(foreign.statusCode, 404);
  const foreignDelete = await app.inject({
    method: "DELETE", url: `/investment-goals/${goalId}/contributions/${contributionId}`, headers: { cookie: authCookie(SESSION_B) },
  });
  assert.equal(foreignDelete.statusCode, 404);

  const close = await app.inject({
    method: "POST", url: `/investment-goals/${goalId}/close`, headers: { cookie: authCookie() },
  });
  assert.equal(close.statusCode, 200);
  const closedContribution = await app.inject({
    method: "POST", url: `/investment-goals/${goalId}/contributions`, headers: { cookie: authCookie() },
    payload: { amount: "10", date: "2026-10-19" },
  });
  assert.equal(closedContribution.statusCode, 409);
  const closedGoalUpdate = await app.inject({
    method: "PUT", url: `/investment-goals/${goalId}`, headers: { cookie: authCookie() },
    payload: { title: "Novo título", description: "Alteração", targetAmount: "100.00" },
  });
  assert.equal(closedGoalUpdate.statusCode, 409);
  assert.match(closedGoalUpdate.json().message, /encerrada/i);
  const closedContributionUpdate = await app.inject({
    method: "PUT", url: `/investment-goals/${goalId}/contributions/${contributionId}`, headers: { cookie: authCookie() },
    payload: { amount: "50.00", date: "2026-10-20" },
  });
  assert.equal(closedContributionUpdate.statusCode, 409);
  const closedContributionDelete = await app.inject({
    method: "DELETE", url: `/investment-goals/${goalId}/contributions/${contributionId}`, headers: { cookie: authCookie() },
  });
  assert.equal(closedContributionDelete.statusCode, 409);
  const afterDelete = await app.inject({ method: "GET", url: `/investment-goals/${goalId}`, headers: { cookie: authCookie() } });
  assert.equal(afterDelete.json().contributedAmount, "40.00");
  await app.close();
});
