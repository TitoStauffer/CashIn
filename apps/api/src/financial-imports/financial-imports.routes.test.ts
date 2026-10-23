import assert from "node:assert/strict";
import test from "node:test";
import { createApp } from "../app.js";
import type { Database, QueryExecutor } from "../database.js";
import { hashToken } from "../auth/token.js";
import type { AuthRepository, AuthUser, PendingAccount, StoredUser } from "../auth/auth.types.js";
import { WalletsTestFixture } from "../wallets/wallets-test-fixture.js";
import { FinancialImportError } from "./financial-imports.errors.js";
import type {
  CreateFinancialImportInput,
  FinancialImportItem,
  FinancialImportParser,
  FinancialImportRepository,
  FinancialImportSession,
  ParsedFinancialImportItem,
  UpdateFinancialImportItemInput,
} from "./financial-imports.types.js";

const USER_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const USER_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CATEGORY_A = "11111111-1111-4111-8111-111111111111";
const SESSION_A = "a".repeat(43);
const SESSION_B = "b".repeat(43);

interface StoredSession extends FinancialImportSession {
  userId: string;
  walletId: string;
  items: FinancialImportItem[];
}

class MemoryFinancialImportRepository implements FinancialImportRepository {
  readonly sessions = new Map<string, StoredSession>();
  private nextSession = 1;
  private nextItem = 1;

  async createImport(userId: string, walletId: string, input: CreateFinancialImportInput): Promise<FinancialImportSession> {
    const id = `10000000-0000-4000-8000-${this.nextSession.toString().padStart(12, "0")}`;
    this.nextSession += 1;
    const now = new Date().toISOString();
    const session: StoredSession = {
      id,
      userId,
      walletId,
      format: input.format,
      fileName: input.fileName,
      fileSize: input.fileSize,
      fileHash: input.fileHash,
      status: "processing",
      summary: { total: 0, valid: 0, duplicate: 0, invalid: 0, uncategorized: 0, imported: 0 },
      canUndo: false,
      undoBlockedReason: "Somente importações concluídas podem ser desfeitas.",
      createdAt: now,
      updatedAt: now,
      confirmedAt: null,
      completedAt: null,
      failedAt: null,
      undoneAt: null,
      items: [],
    };
    this.sessions.set(id, session);
    return this.publicSession(session);
  }

  async savePreview(
    userId: string,
    walletId: string,
    importId: string,
    items: ParsedFinancialImportItem[],
  ): Promise<FinancialImportSession | null> {
    const session = this.mutableSession(userId, walletId, importId, "processing");
    if (!session) return null;
    const now = new Date().toISOString();
    session.items = items.map((item) => ({
      id: `20000000-0000-4000-8000-${(this.nextItem++).toString().padStart(12, "0")}`,
      sequence: item.sequence,
      date: item.date,
      description: item.description ?? null,
      amount: item.signedAmount.replace(/^-/, ""),
      type: item.type,
      categoryId: item.categoryId ?? null,
      subcategoryId: item.subcategoryId ?? null,
      validationStatus: item.validationStatus ?? "valid",
      errorMessage: item.errorMessage ?? null,
      createdAt: now,
      updatedAt: now,
    }));
    session.status = "preview";
    session.updatedAt = now;
    this.refreshSummary(session);
    return this.publicSession(session);
  }

  async listImports(_userId: string, walletId: string): Promise<FinancialImportSession[]> {
    return [...this.sessions.values()].filter((session) => session.walletId === walletId).map((session) => this.publicSession(session));
  }

  async getImport(_userId: string, walletId: string, importId: string): Promise<FinancialImportSession | null> {
    const session = this.sessions.get(importId);
    if (!session || session.walletId !== walletId) return null;
    return { ...this.publicSession(session), items: session.items.map((item) => ({ ...item })) };
  }

  async markFailed(userId: string, walletId: string, importId: string): Promise<void> {
    const session = this.mutableSession(userId, walletId, importId, "processing");
    if (!session) return;
    session.status = "failed";
    session.failedAt = new Date().toISOString();
    session.updatedAt = session.failedAt;
  }

  async updateItem(
    userId: string,
    walletId: string,
    importId: string,
    itemId: string,
    input: Required<UpdateFinancialImportItemInput>,
  ): Promise<FinancialImportItem | null> {
    const session = this.mutableSession(userId, walletId, importId, "preview");
    const item = session?.items.find((candidate) => candidate.id === itemId);
    if (!session || !item) return null;
    const transfer = input.type === "transfer";
    Object.assign(item, {
      date: input.date,
      description: input.description,
      type: input.type,
      categoryId: transfer ? null : input.categoryId,
      subcategoryId: transfer ? null : input.subcategoryId,
      validationStatus: transfer || input.categoryId === null ? "uncategorized" : "valid",
      errorMessage: transfer || input.categoryId === null ? "Classificação pendente." : null,
      updatedAt: new Date().toISOString(),
    });
    this.refreshSummary(session);
    return { ...item };
  }

