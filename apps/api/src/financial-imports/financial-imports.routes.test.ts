import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createApp } from "../app.js";
import { DefaultFinancialImportParser } from "./financial-imports.parser.js";
import type { Database, QueryExecutor } from "../database.js";
import { hashToken } from "../auth/token.js";
import type { AuthRepository, AuthUser, PendingAccount, StoredUser } from "../auth/auth.types.js";
import { WalletsTestFixture } from "../wallets/wallets-test-fixture.js";
import { FinancialImportError } from "./financial-imports.errors.js";
import {
  FINANCIAL_IMPORT_PROCESSING_TIMEOUT_MINUTES,
  MAX_FINANCIAL_IMPORT_FILE_SIZE,
} from "./financial-imports.service.js";
import type {
  CreateCsvMappingInput,
  CsvMapping,
  CreateFinancialImportInput,
  FinancialCategorizationRule,
  FinancialCategorizationRuleInput,
  FinancialCategorizationRulesRepository,
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
const CSV_MAPPING_HEADER = encodeURIComponent(JSON.stringify({
  delimiter: ",", encoding: "utf-8", hasHeader: true, dateFormat: "yyyy-MM-dd", numberFormat: "en-US",
  columns: { date: 0, description: 1, amount: 2, credit: null, debit: null, externalId: null },
}));

// The importer is derived from the stored session and the reader, exactly as the database does it,
// so the fake cannot answer "who imported" more generously than production.
interface StoredSession extends Omit<FinancialImportSession, "importedBy"> {
  userId: string;
  walletId: string;
  items: FinancialImportItem[];
}

const USER_EMAILS: Record<string, string> = {
  [USER_A]: "usuario-a@example.test",
  [USER_B]: "usuario-b@example.test",
};

class MemoryFinancialImportRepository implements FinancialImportRepository {
  readonly sessions = new Map<string, StoredSession>();
  readonly csvMappings = new Map<string, CsvMapping & { userId: string; walletId: string }>();
  private nextSession = 1;
  private nextItem = 1;
  private nextMapping = 1;

  async listCsvMappings(userId: string, walletId: string): Promise<CsvMapping[]> {
    return [...this.csvMappings.values()].filter((mapping) => mapping.userId === userId && mapping.walletId === walletId);
  }

  async getCsvMapping(userId: string, walletId: string, mappingId: string): Promise<CsvMapping | null> {
    const mapping = this.csvMappings.get(mappingId);
    return mapping?.userId === userId && mapping.walletId === walletId ? mapping : null;
  }

  async createCsvMapping(userId: string, walletId: string, input: CreateCsvMappingInput): Promise<CsvMapping> {
    const now = new Date().toISOString();
    const mapping = { id: `30000000-0000-4000-8000-${(this.nextMapping++).toString().padStart(12, "0")}`, ...input, userId, walletId, createdAt: now, updatedAt: now };
    this.csvMappings.set(mapping.id, mapping);
    return mapping;
  }

  async updateCsvMapping(userId: string, walletId: string, mappingId: string, input: CreateCsvMappingInput): Promise<CsvMapping | null> {
    const mapping = this.csvMappings.get(mappingId);
    if (!mapping || mapping.userId !== userId || mapping.walletId !== walletId) return null;
    Object.assign(mapping, input, { updatedAt: new Date().toISOString() });
    return mapping;
  }

  readonly creditCards = new Map<string, { walletId: string; card: { id: string; closingDay: number; dueDay: number } }>();

  async findImportCreditCard(walletId: string, creditCardId: string) {
    const stored = this.creditCards.get(creditCardId);
    return stored?.walletId === walletId ? stored.card : null;
  }

  async createImport(userId: string, walletId: string, input: CreateFinancialImportInput): Promise<FinancialImportSession> {
    const id = `10000000-0000-4000-8000-${this.nextSession.toString().padStart(12, "0")}`;
    this.nextSession += 1;
    const now = new Date().toISOString();
    const session: StoredSession = {
      id,
      userId,
      walletId,
      format: input.format,
      kind: input.creditCardId ? "credit_card_statement" : "bank_statement",
      creditCardId: input.creditCardId ?? null,
      creditCardName: input.creditCardId ? "Cartão de teste" : null,
      creditCardClosingDay: input.creditCardId ? 10 : null,
      creditCardDueDay: input.creditCardId ? 20 : null,
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
    return this.publicSession(session, userId);
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
      categorizationSource: item.categorizationSource ?? null,
      createdAt: now,
      updatedAt: now,
    }));
    session.status = "preview";
    session.updatedAt = now;
    this.refreshSummary(session);
    return this.publicSession(session, userId);
  }

  async listImports(userId: string, walletId: string): Promise<FinancialImportSession[]> {
    return [...this.sessions.values()].filter((session) => session.walletId === walletId).map((session) => this.publicSession(session, userId));
  }

  async getImport(userId: string, walletId: string, importId: string): Promise<FinancialImportSession | null> {
    const session = this.sessions.get(importId);
    if (!session || session.walletId !== walletId) return null;
    return { ...this.publicSession(session, userId), items: session.items.map((item) => ({ ...item })) };
  }

  async markFailed(userId: string, walletId: string, importId: string, failureMessage: string): Promise<void> {
    const session = this.mutableSession(userId, walletId, importId, "processing");
    if (!session) return;
    session.status = "failed";
    session.failureMessage = failureMessage;
    session.failedAt = new Date().toISOString();
    session.updatedAt = session.failedAt;
  }

  // Mirrors the SQL: only sessions of this wallet still in `processing` and older than the window.
  async expireStaleImports(walletId: string, olderThanMinutes: number, failureMessage: string): Promise<number> {
    const threshold = Date.now() - olderThanMinutes * 60_000;
    let expired = 0;
    for (const session of this.sessions.values()) {
      if (session.walletId !== walletId || session.status !== "processing") continue;
      if (Date.parse(session.createdAt) >= threshold) continue;
      const now = new Date().toISOString();
      session.status = "failed";
      session.failureMessage = failureMessage;
      session.failedAt = now;
      session.updatedAt = now;
      expired += 1;
    }
    return expired;
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
    return this.publicSession(session, userId);
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
    return this.publicSession(session, userId);
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
    return { ...this.publicSession(session, userId), items: session.items.map((item) => ({ ...item })) };
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

  private publicSession(session: StoredSession, viewerUserId: string): FinancialImportSession {
    const { userId, walletId: _walletId, items: _items, ...result } = session;
    const isCurrentUser = userId === viewerUserId;
    return structuredClone({
      ...result,
      importedBy: { userId, email: isCurrentUser ? USER_EMAILS[userId] ?? null : null, isCurrentUser },
    });
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

type StoredRule = FinancialCategorizationRule & { walletId: string; normalizedDescription: string };

class MemoryCategorizationRulesRepository implements FinancialCategorizationRulesRepository {
  readonly rules = new Map<string, StoredRule>();
  private nextRule = 1;

  async listRules(walletId: string): Promise<FinancialCategorizationRule[]> {
    return [...this.rules.values()].filter((rule) => rule.walletId === walletId).map((rule) => this.publicRule(rule));
  }

  async createRule(_userId: string, walletId: string, input: FinancialCategorizationRuleInput & { normalizedDescription: string }) {
    if (input.categoryId !== CATEGORY_A) return null;
    const duplicate = [...this.rules.values()].some((rule) => rule.walletId === walletId
      && rule.type === input.type && rule.normalizedDescription === input.normalizedDescription);
    if (duplicate) throw Object.assign(new Error("duplicate"), { code: "23505" });
    const now = new Date().toISOString();
    const rule: StoredRule = {
      id: `40000000-0000-4000-8000-${(this.nextRule++).toString().padStart(12, "0")}`,
      walletId,
      type: input.type,
      description: input.description,
      normalizedDescription: input.normalizedDescription,
      categoryId: input.categoryId,
      categoryName: "Alimentação",
      subcategoryId: input.subcategoryId ?? null,
      subcategoryName: null,
      isActive: input.isActive ?? true,
      isStale: false,
      createdAt: now,
      updatedAt: now,
    };
    this.rules.set(rule.id, rule);
    return this.publicRule(rule);
  }

  async updateRule(walletId: string, ruleId: string, input: FinancialCategorizationRuleInput & { normalizedDescription: string }) {
    const rule = this.rules.get(ruleId);
    if (!rule || rule.walletId !== walletId || input.categoryId !== CATEGORY_A) return null;
    const conflict = [...this.rules.values()].some((other) => other.id !== ruleId && other.walletId === walletId
      && other.type === input.type && other.normalizedDescription === input.normalizedDescription);
    if (conflict) throw Object.assign(new Error("duplicate"), { code: "23505" });
    Object.assign(rule, input, { isActive: input.isActive ?? true, updatedAt: new Date().toISOString() });
    return this.publicRule(rule);
  }

  async deleteRule(walletId: string, ruleId: string): Promise<boolean> {
    const rule = this.rules.get(ruleId);
    if (!rule || rule.walletId !== walletId) return false;
    return this.rules.delete(ruleId);
  }

  private publicRule(rule: StoredRule): FinancialCategorizationRule {
    const { walletId: _walletId, normalizedDescription: _normalizedDescription, ...result } = rule;
    return { ...result };
  }
}

function createTestApp(parser: FinancialImportParser | null = new TestParser()) {
  const repository = new MemoryFinancialImportRepository();
  const rulesRepository = new MemoryCategorizationRulesRepository();
  const executor: QueryExecutor = { query: async <Row>() => ({ rows: [] as Row[], rowCount: 0 }) };
  const database: Database = { ...executor, transaction: async (work) => work(executor) };
  return {
    app: createApp(database, {
      authRepository: new SessionAuthRepository(),
      walletRepository: new WalletsTestFixture(),
      financialImportRepository: repository,
      financialCategorizationRulesRepository: rulesRepository,
      financialImportParser: parser ?? undefined,
    }),
    repository,
    rulesRepository,
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
      "x-csv-mapping": CSV_MAPPING_HEADER,
    },
    payload: Buffer.from("date,description,amount\n2026-10-20,Salary,1000"),
  });
}

