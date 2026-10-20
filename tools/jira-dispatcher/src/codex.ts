import { execFile, spawn } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync, type WriteStream } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { DispatcherConfig } from "./config.js";
import type { Redactor } from "./redact.js";

export type CodexOutcome = "done" | "awaiting_human" | "blocked" | "failed";

export interface CodexFinalResult {
  issueKey: string;
  outcome: CodexOutcome;
  prUrl: string | null;
  jiraStatus: string;
  summary: string;
}

export interface CodexRunInput {
  prompt: string;
  workdir: string;
  extraWritableDirs: string[];
  logDir: string;
  /** Aborting kills the Codex process tree (used by forced shutdown). */
  signal?: AbortSignal;
  onSpawn?: (pid: number) => void;
  onThreadId?: (threadId: string) => void;
}

export interface CodexRunResult {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  aborted: boolean;
  spawnError?: string;
  threadId?: string;
  lastError?: string;
  finalResult?: CodexFinalResult;
  resultError?: string;
}

export interface CodexRunner {
  run(input: CodexRunInput): Promise<CodexRunResult>;
}

const OUTCOMES: CodexOutcome[] = ["done", "awaiting_human", "blocked", "failed"];
const UNSAFE_SHELL_CHARS = /["%\r\n]/;

/**
 * Starts `codex exec` non-interactively in the run's working directory.
 * The prompt goes through stdin so no issue text is ever interpreted by a shell.
 */
export class CodexCliRunner implements CodexRunner {
  constructor(
    private readonly config: DispatcherConfig,
    private readonly redactor: Redactor,
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly platform: NodeJS.Platform = process.platform
  ) {}

  buildArgs(input: Pick<CodexRunInput, "workdir" | "extraWritableDirs" | "logDir">): string[] {
    return [
      ...this.config.codex.args,
      "--cd",
      input.workdir,
      ...input.extraWritableDirs.flatMap((dir) => ["--add-dir", dir]),
      "--output-schema",
      this.config.codex.outputSchemaFile,
      "--output-last-message",
      join(input.logDir, "result.json"),
      "-"
    ];
  }

  buildEnv(): NodeJS.ProcessEnv {
    const env = { ...this.env };
    for (const name of this.config.codex.stripEnv) delete env[name];
    return env;
  }

  run(input: CodexRunInput): Promise<CodexRunResult> {
    mkdirSync(input.logDir, { recursive: true });
    writeFileSync(join(input.logDir, "prompt.md"), this.redactor.redact(input.prompt), "utf8");

    const args = this.buildArgs(input);
    const useShell = this.platform === "win32" && !/\.exe$/i.test(this.config.codex.command);
    if (useShell) {
      // .cmd shims (npm installs) require a shell on Windows; refuse arguments the shell could reinterpret.
      const unsafe = [this.config.codex.command, ...args].find((arg) => UNSAFE_SHELL_CHARS.test(arg));
      if (unsafe) {
        return Promise.resolve(failure(`Argumento inseguro para o shell do Windows: ${this.redactor.redact(unsafe)}`));
      }
    }

    const events = createWriteStream(join(input.logDir, "codex-events.jsonl"), { flags: "a" });
    const stderrLog = createWriteStream(join(input.logDir, "codex-stderr.log"), { flags: "a" });
    const resultFile = join(input.logDir, "result.json");

    return new Promise<CodexRunResult>((resolve) => {
      const result: CodexRunResult = { exitCode: null, signal: null, timedOut: false, aborted: false };
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        input.signal?.removeEventListener("abort", onAbort);
        Promise.all([closeStream(events), closeStream(stderrLog)]).then(() => {
          if (!result.spawnError) readFinalResult(resultFile, result);
          resolve(result);
        });
      };

      const child = spawn(
        useShell ? quoteForCmd(this.config.codex.command) : this.config.codex.command,
        useShell ? args.map(quoteForCmd) : args,
        {
          cwd: input.workdir,
          env: this.buildEnv(),
          shell: useShell,
          windowsHide: true,
          // Own a process group on Unix so terminal Ctrl+C cannot kill Codex mid-step.
          // Windows uses taskkill /T for the process tree; keeping it attached preserves piped stdin for .cmd shims.
          detached: this.platform !== "win32",
          stdio: ["pipe", "pipe", "pipe"]
        }
      );

      const kill = () => killTree(child.pid, this.platform, this.config.codex.killGraceSeconds * 1000);
      const timer = setTimeout(() => {
        result.timedOut = true;
        kill();
      }, this.config.codex.timeoutMinutes * 60_000);
      const onAbort = () => {
        result.aborted = true;
        kill();
      };
      if (input.signal?.aborted) onAbort();
      else input.signal?.addEventListener("abort", onAbort, { once: true });

      child.on("error", (error) => {
        result.spawnError = `Não foi possível iniciar o Codex CLI (${this.config.codex.command}): ${error.message}`;
        finish();
      });
      child.on("spawn", () => {
        if (child.pid) input.onSpawn?.(child.pid);
      });

      createInterface({ input: child.stdout! }).on("line", (line) => {
        events.write(`${this.redactor.redact(line)}\n`);
        const event = parseJson(line) as { type?: string; thread_id?: string; message?: string; error?: { message?: string } } | undefined;
        if (!event) return;
        if (event.type === "thread.started" && event.thread_id) {
          result.threadId = event.thread_id;
          input.onThreadId?.(event.thread_id);
        }
        if (event.type === "turn.failed" || event.type === "error") {
          result.lastError = this.redactor.redact(event.error?.message ?? event.message ?? event.type).slice(0, 1000);
        }
      });
      child.stderr!.on("data", (chunk: Buffer) => stderrLog.write(this.redactor.redact(chunk.toString("utf8"))));

      child.stdin!.on("error", () => undefined);
      child.stdin!.end(input.prompt, "utf8");

      child.on("close", (code, signal) => {
        result.exitCode = code;
        result.signal = signal;
        finish();
      });
    });
  }
}