  async confirmImport(userId: string, walletId: string, importId: string): Promise<FinancialImportSession | null> {
    const session = this.mutableSession(userId, walletId, importId, "preview");
    const valid = session?.items.filter((item) => item.validationStatus === "valid") ?? [];
    if (!session || valid.length === 0) return null;
    for (const item of valid) item.validationStatus = "imported";
    const now = new Date().toISOString();
    session.status = "completed";
    session.confirmedAt = now;
    session.completedAt = now;
    session.updatedAt = now;
    session.canUndo = true;
    session.undoBlockedReason = null;
    this.refreshSummary(session);
    return this.publicSession(session);
  }

  async undoImport(userId: string, walletId: string, importId: string): Promise<FinancialImportSession | null> {
    const session = this.mutableSession(userId, walletId, importId, "completed");
    if (!session || !session.canUndo) return null;
    for (const item of session.items) if (item.validationStatus === "imported") item.validationStatus = "valid";
    session.status = "undone";
    session.undoneAt = new Date().toISOString();
    session.updatedAt = session.undoneAt;
    session.canUndo = false;
    session.undoBlockedReason = "Somente importações concluídas podem ser desfeitas.";
    this.refreshSummary(session);
    return this.publicSession(session);
  }

  private mutableSession(userId: string, walletId: string, importId: string, status: StoredSession["status"]) {
    const session = this.sessions.get(importId);
    return session?.userId === userId && session.walletId === walletId && session.status === status ? session : null;
  }

  private refreshSummary(session: StoredSession): void {
    session.summary = {
      total: session.items.length,
      valid: session.items.filter((item) => item.validationStatus === "valid").length,
      duplicate: session.items.filter((item) => item.validationStatus === "duplicate").length,
      invalid: session.items.filter((item) => item.validationStatus === "invalid").length,
      uncategorized: session.items.filter((item) => item.validationStatus === "uncategorized").length,
      imported: session.items.filter((item) => item.validationStatus === "imported").length,
    };
  }

  private publicSession(session: StoredSession): FinancialImportSession {
    const { userId: _userId, walletId: _walletId, items: _items, ...result } = session;
    return structuredClone(result);
  }
}

class TestParser implements FinancialImportParser {
  constructor(
    private readonly shouldFail = false,
    private readonly itemCount = 2,
  ) {}

