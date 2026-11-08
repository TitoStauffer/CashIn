// Fakes e helpers compartilhados pelos testes de rota de importação financeira. Extraídos na
// DEV-95 sem alterar nenhuma asserção: os casos de teste foram movidos, não reescritos.
// O nome segue o precedente de `wallets/wallets-test-fixture.ts`.

import test from "node:test";
import { fileURLToPath } from "node:url";
import { createApp } from "../app.js";
import type { Database, QueryExecutor } from "../database.js";
import { hashToken } from "../auth/token.js";
import type { AuthRepository, AuthUser, PendingAccount, StoredUser } from "../auth/auth.types.js";
import { WalletsTestFixture } from "../wallets/wallets-test-fixture.js";
import { FinancialImportError } from "./financial-imports.errors.js";
import type { CreateCsvMappingInput, CsvMapping, CreateFinancialImportInput, FinancialCategorizationRule, FinancialCategorizationRuleInput, FinancialCategorizationRulesRepository, FinancialImportItem, FinancialImportParser, FinancialImportRepository, FinancialImportSession, ParsedFinancialImportItem, UpdateFinancialImportItemInput } from "./financial-imports.types.js";


export const USER_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
export const USER_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
export const CATEGORY_A = "11111111-1111-4111-8111-111111111111";
export const SESSION_A = "a".repeat(43);
export const SESSION_B = "b".repeat(43);
export const CSV_MAPPING_HEADER = encodeURIComponent(JSON.stringify({
  delimiter: ",", encoding: "utf-8", hasHeader: true, dateFormat: "yyyy-MM-dd", numberFormat: "en-US",
  columns: { date: 0, description: 1, amount: 2, credit: null, debit: null, externalId: null },
}));

// The importer is derived from the stored session and the reader, exactly as the database does it,
// so the fake cannot answer "who imported" more generously than production.
export interface StoredSession extends Omit<FinancialImportSession, "importedBy"> {
  userId: string;
  walletId: string;
  items: FinancialImportItem[];
}

export const USER_EMAILS: Record<string, string> = {
  [USER_A]: "usuario-a@example.test",
  [USER_B]: "usuario-b@example.test",
};

export class MemoryFinancialImportRepository implements FinancialImportRepository {
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

export class TestParser implements FinancialImportParser {
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

export class InvalidItemsParser implements FinancialImportParser {
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

export class SessionAuthRepository implements AuthRepository {
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

export const fixtures = fileURLToPath(new URL("./fixtures/", import.meta.url));

export type StoredRule = FinancialCategorizationRule & { walletId: string; normalizedDescription: string };

export class MemoryCategorizationRulesRepository implements FinancialCategorizationRulesRepository {
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

export function createTestApp(parser: FinancialImportParser | null = new TestParser()) {
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

export function authCookie(session = SESSION_A): string {
  return `cashin_session=${session}`;
}

export async function upload(app: ReturnType<typeof createApp>, session = SESSION_A) {
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
