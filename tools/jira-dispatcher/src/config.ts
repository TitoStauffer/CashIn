import { readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

export interface FieldRequirement {
  /** Jira field id (e.g. "description", "customfield_10050"). Discover ids with `jira-dispatcher discover`. */
  field: string;
  /** Human label used in logs. */
  label: string;
  /** Each text must appear (case-insensitive) in the field's text. */
  mustContain?: string[];
  /** Regular expression the field's text must match. */
  pattern?: string;
  /** When set, at least one of the field's values must be in this list (case-insensitive). */
  allowedValues?: string[];
}

export interface BlockingLinkRule {
  /** Issue link type name exactly as returned by Jira (e.g. "Blocks"). */
  type: string;
  /** Which side of the link holds the blocking issue: "inward" or "outward". */
  direction: "inward" | "outward";
}

export interface DispatcherConfig {
  configDir: string;
  repoPath: string;
  defaultBranch: string;
  remote: string;
  stateDir: string;
  pollIntervalSeconds: number;
  maxConcurrentRuns: number;
  logLevel: "debug" | "info" | "warn" | "error";
  worktree: {
    enabled: boolean;
    baseDir: string;
  };
  jira: {
    baseUrl: string;
    eligibilityJql: string;
    maxResults: number;
    requiredFields: FieldRequirement[];
    blockingLinks: BlockingLinkRule[];
    /** Status names or ids the issue must be in right before reservation. */
    reservableStatuses: string[];
    /** Target status (name or id) of the reservation transition. */
    reservationTargetStatus: string;
    /** Optional explicit transition id; when omitted, the transition is found by its target status. */
    reservationTransitionId?: string;
    /** Statuses (name or id) in which an interrupted run may be resumed. */
    resumableStatuses: string[];
    /** Statuses (name or id) that mean the issue was delivered. */
    doneStatuses: string[];
    commentTimeZone: string;
    /** Issue entity property used to record the run id on the issue. Empty string disables it. */
    runPropertyKey: string;
  };
  codex: {
    command: string;
    args: string[];
    promptTemplateFile: string;
    resumePromptTemplateFile: string;
    outputSchemaFile: string;
    timeoutMinutes: number;
    killGraceSeconds: number;
    /** Environment variables removed from the Codex process (the dispatcher's own credentials). */
    stripEnv: string[];
  };
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/** Flags that would grant unrestricted execution; they are refused on purpose. */
const FORBIDDEN_CODEX_ARGS = [
  "--dangerously-bypass-approvals-and-sandbox",
  "--yolo",
  "danger-full-access",
  "--full-auto"
];

const ISSUE_KEY = /^[A-Z][A-Z0-9_]+-\d+$/;

export function isValidIssueKey(key: string): boolean {
  return ISSUE_KEY.test(key);
}

export function loadConfig(configPath: string): DispatcherConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(configPath, "utf8"));
  } catch (error) {
    throw new ConfigError(`Não foi possível ler a configuração em ${configPath}: ${(error as Error).message}`);
  }
  return parseConfig(raw, dirname(resolve(configPath)));
}