export function quoteForCmd(arg: string): string {
  return /[\s&|<>^()]/.test(arg) ? `"${arg}"` : arg;
}

function failure(message: string): CodexRunResult {
  return { exitCode: null, signal: null, timedOut: false, aborted: false, spawnError: message };
}

function readFinalResult(file: string, result: CodexRunResult): void {
  if (!existsSync(file)) {
    result.resultError = "O Codex não gravou a mensagem final.";
    return;
  }
  const parsed = parseJson(readFileSync(file, "utf8").trim());
  const validation = validateFinalResult(parsed);
  if (typeof validation === "string") result.resultError = validation;
  else result.finalResult = validation;
}

export function validateFinalResult(value: unknown): CodexFinalResult | string {
  if (typeof value !== "object" || value === null) return "A mensagem final do Codex não é um JSON válido.";
  const v = value as Record<string, unknown>;
  if (typeof v.issueKey !== "string") return "Resultado sem issueKey.";
  if (typeof v.outcome !== "string" || !OUTCOMES.includes(v.outcome as CodexOutcome)) return "Resultado com outcome inválido.";
  if (v.prUrl !== null && typeof v.prUrl !== "string") return "Resultado com prUrl inválido.";
  if (typeof v.jiraStatus !== "string") return "Resultado sem jiraStatus.";
  if (typeof v.summary !== "string") return "Resultado sem summary.";
  return {
    issueKey: v.issueKey,
    outcome: v.outcome as CodexOutcome,
    prUrl: (v.prUrl as string | null) ?? null,
    jiraStatus: v.jiraStatus,
    summary: v.summary.slice(0, 4000)
  };
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function closeStream(stream: WriteStream): Promise<void> {
  return new Promise((resolve) => stream.end(resolve));
}

/** Stops a process and its children: SIGTERM first, SIGKILL after the grace period. */
export function killTree(pid: number | undefined, platform: NodeJS.Platform, graceMs: number): void {
  if (!pid) return;
  if (platform === "win32") {
    execFile("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true }, () => undefined);
    return;
  }
  const signalGroup = (signal: NodeJS.Signals) => {
    try {
      process.kill(-pid, signal);
    } catch {
      try {
        process.kill(pid, signal);
      } catch {
        /* already gone */
      }
    }
  };
  signalGroup("SIGTERM");
  setTimeout(() => signalGroup("SIGKILL"), graceMs).unref();
}