  async parse(): Promise<ParsedFinancialImportItem[]> {
    if (this.shouldFail) throw new FinancialImportError("Arquivo inválido para o teste.", 422);
    const baseItems: ParsedFinancialImportItem[] = [
      {
        sequence: 1,
        date: "2026-10-20",
        description: "Salário",
        signedAmount: "1000.00",
        type: "income",
        categoryId: CATEGORY_A,
      },
      {
        sequence: 2,
        date: "2026-10-21",
        description: "Mercado",
        signedAmount: "-125.50",
        type: "expense",
      },
    ];
    if (this.itemCount <= baseItems.length) return baseItems.slice(0, this.itemCount);
    return Array.from({ length: this.itemCount }, (_, index) => ({
      sequence: index + 1,
      date: "2026-10-20",
      signedAmount: "1.00",
      type: "income" as const,
      categoryId: CATEGORY_A,
    }));
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

function createTestApp(parser: FinancialImportParser = new TestParser()) {
  const repository = new MemoryFinancialImportRepository();
  const executor: QueryExecutor = { query: async <Row>() => ({ rows: [] as Row[], rowCount: 0 }) };
  const database: Database = { ...executor, transaction: async (work) => work(executor) };
  return {
    app: createApp(database, {
      authRepository: new SessionAuthRepository(),
      walletRepository: new WalletsTestFixture(),
      financialImportRepository: repository,
      financialImportParser: parser,
    }),
    repository,
  };
}

function authCookie(session = SESSION_A): string {
  return `cashin_session=${session}`;
}

async function upload(app: ReturnType<typeof createApp>, session = SESSION_A) {
  return app.inject({
    method: "POST",
    url: "/financial-imports",
    headers: {
      cookie: authCookie(session),
      "content-type": "application/octet-stream",
      "x-file-name": encodeURIComponent("extrato outubro.csv"),
      "x-file-format": "CSV",
    },
    payload: Buffer.from("date,description,amount\n2026-10-20,Salary,1000"),
  });
}

test("financial import routes require authentication and expose wallet-scoped preview/history", async () => {
  const { app } = createTestApp();
  assert.equal((await app.inject({ method: "GET", url: "/financial-imports" })).statusCode, 401);

  const created = await upload(app);
  assert.equal(created.statusCode, 201);
  assert.equal(created.json().fileName, "extrato outubro.csv");
  assert.equal(created.json().format, "csv");
  assert.equal(created.json().status, "preview");
  assert.deepEqual(created.json().summary, {
    total: 2, valid: 1, duplicate: 0, invalid: 0, uncategorized: 1, imported: 0,
  });
  assert.match(created.json().fileHash, /^[0-9a-f]{64}$/);

  const list = await app.inject({ method: "GET", url: "/financial-imports", headers: { cookie: authCookie() } });
  assert.equal(list.statusCode, 200);
  assert.equal(list.json().items.length, 1);
  const detail = await app.inject({
    method: "GET", url: `/financial-imports/${created.json().id}`, headers: { cookie: authCookie() },
  });
  assert.equal(detail.statusCode, 200);
  assert.equal(detail.json().items[1].amount, "125.50");
  assert.equal(detail.json().items[1].type, "expense");

  const hidden = await app.inject({
    method: "GET", url: `/financial-imports/${created.json().id}`, headers: { cookie: authCookie(SESSION_B) },
  });
  assert.equal(hidden.statusCode, 404);
  await app.close();
});

test("preview items can be classified, confirmed atomically, and undone", async () => {
  const { app } = createTestApp();
  const created = await upload(app);
  const detail = await app.inject({
    method: "GET", url: `/financial-imports/${created.json().id}`, headers: { cookie: authCookie() },
  });
  const secondItem = detail.json().items[1];
  const classified = await app.inject({
    method: "PATCH",
    url: `/financial-imports/${created.json().id}/items/${secondItem.id}`,
    headers: { cookie: authCookie() },
    payload: {
      date: "2026-10-21",
      description: "Mercado do bairro",
      type: "expense",
      categoryId: CATEGORY_A,
      subcategoryId: null,
    },
  });
  assert.equal(classified.statusCode, 200);
  assert.equal(classified.json().validationStatus, "valid");

  const confirmed = await app.inject({
    method: "POST", url: `/financial-imports/${created.json().id}/confirm`, headers: { cookie: authCookie() },
  });
  assert.equal(confirmed.statusCode, 200);
  assert.equal(confirmed.json().status, "completed");
  assert.equal(confirmed.json().summary.imported, 2);
  assert.equal(confirmed.json().canUndo, true);

  const editAfterConfirmation = await app.inject({
    method: "PATCH",
    url: `/financial-imports/${created.json().id}/items/${secondItem.id}`,
    headers: { cookie: authCookie() },
    payload: { date: "2026-10-21", type: "expense", categoryId: CATEGORY_A },
  });
  assert.equal(editAfterConfirmation.statusCode, 409);

  const undone = await app.inject({
    method: "POST", url: `/financial-imports/${created.json().id}/undo`, headers: { cookie: authCookie() },
  });
  assert.equal(undone.statusCode, 200);
  assert.equal(undone.json().status, "undone");
  assert.equal(undone.json().summary.imported, 0);
  assert.equal(undone.json().canUndo, false);
  await app.close();
});

test("upload failures are safe, validated, and retained as failed history", async () => {
  const { app } = createTestApp(new TestParser(true));
  const failed = await upload(app);
  assert.equal(failed.statusCode, 422);
  assert.equal(failed.json().message, "Arquivo inválido para o teste.");
  const list = await app.inject({ method: "GET", url: "/financial-imports", headers: { cookie: authCookie() } });
  assert.equal(list.json().items[0].status, "failed");

  const wrongExtension = await app.inject({
    method: "POST",
    url: "/financial-imports",
    headers: {
      cookie: authCookie(),
      "content-type": "application/octet-stream",
      "x-file-name": "statement.txt",
      "x-file-format": "csv",
    },
    payload: Buffer.from("content"),
  });
  assert.equal(wrongExtension.statusCode, 400);

  const invalidDate = await app.inject({
    method: "PATCH",
    url: "/financial-imports/10000000-0000-4000-8000-000000000001/items/20000000-0000-4000-8000-000000000001",
    headers: { cookie: authCookie() },
    payload: { date: "2026-02-30", type: "income", categoryId: CATEGORY_A },
  });
  assert.equal(invalidDate.statusCode, 400);
  await app.close();
});

test("upload enforces the 10 MB and 10,000 movement limits", async () => {
  const tooMany = createTestApp(new TestParser(false, 10_001));
  const tooManyResponse = await upload(tooMany.app);
  assert.equal(tooManyResponse.statusCode, 413);
  assert.equal(tooManyResponse.json().message, "O arquivo deve ter no máximo 10.000 movimentações.");
  const retained = await tooMany.app.inject({
    method: "GET",
    url: "/financial-imports",
    headers: { cookie: authCookie() },
  });
  assert.equal(retained.json().items[0].status, "failed");
  await tooMany.app.close();

  const oversized = createTestApp();
  const oversizedResponse = await oversized.app.inject({
    method: "POST",
    url: "/financial-imports",
    headers: {
      cookie: authCookie(),
      "content-type": "application/octet-stream",
      "x-file-name": "statement.csv",
      "x-file-format": "csv",
    },
    payload: Buffer.alloc(10 * 1024 * 1024 + 1, "a"),
  });
  assert.equal(oversizedResponse.statusCode, 413);
  await oversized.app.close();
});