export function parseConfig(raw: unknown, configDir: string): DispatcherConfig {
  const placeholders = findPlaceholders(raw, "");
  if (placeholders.length > 0) {
    throw new ConfigError(`Configuração incompleta; preencha: ${placeholders.join(", ")}.`);
  }
  const root = object(raw, "config");
  const jira = object(root.jira, "jira");
  const codex = object(root.codex ?? {}, "codex");
  const worktree = object(root.worktree ?? {}, "worktree");

  const repoPath = resolvePath(configDir, string(root.repoPath, "repoPath"));
  const repoName = repoPath.split(/[\\/]/).filter(Boolean).pop() ?? "repo";

  const config: DispatcherConfig = {
    configDir,
    repoPath,
    defaultBranch: string(root.defaultBranch, "defaultBranch"),
    remote: optionalString(root.remote, "remote") ?? "origin",
    stateDir: resolvePath(repoPath, optionalString(root.stateDir, "stateDir") ?? ".dispatcher"),
    pollIntervalSeconds: integer(root.pollIntervalSeconds ?? 300, "pollIntervalSeconds", 30),
    maxConcurrentRuns: integer(root.maxConcurrentRuns ?? 1, "maxConcurrentRuns", 1),
    logLevel: oneOf(root.logLevel ?? "info", "logLevel", ["debug", "info", "warn", "error"] as const),
    worktree: {
      enabled: boolean(worktree.enabled ?? true, "worktree.enabled"),
      baseDir: resolvePath(repoPath, optionalString(worktree.baseDir, "worktree.baseDir") ?? `../${repoName}-worktrees`)
    },
    jira: {
      baseUrl: httpsUrl(jira.baseUrl, "jira.baseUrl"),
      eligibilityJql: nonEmpty(string(jira.eligibilityJql, "jira.eligibilityJql"), "jira.eligibilityJql"),
      maxResults: integer(jira.maxResults ?? 20, "jira.maxResults", 1),
      requiredFields: array(jira.requiredFields ?? [], "jira.requiredFields").map((item, index) =>
        fieldRequirement(item, `jira.requiredFields[${index}]`)
      ),
      blockingLinks: array(jira.blockingLinks ?? [], "jira.blockingLinks").map((item, index) =>
        blockingLink(item, `jira.blockingLinks[${index}]`)
      ),
      reservableStatuses: nonEmptyList(stringList(jira.reservableStatuses, "jira.reservableStatuses"), "jira.reservableStatuses"),
      reservationTargetStatus: nonEmpty(string(jira.reservationTargetStatus, "jira.reservationTargetStatus"), "jira.reservationTargetStatus"),
      reservationTransitionId: optionalString(jira.reservationTransitionId, "jira.reservationTransitionId"),
      resumableStatuses: nonEmptyList(stringList(jira.resumableStatuses, "jira.resumableStatuses"), "jira.resumableStatuses"),
      doneStatuses: nonEmptyList(stringList(jira.doneStatuses, "jira.doneStatuses"), "jira.doneStatuses"),
      commentTimeZone: timeZone(jira.commentTimeZone ?? "America/Sao_Paulo", "jira.commentTimeZone"),
      runPropertyKey: optionalString(jira.runPropertyKey, "jira.runPropertyKey") ?? "saldocerto.dispatcher.run"
    },
    codex: {
      command: optionalString(codex.command, "codex.command") ?? "codex",
      args: stringList(codex.args ?? ["exec", "--json", "--sandbox", "workspace-write"], "codex.args"),
      promptTemplateFile: resolvePath(configDir, optionalString(codex.promptTemplateFile, "codex.promptTemplateFile") ?? "prompts/run.md"),
      resumePromptTemplateFile: resolvePath(
        configDir,
        optionalString(codex.resumePromptTemplateFile, "codex.resumePromptTemplateFile") ?? "prompts/resume.md"
      ),
      outputSchemaFile: resolvePath(configDir, optionalString(codex.outputSchemaFile, "codex.outputSchemaFile") ?? "prompts/result.schema.json"),
      timeoutMinutes: integer(codex.timeoutMinutes ?? 240, "codex.timeoutMinutes", 1),
      killGraceSeconds: integer(codex.killGraceSeconds ?? 15, "codex.killGraceSeconds", 1),
      stripEnv: stringList(codex.stripEnv ?? ["JIRA_EMAIL", "JIRA_API_TOKEN"], "codex.stripEnv")
    }
  };

  assertSafeCodexArgs(config.codex.args);
  return config;
}

export function assertSafeCodexArgs(args: string[]): void {
  for (const arg of args) {
    const normalized = arg.trim().toLowerCase();
    const forbidden = FORBIDDEN_CODEX_ARGS.find((flag) => normalized === flag || normalized.includes(flag));
    if (forbidden) {
      throw new ConfigError(
        `codex.args contém "${arg}", que concede execução irrestrita ou aprovações automáticas. O dispatcher recusa essa configuração.`
      );
    }
  }
  if (args[0] !== "exec") {
    throw new ConfigError('codex.args deve começar com "exec" (modo não interativo do Codex CLI).');
  }
  const managed = ["--output-last-message", "-o", "--output-schema", "--cd", "-C"];
  const clash = args.find((arg) => managed.includes(arg));
  if (clash) throw new ConfigError(`codex.args não deve conter "${clash}"; o dispatcher define esse parâmetro.`);
}

