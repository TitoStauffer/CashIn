import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseConfig, type DispatcherConfig } from "../src/config.js";
import type { CodexRunInput, CodexRunner, CodexRunResult } from "../src/codex.js";
import { Dispatcher } from "../src/dispatcher.js";
import { JiraHttpError, type JiraApi, type JiraIssue, type JiraTransition, type JiraStatus } from "../src/jira/client.js";
import { MemoryLogger } from "../src/logger.js";
import { Redactor } from "../src/redact.js";
import { StateStore } from "../src/state.js";
import type { PreparedWorkspace, Workspace, WorkspaceSnapshot } from "../src/workspace.js";

export const PROMPTS_DIR = resolve(import.meta.dirname, "..", "prompts");

export const STATUS = {
  todo: { id: "10000", name: "Tarefas pendentes", statusCategory: { key: "new" } },
  progress: { id: "3", name: "Em andamento", statusCategory: { key: "indeterminate" } },
  review: { id: "10002", name: "Em análise", statusCategory: { key: "indeterminate" } },
  done: { id: "10001", name: "Concluído", statusCategory: { key: "done" } }
} satisfies Record<string, JiraStatus>;

export function tempDir(prefix = "dispatcher-test-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function makeConfig(overrides: Partial<Record<string, unknown>> = {}, dir = tempDir()): DispatcherConfig {
  const raw = {
    repoPath: dir,
    defaultBranch: "master",
    stateDir: join(dir, ".dispatcher"),
    pollIntervalSeconds: 30,
    maxConcurrentRuns: 1,
    worktree: { enabled: true, baseDir: join(dir, "worktrees") },
    jira: {
      baseUrl: "https://example.atlassian.net",
      eligibilityJql: 'project = DEV AND status = "To Do" ORDER BY Rank ASC',
      allowedEpicKeys: ["DEV-6"],
      requiredFields: [
        { field: "description", label: "Descrição", mustContain: ["Critérios de aceitação"] },
        { field: "customfield_agent", label: "Agent técnico principal", allowedValues: ["Backend", "Frontend", "DBA"] }
      ],
      blockingLinks: [{ type: "Blocks", direction: "inward" }],
      reservableStatuses: ["10000"],
      reservationTargetStatus: "Em andamento",
      resumableStatuses: ["Em andamento", "Em análise"],
      doneStatuses: ["Concluído"],
      ...(overrides.jira as object | undefined)
    },
    codex: {
      promptTemplateFile: join(PROMPTS_DIR, "run.md"),
      resumePromptTemplateFile: join(PROMPTS_DIR, "resume.md"),
      outputSchemaFile: join(PROMPTS_DIR, "result.schema.json"),
      ...(overrides.codex as object | undefined)
    },
    ...Object.fromEntries(Object.entries(overrides).filter(([k]) => k !== "jira" && k !== "codex"))
  };
  return parseConfig(raw, dir);
}

export function eligibleIssue(key: string, patch: Partial<JiraIssue["fields"]> = {}): JiraIssue {
  return {
    id: key.replace(/\D/g, ""),
    key,
    fields: {
      summary: `História ${key}`,
      status: STATUS.todo,
      parent: { key: "DEV-6" },
      description: {
        type: "doc",
        version: 1,
        content: [{ type: "paragraph", content: [{ type: "text", text: "Objetivo... Critérios de aceitação: ..." }] }]
      },
      customfield_agent: { value: "Backend" },
      issuelinks: [],
      ...patch
    }
  };
}

/** In-memory Jira that mimics transitions being available only from specific statuses. */
export class FakeJira implements JiraApi {
  readonly issues = new Map<string, JiraIssue>();
  readonly comments: { key: string; text: string }[] = [];
  readonly transitionsCalled: { key: string; id: string }[] = [];
  readonly properties = new Map<string, unknown>();
  failComments = 0;
  failTransition?: Error;
  /** Called right before returning the issue in getIssue, to simulate concurrent changes. */
  onGetIssue?: (issue: JiraIssue) => void;
  workflow: Record<string, JiraTransition[]> = {
    [STATUS.todo.id]: [{ id: "21", name: "Iniciar", to: STATUS.progress }],
    [STATUS.progress.id]: [{ id: "31", name: "Enviar para análise", to: STATUS.review }],
    [STATUS.review.id]: [
      { id: "41", name: "Concluir", to: STATUS.done },
      { id: "11", name: "Voltar", to: STATUS.progress }
    ],
    [STATUS.done.id]: []
  };

  add(...issues: JiraIssue[]): this {
    for (const issue of issues) this.issues.set(issue.key, structuredClone(issue));
    return this;
  }

