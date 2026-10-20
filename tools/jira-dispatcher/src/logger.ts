import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Redactor } from "./redact.js";

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface LogContext {
  issueKey?: string;
  runId?: string;
  [key: string]: unknown;
}

export interface Logger {
  debug(event: string, context?: LogContext): void;
  info(event: string, context?: LogContext): void;
  warn(event: string, context?: LogContext): void;
  error(event: string, context?: LogContext): void;
  child(context: LogContext): Logger;
}

export interface LoggerOptions {
  filePath?: string;
  level?: LogLevel;
  console?: boolean;
  redactor: Redactor;
  now?: () => Date;
}

/**
 * Structured JSON Lines logger. Every entry is redacted before it is written anywhere.
 */
export class JsonLogger implements Logger {
  constructor(
    private readonly options: LoggerOptions,
    private readonly baseContext: LogContext = {}
  ) {
    if (options.filePath) mkdirSync(dirname(options.filePath), { recursive: true });
  }

  debug(event: string, context?: LogContext): void {
    this.write("debug", event, context);
  }

  info(event: string, context?: LogContext): void {
    this.write("info", event, context);
  }

  warn(event: string, context?: LogContext): void {
    this.write("warn", event, context);
  }

  error(event: string, context?: LogContext): void {
    this.write("error", event, context);
  }

  child(context: LogContext): Logger {
    return new JsonLogger(this.options, { ...this.baseContext, ...context });
  }

  private write(level: LogLevel, event: string, context: LogContext = {}): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.options.level ?? "info"]) return;
    const entry = {
      ts: (this.options.now ?? (() => new Date()))().toISOString(),
      level,
      event,
      ...this.baseContext,
      ...normalizeContext(context)
    };
    const line = this.options.redactor.redact(JSON.stringify(entry));
    if (this.options.filePath) appendFileSync(this.options.filePath, `${line}\n`, "utf8");
    if (this.options.console !== false) {
      const stream = level === "error" || level === "warn" ? process.stderr : process.stdout;
      stream.write(`${line}\n`);
    }
  }
}

function normalizeContext(context: LogContext): LogContext {
  const result: LogContext = {};
  for (const [key, value] of Object.entries(context)) {
    result[key] = value instanceof Error ? { name: value.name, message: value.message } : value;
  }
  return result;
}

/** Logger used by tests and by commands that must stay silent. */
export class MemoryLogger implements Logger {
  readonly entries: { level: LogLevel; event: string; context: LogContext }[];

  constructor(
    private readonly baseContext: LogContext = {},
    entries?: { level: LogLevel; event: string; context: LogContext }[]
  ) {
    this.entries = entries ?? [];
  }

  debug(event: string, context?: LogContext): void {
    this.push("debug", event, context);
  }
  info(event: string, context?: LogContext): void {
    this.push("info", event, context);
  }
  warn(event: string, context?: LogContext): void {
    this.push("warn", event, context);
  }
  error(event: string, context?: LogContext): void {
    this.push("error", event, context);
  }
  child(context: LogContext): Logger {
    return new MemoryLogger({ ...this.baseContext, ...context }, this.entries);
  }
  private push(level: LogLevel, event: string, context: LogContext = {}): void {
    this.entries.push({ level, event, context: { ...this.baseContext, ...context } });
  }
}

export function ensureParentDir(filePath: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
}