test("financial import routes require authentication and expose wallet-scoped preview/history", async () => {
  const { app } = createTestApp();
  assert.equal((await app.inject({ method: "GET", url: "/financial-imports" })).statusCode, 401);

  const created = await upload(app);
  assert.equal(created.statusCode, 201, created.body);
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
  assert.equal(
    detail.json().items[0].description,
    "Padaria & Filial </STMTTRN> Centro <STMTTRN> <STMTRS> </STMTRS> <CCACCTFROM> <CCSTMTTRNRS> &amp;",
  );
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
      "x-csv-mapping": CSV_MAPPING_HEADER,
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
      "x-csv-mapping": CSV_MAPPING_HEADER,
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

// The request below is larger than the upload accepts, so the answer says where it was stopped: a
// 413 means the API read the file and only then looked at who was sending it, while 401 and 404 mean
// authorization came first and the payload was never buffered.
test("an unauthorized upload is refused before the file is read", async () => {
  const { app, repository } = createTestApp();
  const oversized = Buffer.alloc(MAX_FINANCIAL_IMPORT_FILE_SIZE + 1_024, 0x41);
  const uploadHeaders = {
    "content-type": "application/octet-stream",
    "x-file-name": encodeURIComponent("extrato.csv"),
    "x-file-format": "csv",
    "x-csv-mapping": CSV_MAPPING_HEADER,
  };

  const anonymous = await app.inject({ method: "POST", url: "/financial-imports", headers: uploadHeaders, payload: oversized });
  assert.equal(anonymous.statusCode, 401);
  assert.equal(anonymous.json().message, "Autenticação necessária.");

  const otherWallet = await app.inject({
    method: "POST",
    url: "/financial-imports",
    headers: { ...uploadHeaders, cookie: authCookie(), "x-wallet-id": USER_B },
    payload: oversized,
  });
  assert.equal(otherWallet.statusCode, 404);

  const anonymousInspection = await app.inject({
    method: "POST",
    url: "/financial-imports/csv/inspect",
    headers: { "content-type": "application/octet-stream" },
    payload: oversized,
  });
  assert.equal(anonymousInspection.statusCode, 401);

  // Nothing about the refused requests was recorded, and the limit still applies once authorized.
  assert.equal(repository.sessions.size, 0);
  const authorized = await app.inject({
    method: "POST",
    url: "/financial-imports",
    headers: { ...uploadHeaders, cookie: authCookie() },
    payload: oversized,
  });
  assert.equal(authorized.statusCode, 413);
  assert.equal(authorized.json().message, "O arquivo deve ter no máximo 10 MB.");
  await app.close();
});

// The history is the audit trail, so it has to say who imported each file.
test("the import history attributes each import to the member who sent it", async () => {
  const { app } = createTestApp();
  const created = (await upload(app)).json() as FinancialImportSession;
  assert.deepEqual(created.importedBy, { userId: USER_A, email: "usuario-a@example.test", isCurrentUser: true });

  const list = await app.inject({ method: "GET", url: "/financial-imports", headers: { cookie: authCookie() } });
  assert.deepEqual(
    (list.json() as { items: FinancialImportSession[] }).items.map((session) => session.importedBy),
    [{ userId: USER_A, email: "usuario-a@example.test", isCurrentUser: true }],
  );
  await app.close();
});

// An upload that died between its session row and its preview has nothing left to advance it. The
// history closes it out, so the import stops being one that never ends and says why it failed.
test("an import interrupted before its preview expires into a traceable failure", async () => {
  const { app, repository } = createTestApp();
  const created = (await upload(app)).json() as FinancialImportSession;
  const stuck = repository.sessions.get(created.id)!;
  stuck.status = "processing";
  stuck.createdAt = new Date(Date.now() - (FINANCIAL_IMPORT_PROCESSING_TIMEOUT_MINUTES + 5) * 60_000).toISOString();

  const list = await app.inject({ method: "GET", url: "/financial-imports", headers: { cookie: authCookie() } });
  const session = (list.json() as { items: FinancialImportSession[] }).items[0]!;
  assert.equal(session.status, "failed");
  assert.equal(session.failureMessage, "A importação foi interrompida antes de gerar a prévia. Envie o arquivo novamente.");
  assert.ok(session.failedAt, "an expired import must record when it was closed out");
  await app.close();
});

test("an import still inside the processing window is left alone", async () => {
  const { app, repository } = createTestApp();
  const created = (await upload(app)).json() as FinancialImportSession;
  repository.sessions.get(created.id)!.status = "processing";

  const list = await app.inject({ method: "GET", url: "/financial-imports", headers: { cookie: authCookie() } });
  assert.equal((list.json() as { items: FinancialImportSession[] }).items[0]!.status, "processing");
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

  const csv = createTestApp(null);
  const excessiveCsv = Buffer.from([
    "Data;Descrição;Valor",
    ...Array.from({ length: 10_001 }, (_value, index) => `31/10/2026;Linha ${index + 1};1,00`),
  ].join("\n"));
  const excessiveInspection = await csv.app.inject({
    method: "POST",
    url: "/financial-imports/csv/inspect",
    headers: { cookie: authCookie(), "content-type": "application/octet-stream" },
    payload: excessiveCsv,
  });
  assert.equal(excessiveInspection.statusCode, 413);
  assert.equal(excessiveInspection.json().message, "O arquivo deve ter no máximo 10.000 movimentações.");
  const excessiveUpload = await csv.app.inject({
    method: "POST",
    url: "/financial-imports",
    headers: {
      cookie: authCookie(),
      "content-type": "application/octet-stream",
      "x-file-name": "oversized.csv",
      "x-file-format": "csv",
      "x-csv-mapping": encodeURIComponent(JSON.stringify({
        delimiter: ";", encoding: "utf-8", hasHeader: true, dateFormat: "dd/MM/yyyy", numberFormat: "pt-BR",
        columns: { date: 0, description: 1, amount: 2, credit: null, debit: null, externalId: null },
      })),
    },
    payload: excessiveCsv,
  });
  assert.equal(excessiveUpload.statusCode, 413);
  assert.equal(excessiveUpload.json().message, "O arquivo deve ter no máximo 10.000 movimentações.");

  const excessiveColumns = Buffer.from(
    `${Array.from({ length: 100 }, (_value, index) => `column-${index + 1}`).join(";")};"trailing malformed`,
  );
  const excessiveColumnsInspection = await csv.app.inject({
    method: "POST",
    url: "/financial-imports/csv/inspect",
    headers: { cookie: authCookie(), "content-type": "application/octet-stream" },
    payload: excessiveColumns,
  });
  assert.equal(excessiveColumnsInspection.statusCode, 422);
  assert.equal(excessiveColumnsInspection.json().message, "O arquivo CSV deve ter no máximo 100 colunas.");
  const excessiveColumnsUpload = await csv.app.inject({
    method: "POST",
    url: "/financial-imports",
    headers: {
      cookie: authCookie(),
      "content-type": "application/octet-stream",
      "x-file-name": "too-many-columns.csv",
      "x-file-format": "csv",
      "x-csv-mapping": encodeURIComponent(JSON.stringify({
        delimiter: ";", encoding: "utf-8", hasHeader: false, dateFormat: "yyyy-MM-dd", numberFormat: "pt-BR",
        columns: { date: 0, description: 1, amount: 2, credit: null, debit: null, externalId: null },
      })),
    },
    payload: excessiveColumns,
  });
  assert.equal(excessiveColumnsUpload.statusCode, 422);
  assert.equal(excessiveColumnsUpload.json().message, "O arquivo CSV deve ter no máximo 100 colunas.");
  await csv.app.close();

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
  assert.equal(created.statusCode, 201, created.body);
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

test("CSV inspection and reusable mappings remain scoped to the current wallet", async () => {
  const { app } = createTestApp(null);
  const inspection = await app.inject({
    method: "POST", url: "/financial-imports/csv/inspect",
    headers: { cookie: authCookie(), "content-type": "application/octet-stream" },
    payload: Buffer.from("Data;Descrição;Valor\n31/10/2026;Mercado;-10,25\n"),
  });
  assert.equal(inspection.statusCode, 200);
  assert.equal(inspection.json().detectedConfiguration.delimiter, ";");
  assert.deepEqual(inspection.json().suggestedMapping, { date: 0, description: 1, amount: 2, credit: null, debit: null, externalId: null });

  const incompleteColumns = { date: 0, description: null, amount: null, credit: null, debit: null, externalId: null };
  const wrongInspectionConfiguration = {
    delimiter: ",", encoding: "utf-8", hasHeader: true, dateFormat: "yyyy-MM-dd", numberFormat: "en-US",
    columns: incompleteColumns,
  };
  const wrongInspection = await app.inject({
    method: "POST", url: "/financial-imports/csv/inspect",
    headers: { cookie: authCookie(), "content-type": "application/octet-stream", "x-csv-mapping": encodeURIComponent(JSON.stringify(wrongInspectionConfiguration)) },
    payload: Buffer.from("Data;Descrição;Valor\n31/10/2026;Mercado;-10,25\n"),
  });
  assert.equal(wrongInspection.statusCode, 200);
  assert.equal(wrongInspection.json().columns.length, 1);
  const correctedInspection = await app.inject({
    method: "POST", url: "/financial-imports/csv/inspect",
    headers: { cookie: authCookie(), "content-type": "application/octet-stream", "x-csv-mapping": encodeURIComponent(JSON.stringify({ ...wrongInspectionConfiguration, delimiter: ";", dateFormat: "dd/MM/yyyy", numberFormat: "pt-BR" })) },
    payload: Buffer.from("Data;Descrição;Valor\n31/10/2026;Mercado;-10,25\n"),
  });
  assert.equal(correctedInspection.statusCode, 200);
  assert.equal(correctedInspection.json().columns.length, 3);
  assert.deepEqual(correctedInspection.json().detectedConfiguration, {
    delimiter: ";", encoding: "utf-8", hasHeader: true, dateFormat: "dd/MM/yyyy", numberFormat: "pt-BR",
  });

  const configuration = {
    delimiter: ";", encoding: "utf-8", hasHeader: true, dateFormat: "dd/MM/yyyy", numberFormat: "pt-BR",
    columns: { date: 0, description: 1, amount: 2, credit: null, debit: null, externalId: null },
  };
  const created = await app.inject({
    method: "POST", url: "/financial-imports/csv-mappings", headers: { cookie: authCookie() },
    payload: { name: "Banco principal", configuration },
  });
  assert.equal(created.statusCode, 201, created.body);
  const mappingId = created.json().id as string;
  const otherUserList = await app.inject({ method: "GET", url: "/financial-imports/csv-mappings", headers: { cookie: authCookie(SESSION_B) } });
  assert.deepEqual(otherUserList.json(), { items: [] });
  const crossWalletUpload = await app.inject({
    method: "POST", url: "/financial-imports",
    headers: { cookie: authCookie(SESSION_B), "content-type": "application/octet-stream", "x-file-name": "statement.csv", "x-file-format": "csv", "x-csv-mapping-id": mappingId },
    payload: Buffer.from("Data;Descrição;Valor\n31/10/2026;Mercado;-10,25\n"),
  });
  assert.equal(crossWalletUpload.statusCode, 404);

  const malformedQuoteUpload = await app.inject({
    method: "POST", url: "/financial-imports",
    headers: { cookie: authCookie(), "content-type": "application/octet-stream", "x-file-name": "malformed.csv", "x-file-format": "csv", "x-csv-mapping-id": mappingId },
    payload: Buffer.from('Data;Descrição;Valor\n31/10/2026;"Mercado"alterado;-10,25\n'),
  });
  assert.equal(malformedQuoteUpload.statusCode, 422);
  assert.match(malformedQuoteUpload.json().message, /conteúdo inválido após aspas/i);

  const uploadResponse = await app.inject({
    method: "POST", url: "/financial-imports",
    headers: { cookie: authCookie(), "content-type": "application/octet-stream", "x-file-name": "statement.csv", "x-file-format": "csv", "x-csv-mapping-id": mappingId },
    payload: Buffer.from("Data;Descrição;Valor\n31/10/2026;Mercado;-10,25\n"),
  });
  assert.equal(uploadResponse.statusCode, 201);
  const detail = await app.inject({ method: "GET", url: `/financial-imports/${uploadResponse.json().id}`, headers: { cookie: authCookie() } });
  assert.equal(detail.json().items[0].amount, "10.25");
  assert.equal(detail.json().items[0].type, "expense");

  const provenanceConfiguration = {
    ...configuration,
    columns: { ...configuration.columns, externalId: 3 },
  };
  const provenanceUpload = await app.inject({
    method: "POST", url: "/financial-imports",
    headers: {
      cookie: authCookie(),
      "content-type": "application/octet-stream",
      "x-file-name": "provenance.csv",
      "x-file-format": "csv",
      "x-csv-mapping": encodeURIComponent(JSON.stringify(provenanceConfiguration)),
    },
    payload: Buffer.from(`Data;Descrição;Valor;ID\n\n31/10/2026;"Primeira\nlinha";1,00;ok\n\n01/11/2026;Inválida;2,00;${"x".repeat(513)}\n`),
  });
  assert.equal(provenanceUpload.statusCode, 201);
  const provenanceDetail = await app.inject({
    method: "GET", url: `/financial-imports/${provenanceUpload.json().id}`,
    headers: { cookie: authCookie() },
  });
  assert.equal(provenanceDetail.statusCode, 200);
  assert.equal(provenanceDetail.json().items[1].sequence, 2);
  assert.equal(provenanceDetail.json().items[1].validationStatus, "invalid");
  assert.match(provenanceDetail.json().items[1].errorMessage, /Linha 6:.*identificador externo/i);

  const patched = await app.inject({
    method: "PATCH", url: `/financial-imports/csv-mappings/${mappingId}`, headers: { cookie: authCookie() },
    payload: { name: "Banco atualizado", configuration },
  });
  assert.equal(patched.statusCode, 200);
  assert.equal(patched.json().name, "Banco atualizado");

  const conflictingMappingSources = await app.inject({
    method: "POST", url: "/financial-imports",
    headers: { cookie: authCookie(), "content-type": "application/octet-stream", "x-file-name": "statement.csv", "x-file-format": "csv", "x-csv-mapping-id": mappingId, "x-csv-mapping": encodeURIComponent(JSON.stringify(configuration)) },
    payload: Buffer.from("Data;Descrição;Valor\n31/10/2026;Mercado;-10,25\n"),
  });
  assert.equal(conflictingMappingSources.statusCode, 400);
  await app.close();
});

test("categorization rules are wallet scoped, explicit, and applied to future previews", async () => {
  const { app } = createTestApp();
  const rulesUrl = "/financial-imports/rules";
  assert.equal((await app.inject({ method: "GET", url: rulesUrl })).statusCode, 401);

  const created = await app.inject({
    method: "POST", url: rulesUrl, headers: { cookie: authCookie() },
    payload: { type: "expense", description: "  MERCADO  ", categoryId: CATEGORY_A, subcategoryId: null },
  });
  assert.equal(created.statusCode, 201, created.body);
  assert.equal(created.json().description, "MERCADO");
  assert.equal(created.json().isActive, true);
  const ruleId = created.json().id as string;

  const duplicate = await app.inject({
    method: "POST", url: rulesUrl, headers: { cookie: authCookie() },
    payload: { type: "expense", description: "mercado", categoryId: CATEGORY_A },
  });
  assert.equal(duplicate.statusCode, 409);
  const transferRule = await app.inject({
    method: "POST", url: rulesUrl, headers: { cookie: authCookie() },
    payload: { type: "transfer", description: "Pix", categoryId: CATEGORY_A },
  });
  assert.equal(transferRule.statusCode, 400);
  const unknownCategory = await app.inject({
    method: "POST", url: rulesUrl, headers: { cookie: authCookie() },
    payload: { type: "expense", description: "Farmácia", categoryId: "22222222-2222-4222-8222-222222222222" },
  });
  assert.equal(unknownCategory.statusCode, 404);

  const otherWallet = await app.inject({ method: "GET", url: rulesUrl, headers: { cookie: authCookie(SESSION_B) } });
  assert.deepEqual(otherWallet.json(), { items: [] });
  const crossWalletDelete = await app.inject({ method: "DELETE", url: `${rulesUrl}/${ruleId}`, headers: { cookie: authCookie(SESSION_B) } });
  assert.equal(crossWalletDelete.statusCode, 404);

  const categorized = await upload(app);
  const categorizedDetail = await app.inject({ method: "GET", url: `/financial-imports/${categorized.json().id}`, headers: { cookie: authCookie() } });
  assert.equal(categorizedDetail.json().items[1].categoryId, CATEGORY_A);
  assert.equal(categorizedDetail.json().items[1].validationStatus, "valid");
  assert.equal(categorizedDetail.json().items[1].categorizationSource, "rule");
  assert.equal(categorizedDetail.json().items[0].categorizationSource, null);

  const otherWalletUpload = await upload(app, SESSION_B);
  const otherWalletDetail = await app.inject({ method: "GET", url: `/financial-imports/${otherWalletUpload.json().id}`, headers: { cookie: authCookie(SESSION_B) } });
  assert.equal(otherWalletDetail.json().items[1].categoryId, null);
  assert.equal(otherWalletDetail.json().items[1].validationStatus, "uncategorized");

  const otherRule = await app.inject({
    method: "POST", url: rulesUrl, headers: { cookie: authCookie() },
    payload: { type: "expense", description: "Padaria", categoryId: CATEGORY_A },
  });
  assert.equal(otherRule.statusCode, 201);
  const conflictingEdit = await app.inject({
    method: "PATCH", url: `${rulesUrl}/${otherRule.json().id}`, headers: { cookie: authCookie() },
    payload: { type: "expense", description: " mercado ", categoryId: CATEGORY_A, subcategoryId: null, isActive: true },
  });
  assert.equal(conflictingEdit.statusCode, 409);
  assert.match(conflictingEdit.json().message, /Já existe uma regra/);

  const deactivated = await app.inject({
    method: "PATCH", url: `${rulesUrl}/${ruleId}`, headers: { cookie: authCookie() },
    payload: { type: "expense", description: "Mercado", categoryId: CATEGORY_A, subcategoryId: null, isActive: false },
  });
  assert.equal(deactivated.statusCode, 200);
  assert.equal(deactivated.json().isActive, false);
  const uncategorized = await upload(app);
  const uncategorizedDetail = await app.inject({ method: "GET", url: `/financial-imports/${uncategorized.json().id}`, headers: { cookie: authCookie() } });
  assert.equal(uncategorizedDetail.json().items[1].categoryId, null);
  assert.equal(uncategorizedDetail.json().items[1].categorizationSource, null);

  const deleted = await app.inject({ method: "DELETE", url: `${rulesUrl}/${ruleId}`, headers: { cookie: authCookie() } });
  assert.equal(deleted.statusCode, 204);
  const missing = await app.inject({ method: "DELETE", url: `${rulesUrl}/${ruleId}`, headers: { cookie: authCookie() } });
  assert.equal(missing.statusCode, 404);
  await app.close();
});

test("card statement uploads validate the card and the CSV purchase sign before parsing", async () => {
  const { app, repository } = createTestApp(new DefaultFinancialImportParser());
  const bankImport = await upload(app);
  const walletId = repository.sessions.get(bankImport.json().id)!.walletId;
  const cardId = "40000000-0000-4000-8000-000000000001";
  repository.creditCards.set(cardId, { walletId, card: { id: cardId, closingDay: 10, dueDay: 20 } });
  const sendCard = (headers: Record<string, string>, fileName = "fatura.csv", format = "csv") => app.inject({
    method: "POST",
    url: "/financial-imports",
    headers: {
      cookie: authCookie(),
      "content-type": "application/octet-stream",
      "x-file-name": fileName,
      "x-file-format": format,
      ...(format === "csv" ? { "x-csv-mapping": CSV_MAPPING_HEADER } : {}),
      ...headers,
    },
    payload: Buffer.from("date,description,amount\n2026-10-11,Livraria,50.25\n2026-10-12,Estorno Livraria,-20.25\n"),
  });

  const signWithoutCard = await sendCard({ "x-card-amount-sign": "purchases_positive" });
  assert.equal(signWithoutCard.statusCode, 400);
  assert.match(signWithoutCard.json().message, /só se aplica a faturas de cartão/);
  assert.equal((await sendCard({ "x-credit-card-id": "40000000-0000-4000-8000-000000000099", "x-card-amount-sign": "purchases_positive" })).statusCode, 404);
  assert.equal((await sendCard({ "x-credit-card-id": "not-a-card", "x-card-amount-sign": "purchases_positive" })).statusCode, 404);
  assert.match((await sendCard({ "x-credit-card-id": cardId })).json().message, /representa as compras/);
  assert.equal((await sendCard({ "x-credit-card-id": cardId, "x-card-amount-sign": "purchases_positive" }, "fatura.ofx", "ofx")).statusCode, 400);

  const created = await sendCard({ "x-credit-card-id": cardId, "x-card-amount-sign": "purchases_positive" });
  assert.equal(created.statusCode, 201, created.body);
  assert.equal(created.json().kind, "credit_card_statement");
  assert.deepEqual(repository.sessions.get(created.json().id)!.items.map((item) => [item.type, item.amount]), [
    ["expense", "50.25"],
    ["card_credit", "20.25"],
  ]);
  await app.close();
});