  setStatus(key: string, status: JiraStatus): void {
    this.issues.get(key)!.fields.status = status;
  }

  async myself() {
    return { accountId: "me" };
  }

  async searchIssues(): Promise<JiraIssue[]> {
    return [...this.issues.values()]
      .filter((issue) => issue.fields.status?.id === STATUS.todo.id)
      .map((issue) => structuredClone(issue));
  }

  async getIssue(key: string): Promise<JiraIssue> {
    const issue = this.issues.get(key);
    if (!issue) throw new JiraHttpError(404, "GET", `/issue/${key}`, "not found");
    this.onGetIssue?.(issue);
    return structuredClone(issue);
  }

  async getTransitions(key: string): Promise<JiraTransition[]> {
    const issue = await this.getIssue(key);
    return this.workflow[issue.fields.status!.id] ?? [];
  }

  async transitionIssue(key: string, transitionId: string): Promise<void> {
    this.transitionsCalled.push({ key, id: transitionId });
    if (this.failTransition) throw this.failTransition;
    const issue = this.issues.get(key)!;
    const transition = (this.workflow[issue.fields.status!.id] ?? []).find((t) => t.id === transitionId);
    if (!transition) throw new JiraHttpError(400, "POST", `/issue/${key}/transitions`, "Transition is not valid");
    issue.fields.status = transition.to;
  }

  async addComment(key: string, text: string): Promise<void> {
    if (this.failComments > 0) {
      this.failComments -= 1;
      throw new JiraHttpError(503, "POST", `/issue/${key}/comment`, "unavailable");
    }
    this.comments.push({ key, text });
  }

  async listComments(key: string) {
    return this.comments.filter((comment) => comment.key === key).map((comment, index) => ({ id: String(index + 1), body: comment.text }));
  }

  async setIssueProperty(key: string, propertyKey: string, value: unknown): Promise<void> {
    this.properties.set(`${key}:${propertyKey}`, value);
  }

  async getIssueProperty(key: string, propertyKey: string): Promise<unknown> {
    return this.properties.get(`${key}:${propertyKey}`);
  }

  async listFields() {
    return [];
  }

  async listLinkTypes() {
    return [];
  }
}

export class FakeWorkspace implements Workspace {
  readonly prepared: string[] = [];
  failPrepare?: Error;

  constructor(private readonly baseDir: string) {}

  async verifyRepository(): Promise<void> {}

  async prepare(issueKey: string, runId: string): Promise<PreparedWorkspace> {
    if (this.failPrepare) throw this.failPrepare;
    const dir = join(this.baseDir, `${issueKey}-${runId.slice(0, 8)}`);
    mkdirSync(dir, { recursive: true });
    this.prepared.push(dir);
    return { workdir: dir, worktreePath: dir, extraWritableDirs: [] };
  }

  async reuse(workdir: string, worktreePath?: string): Promise<PreparedWorkspace> {
    return { workdir, worktreePath, extraWritableDirs: [] };
  }

  async snapshot(): Promise<WorkspaceSnapshot> {
    return { exists: true, branch: "feature/DEV-1-x", head: "abc123", dirtyFiles: 0 };
  }
}

/** Codex fake whose runs stay pending until the test resolves them. */
export class ControlledCodex implements CodexRunner {
  readonly calls: CodexRunInput[] = [];
  private readonly resolvers: ((result: CodexRunResult) => void)[] = [];

  run(input: CodexRunInput): Promise<CodexRunResult> {
    this.calls.push(input);
    input.onSpawn?.(999_999);
    return new Promise((resolve) => this.resolvers.push(resolve));
  }

  finish(index: number, result: Partial<CodexRunResult>): void {
    this.resolvers[index]!({ exitCode: 0, signal: null, timedOut: false, aborted: false, ...result });
  }
}

export function makeDispatcher(options: {
  config?: DispatcherConfig;
  jira?: FakeJira;
  codex?: CodexRunner;
  workspace?: Workspace;
  store?: StateStore;
} = {}) {
  const config = options.config ?? makeConfig();
  const jira = options.jira ?? new FakeJira();
  const codex = options.codex ?? new ControlledCodex();
  const workspace = options.workspace ?? new FakeWorkspace(config.worktree.baseDir);
  const store = options.store ?? new StateStore(config.stateDir);
  const logger = new MemoryLogger();
  const dispatcher = new Dispatcher({
    config,
    jira,
    codex,
    workspace,
    store,
    logger,
    redactor: new Redactor(["super-secret-token-value"]),
    commentRetryDelayMs: 0
  });
  return { dispatcher, config, jira, codex, workspace, store, logger };
}

export function writeExecutable(path: string, content: string): string {
  writeFileSync(path, content, { mode: 0o755 });
  return path;
}
