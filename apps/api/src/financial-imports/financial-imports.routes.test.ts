import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
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
      failureMessage: null,
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
      date: item.date ?? "",
      description: item.description ?? null,
      amount: (item.signedAmount ?? "0.00").replace(/^-/, ""),
      type: item.type,
      categoryId: item.categoryId ?? null,
      subcategoryId: item.subcategoryId ?? null,
      validationStatus: item.validationStatus ?? "valid",
      errorMessage: item.errorMessage ?? null,
      canEdit: item.validationStatus !== "duplicate"
        && (item.validationStatus !== "invalid" || item.isRepairable === true),
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

  async markFailed(userId: string, walletId: string, importId: string, failureMessage: string): Promise<void> {
    const session = this.mutableSession(userId, walletId, importId, "processing");
    if (!session) return;
    session.status = "failed";
    session.failureMessage = failureMessage;
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
    if (!session || !item || !item.canEdit) return null;
    const transfer = input.type === "transfer";
    Object.assign(item, {
      date: input.date,
      description: input.description,
      type: input.type,
      categoryId: transfer ? null : input.categoryId,
      subcategoryId: transfer ? null : input.subcategoryId,
      validationStatus: transfer || input.categoryId === null ? "uncategorized" : "valid",
      errorMessage: transfer || input.categoryId === null ? "Classificação pendente." : null,
      canEdit: true,
      updatedAt: new Date().toISOString(),
    });
    this.refreshSummary(session);
    return { ...item };
  }

  async confirmImport(userId: string, walletId: string, importId: string): Promise<FinancialImportSession | null> {
    const session = this.mutableSession(userId, walletId, importId, "preview");
    const valid = session?.items.filter((item) => item.validationStatus === "valid") ?? [];
    if (!session || valid.length === 0) return null;
    for (const item of valid) {
      item.validationStatus = "imported";
      item.canEdit = false;
    }
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
    for (const item of session.items) {
      if (item.validationStatus !== "imported") continue;
      item.validationStatus = "uncategorized";
      item.categoryId = null;
      item.subcategoryId = null;
      item.errorMessage = "Selecione uma categoria para importar a movimentação.";
      item.canEdit = true;
    }
    session.status = "undone";
    session.undoneAt = new Date().toISOString();
    session.updatedAt = session.undoneAt;
    session.canUndo = false;
    session.undoBlockedReason = "Somente importações concluídas podem ser desfeitas.";
    this.refreshSummary(session);
    return this.publicSession(session);
  }

  async discardImport(userId: string, walletId: string, importId: string): Promise<FinancialImportSession | null> {
    const session = this.mutableSession(userId, walletId, importId, "preview");
    if (!session) return null;
    for (const item of session.items) {
      item.categoryId = null;
      item.subcategoryId = null;
      if (item.validationStatus === "valid") {
        item.validationStatus = "uncategorized";
        item.errorMessage = "A prévia foi descartada antes da confirmação.";
      }
      item.canEdit = false;
    }
    const now = new Date().toISOString();
    session.status = "failed";
    session.failureMessage = "Importação descartada pelo usuário.";
    session.failedAt = now;
    session.updatedAt = now;
    session.canUndo = false;
    session.undoBlockedReason = "Somente importações concluídas podem ser desfeitas.";
    this.refreshSummary(session);
    return { ...this.publicSession(session), items: session.items.map((item) => ({ ...item })) };
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

class InvalidItemsParser implements FinancialImportParser {
  async parse(): Promise<ParsedFinancialImportItem[]> {
    return [
      {
        sequence: 1,
        date: "2026-10-20",
        signedAmount: "100.00",
        type: "income",
        categoryId: CATEGORY_A,
      },
      {
        sequence: 2,
        date: "2026-02-30",
        signedAmount: "10.00",
        type: "expense",
        categoryId: CATEGORY_A,
      },
      {
        sequence: 3,
        date: "2026-10-21",
        signedAmount: "0.00",
        type: "expense",
        categoryId: CATEGORY_A,
      },
      {
        sequence: 1,
        date: "2026-10-22",
        signedAmount: "5.00",
        type: "expense",
        categoryId: CATEGORY_A,
      },
    ];
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

const fixtures = fileURLToPath(new URL("./fixtures/", import.meta.url));

function createTestApp(parser: FinancialImportParser | null = new TestParser()) {
  const repository = new MemoryFinancialImportRepository();
  const executor: QueryExecutor = { query: async <Row>() => ({ rows: [] as Row[], rowCount: 0 }) };
  const database: Database = { ...executor, transaction: async (work) => work(executor) };
  return {
    app: createApp(database, {
      authRepository: new SessionAuthRepository(),
      walletRepository: new WalletsTestFixture(),
      financialImportRepository: repository,
      financialImportParser: parser ?? undefined,
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

test("default API parser creates an editable preview from an OFX bank statement", async () => {
  const { app } = createTestApp(null);
  const response = await app.inject({
    method: "POST",
    url: "/financial-imports",
    headers: {
      cookie: authCookie(),
      "content-type": "application/octet-stream",
      "x-file-name": encodeURIComponent("extrato.ofx"),
      "x-file-format": "ofx",
    },
    payload: await readFile(`${fixtures}valid-bank.ofx`),
  });

  assert.equal(response.statusCode, 201);
  assert.equal(response.json().status, "preview");
  const detail = await app.inject({
    method: "GET",
    url: `/financial-imports/${response.json().id}`,
    headers: { cookie: authCookie() },
  });
  assert.deepEqual(detail.json().items.map((item: FinancialImportItem) => ({
    date: item.date,
    description: item.description,
    amount: item.amount,
    type: item.type,
    status: item.validationStatus,
  })), [
    { date: "2026-10-20", description: "Salário — Pagamento mensal", amount: "1500.50", type: "income", status: "uncategorized" },
    { date: "2026-10-21", description: "Mercado & Companhia", amount: "125.50", type: "expense", status: "uncategorized" },
    { date: "2026-10-22", description: "Transferência entre contas", amount: "300.00", type: "transfer", status: "uncategorized" },
  ]);
  await app.close();
});

test("default API parser preserves literal CDATA content in the persisted preview", async () => {
  const { app } = createTestApp(null);
  const response = await app.inject({
    method: "POST",
    url: "/financial-imports",
    headers: {
      cookie: authCookie(),
      "content-type": "application/octet-stream",
      "x-file-name": encodeURIComponent("extrato-xml.ofx"),
      "x-file-format": "ofx",
    },
    payload: await readFile(`${fixtures}valid-xml.ofx`),
  });

  assert.equal(response.statusCode, 201);
  const detail = await app.inject({
    method: "GET",
    url: `/financial-imports/${response.json().id}`,
    headers: { cookie: authCookie() },
  });
  assert.equal(detail.statusCode, 200);
  assert.equal(detail.json().items[0].description, "Padaria & Filial <b>Centro</b> &amp;");
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

test("preview can be discarded without creating movements and remains wallet scoped", async () => {
  const { app } = createTestApp();
  const created = await upload(app);

  const hidden = await app.inject({
    method: "DELETE",
    url: `/financial-imports/${created.json().id}`,
    headers: { cookie: authCookie(SESSION_B) },
  });
  assert.equal(hidden.statusCode, 409);

  const discarded = await app.inject({
    method: "DELETE",
    url: `/financial-imports/${created.json().id}`,
    headers: { cookie: authCookie() },
  });
  assert.equal(discarded.statusCode, 200);
  assert.equal(discarded.json().status, "failed");
  assert.equal(discarded.json().failureMessage, "Importação descartada pelo usuário.");
  assert.equal(discarded.json().summary.valid, 0);
  assert.equal(discarded.json().summary.uncategorized, 2);
  assert.ok(discarded.json().items.every((item: FinancialImportItem) => item.categoryId === null));

  const repeated = await app.inject({
    method: "DELETE",
    url: `/financial-imports/${created.json().id}`,
    headers: { cookie: authCookie() },
  });
  assert.equal(repeated.statusCode, 409);
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

test("persisted import failures respect the UTF-8 database limit", async () => {
  const parser: FinancialImportParser = {
    parse: async () => {
      throw new FinancialImportError(`Falha ${"界".repeat(500)}`, 422);
    },
  };
  const { app } = createTestApp(parser);
  const failed = await upload(app);
  assert.equal(failed.statusCode, 422);

  const list = await app.inject({ method: "GET", url: "/financial-imports", headers: { cookie: authCookie() } });
  const failureMessage = list.json().items[0].failureMessage as string;
  assert.ok(Buffer.byteLength(failureMessage, "utf8") <= 1_000);
  assert.match(failureMessage, /^Falha /);
  await app.close();
});

test("upload and preview edits enforce UTF-8 byte limits before persistence", async () => {
  const { app } = createTestApp();
  const fileNameAtLimit = `${"界".repeat(168)}${"á".repeat(2)}.csv`;
  assert.equal(Buffer.byteLength(fileNameAtLimit, "utf8"), 512);
  const acceptedUpload = await app.inject({
    method: "POST",
    url: "/financial-imports",
    headers: {
      cookie: authCookie(),
      "content-type": "application/octet-stream",
      "x-file-name": encodeURIComponent(fileNameAtLimit),
      "x-file-format": "csv",
    },
    payload: Buffer.from("content"),
  });
  assert.equal(acceptedUpload.statusCode, 201);
  assert.equal(acceptedUpload.json().fileName, fileNameAtLimit);

  const oversizedFileName = `${"界".repeat(169)}á.csv`;
  assert.equal(Buffer.byteLength(oversizedFileName, "utf8"), 513);
  const rejectedUpload = await app.inject({
    method: "POST",
    url: "/financial-imports",
    headers: {
      cookie: authCookie(),
      "content-type": "application/octet-stream",
      "x-file-name": encodeURIComponent(oversizedFileName),
      "x-file-format": "csv",
    },
    payload: Buffer.from("content"),
  });
  assert.equal(rejectedUpload.statusCode, 400);
  assert.equal(rejectedUpload.json().message, "O nome do arquivo é inválido.");

  const detail = await app.inject({
    method: "GET",
    url: `/financial-imports/${acceptedUpload.json().id}`,
    headers: { cookie: authCookie() },
  });
  const itemId = detail.json().items[0].id;
  const descriptionAtLimit = `${"界".repeat(1_332)}${"á".repeat(2)}`;
  assert.equal(Buffer.byteLength(descriptionAtLimit, "utf8"), 4_000);
  const acceptedEdit = await app.inject({
    method: "PATCH",
    url: `/financial-imports/${acceptedUpload.json().id}/items/${itemId}`,
    headers: { cookie: authCookie() },
    payload: {
      date: "2026-10-20",
      description: descriptionAtLimit,
      type: "income",
      categoryId: CATEGORY_A,
    },
  });
  assert.equal(acceptedEdit.statusCode, 200);
  assert.equal(acceptedEdit.json().description, descriptionAtLimit);

  const oversizedDescription = `${descriptionAtLimit}a`;
  assert.equal(Buffer.byteLength(oversizedDescription, "utf8"), 4_001);
  const rejectedEdit = await app.inject({
    method: "PATCH",
    url: `/financial-imports/${acceptedUpload.json().id}/items/${itemId}`,
    headers: { cookie: authCookie() },
    payload: {
      date: "2026-10-20",
      description: oversizedDescription,
      type: "income",
      categoryId: CATEGORY_A,
    },
  });
  assert.equal(rejectedEdit.statusCode, 400);
  assert.equal(rejectedEdit.json().message, "A descrição da movimentação deve ter no máximo 4.000 bytes.");

  const unchangedDetail = await app.inject({
    method: "GET",
    url: `/financial-imports/${acceptedUpload.json().id}`,
    headers: { cookie: authCookie() },
  });
  assert.equal(unchangedDetail.json().items[0].description, descriptionAtLimit);
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
  assert.deepEqual(oversizedResponse.json(), { message: "O arquivo deve ter no máximo 10 MB." });
  await oversized.app.close();
});

test("impossible dates, zero values, and repeated source sequences remain in preview without blocking valid items", async () => {
  const { app } = createTestApp(new InvalidItemsParser());
  const created = await upload(app);
  assert.equal(created.statusCode, 201);
  assert.deepEqual(created.json().summary, {
    total: 4,
    valid: 1,
    duplicate: 0,
    invalid: 3,
    uncategorized: 0,
    imported: 0,
  });

  const detail = await app.inject({
    method: "GET",
    url: `/financial-imports/${created.json().id}`,
    headers: { cookie: authCookie() },
  });
  assert.equal(detail.statusCode, 200);
  assert.deepEqual(detail.json().items.map((item: FinancialImportItem) => item.sequence), [1, 2, 3, 4]);
  assert.equal(detail.json().items[1].date, "");
  assert.match(detail.json().items[1].errorMessage, /data da movimentação é inválida/i);
  assert.equal(detail.json().items[2].amount, "0.00");
  assert.match(detail.json().items[2].errorMessage, /diferente de zero/i);
  assert.match(detail.json().items[3].errorMessage, /sequência original.+duplicada/i);

  const confirmed = await app.inject({
    method: "POST",
    url: `/financial-imports/${created.json().id}/confirm`,
    headers: { cookie: authCookie() },
  });
  assert.equal(confirmed.statusCode, 200);
  assert.equal(confirmed.json().summary.imported, 1);
  assert.equal(confirmed.json().summary.invalid, 3);

  const afterConfirmation = await app.inject({
    method: "GET",
    url: `/financial-imports/${created.json().id}`,
    headers: { cookie: authCookie() },
  });
  assert.equal(afterConfirmation.json().items.filter((item: FinancialImportItem) => item.validationStatus === "invalid").length, 3);
  await app.close();
});