function findPlaceholders(value: unknown, path: string): string[] {
  if (typeof value === "string") return value.includes("PREENCHA") ? [path || "(raiz)"] : [];
  if (Array.isArray(value)) return value.flatMap((item, index) => findPlaceholders(item, `${path}[${index}]`));
  if (typeof value === "object" && value !== null) {
    return Object.entries(value).flatMap(([key, item]) => findPlaceholders(item, path ? `${path}.${key}` : key));
  }
  return [];
}

// ---- small validation helpers ----

type Obj = Record<string, unknown>;

function object(value: unknown, path: string): Obj {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new ConfigError(`${path} deve ser um objeto.`);
  return value as Obj;
}

function string(value: unknown, path: string): string {
  if (typeof value !== "string") throw new ConfigError(`${path} é obrigatório e deve ser texto.`);
  return value;
}

function optionalString(value: unknown, path: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  return string(value, path);
}

function nonEmpty(value: string, path: string): string {
  if (value.trim() === "") throw new ConfigError(`${path} não pode ser vazio.`);
  return value.trim();
}

function array(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) throw new ConfigError(`${path} deve ser uma lista.`);
  return value;
}

function stringList(value: unknown, path: string): string[] {
  return array(value, path).map((item, index) => string(item, `${path}[${index}]`));
}

function nonEmptyList(value: string[], path: string): string[] {
  if (value.length === 0) throw new ConfigError(`${path} deve ter pelo menos um item.`);
  return value;
}

function integer(value: unknown, path: string, min: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min) {
    throw new ConfigError(`${path} deve ser um inteiro >= ${min}.`);
  }
  return value;
}

function boolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") throw new ConfigError(`${path} deve ser true ou false.`);
  return value;
}

function oneOf<T extends string>(value: unknown, path: string, options: readonly T[]): T {
  if (typeof value !== "string" || !options.includes(value as T)) throw new ConfigError(`${path} deve ser um de: ${options.join(", ")}.`);
  return value as T;
}

function httpsUrl(value: unknown, path: string): string {
  const text = string(value, path);
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new ConfigError(`${path} deve ser uma URL válida.`);
  }
  if (url.protocol !== "https:") throw new ConfigError(`${path} deve usar https.`);
  return url.origin;
}

function timeZone(value: unknown, path: string): string {
  const text = string(value, path);
  try {
    new Intl.DateTimeFormat("pt-BR", { timeZone: text });
  } catch {
    throw new ConfigError(`${path} não é um fuso horário IANA válido.`);
  }
  return text;
}

function fieldRequirement(value: unknown, path: string): FieldRequirement {
  const item = object(value, path);
  const pattern = optionalString(item.pattern, `${path}.pattern`);
  if (pattern) {
    try {
      new RegExp(pattern, "i");
    } catch {
      throw new ConfigError(`${path}.pattern não é uma expressão regular válida.`);
    }
  }
  return {
    field: nonEmpty(string(item.field, `${path}.field`), `${path}.field`),
    label: optionalString(item.label, `${path}.label`) ?? string(item.field, `${path}.field`),
    mustContain: item.mustContain === undefined ? undefined : stringList(item.mustContain, `${path}.mustContain`),
    pattern,
    allowedValues: item.allowedValues === undefined ? undefined : stringList(item.allowedValues, `${path}.allowedValues`)
  };
}

function blockingLink(value: unknown, path: string): BlockingLinkRule {
  const item = object(value, path);
  return {
    type: nonEmpty(string(item.type, `${path}.type`), `${path}.type`),
    direction: oneOf(item.direction, `${path}.direction`, ["inward", "outward"] as const)
  };
}

function resolvePath(base: string, path: string): string {
  return isAbsolute(path) ? path : resolve(base, path);
}
