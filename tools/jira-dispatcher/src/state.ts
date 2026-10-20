import { randomUUID } from "node:crypto";
import { closeSync, existsSync, linkSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join } from "node:path";

export type RunStatus =
  | "reserving" // selected; Jira reservation in progress
  | "running" // Codex process started
  | "completed" // Codex reported done and Jira confirms a done status
  | "needs_attention" // Codex finished but the issue is blocked/awaiting a human, or results are inconsistent
  | "failed" // an error stopped the run
  | "interrupted" // the dispatcher or Codex process stopped before finishing
  | "cancelled"; // an operator cleared the run

/** Statuses in which a run still owns its issue. */
export const ACTIVE_STATUSES: RunStatus[] = ["reserving", "running"];
/** Terminal statuses that block automatic reselection of the same issue until an operator acts. */
export const BLOCKING_STATUSES: RunStatus[] = ["needs_attention", "failed", "interrupted"];

export interface RunRecord {
  runId: string;
  issueKey: string;
  status: RunStatus;
  phase: string;
  createdAt: string;
  updatedAt: string;
  previousRunId?: string;
  dispatcherPid: number;
  dispatcherHost: string;
  childPid?: number;
  jiraReserved: boolean;
  startCommentPosted: boolean;
  worktreePath?: string;
  workdir?: string;
  logDir: string;
  codexThreadId?: string;
  exitCode?: number | null;
  signal?: string | null;
  outcome?: string;
  prUrl?: string | null;
  summary?: string;
  jiraStatusAfter?: string;
  error?: { phase: string; message: string };
  finishedAt?: string;
}

interface StateFile {
  version: 1;
  runs: Record<string, RunRecord>;
}

/**
 * JSON state persisted with atomic replace (write temp file, then rename).
 * Only the process holding the dispatcher lock writes to it.
 */
export class StateStore {
  private state: StateFile;
  readonly filePath: string;

  constructor(
    readonly stateDir: string,
    private readonly now: () => Date = () => new Date()
  ) {
    this.filePath = join(stateDir, "state.json");
    mkdirSync(stateDir, { recursive: true });
    this.state = this.read();
  }

  reload(): void {
    this.state = this.read();
  }

  all(): RunRecord[] {
    return Object.values(this.state.runs).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  get(runId: string): RunRecord | undefined {
    return this.state.runs[runId];
  }

  forIssue(issueKey: string): RunRecord[] {
    return this.all().filter((run) => run.issueKey === issueKey);
  }

  latestForIssue(issueKey: string): RunRecord | undefined {
    return this.forIssue(issueKey).at(-1);
  }

  active(): RunRecord[] {
    return this.all().filter((run) => ACTIVE_STATUSES.includes(run.status));
  }

  activeForIssue(issueKey: string): RunRecord | undefined {
    return this.forIssue(issueKey).find((run) => ACTIVE_STATUSES.includes(run.status));
  }

  /** An issue is blocked when its most recent run ended in a status that needs an operator decision. */
  blockingRunForIssue(issueKey: string): RunRecord | undefined {
    const latest = this.latestForIssue(issueKey);
    return latest && BLOCKING_STATUSES.includes(latest.status) ? latest : undefined;
  }

  create(input: { issueKey: string; logDirRoot: string; previousRunId?: string }): RunRecord {
    if (this.activeForIssue(input.issueKey)) {
      throw new ConcurrencyError(`Já existe execução ativa para ${input.issueKey}.`);
    }
    const runId = randomUUID();
    const timestamp = this.now().toISOString();
    const run: RunRecord = {
      runId,
      issueKey: input.issueKey,
      status: "reserving",
      phase: "selected",
      createdAt: timestamp,
      updatedAt: timestamp,
      previousRunId: input.previousRunId,
      dispatcherPid: process.pid,
      dispatcherHost: hostname(),
      jiraReserved: false,
      startCommentPosted: false,
      logDir: join(input.logDirRoot, input.issueKey, runId)
    };
    this.state.runs[runId] = run;
    this.save();
    return run;
  }

  update(runId: string, patch: Partial<Omit<RunRecord, "runId" | "issueKey" | "createdAt">>): RunRecord {
    const current = this.state.runs[runId];
    if (!current) throw new Error(`Execução ${runId} não encontrada.`);
    const next: RunRecord = { ...current, ...patch, updatedAt: this.now().toISOString() };
    this.state.runs[runId] = next;
    this.save();
    return next;
  }

  private read(): StateFile {
    if (!existsSync(this.filePath)) return { version: 1, runs: {} };
    const parsed = JSON.parse(readFileSync(this.filePath, "utf8")) as StateFile;
    if (parsed.version !== 1 || typeof parsed.runs !== "object") {
      throw new Error(`Formato de estado não suportado em ${this.filePath}.`);
    }
    return parsed;
  }

  private save(): void {
    atomicWriteJson(this.filePath, this.state);
  }
}

export class ConcurrencyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConcurrencyError";
  }
}

export function atomicWriteJson(filePath: string, value: unknown): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const temp = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  // On Windows, antivirus or indexers can briefly hold the destination; retry a few times.
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(temp, filePath);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (attempt >= 5 || (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES")) {
        try {
          unlinkSync(temp);
        } catch {
          /* ignore */
        }
        throw error;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50 * (attempt + 1));
    }
  }
}

export function isProcessAlive(pid: number | undefined): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

interface LockInfo {
  pid: number;
  host: string;
  startedAt: string;
}

const INVALID_LOCK_STALE_AFTER_MS = 30_000;
const INVALID_LOCK_STABILITY_CHECK_MS = 50;

/**
 * Exclusive lock that guarantees a single dispatcher process per state directory.
 * A lock left by a dead process on the same host is reclaimed; a lock from another host is never stolen.
 */
export class ProcessLock {
  private held = false;
  readonly filePath: string;

  constructor(stateDir: string) {
    this.filePath = join(stateDir, "dispatcher.lock");
    mkdirSync(stateDir, { recursive: true });
  }

  tryAcquire(): { acquired: true } | { acquired: false; holder: LockInfo | undefined } {
    for (let attempt = 0; attempt < 2; attempt++) {
      const tempPath = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
      let tempCreated = false;
      let fd: number | undefined;
      try {
        fd = openSync(tempPath, "wx", 0o600);
        tempCreated = true;
        const info: LockInfo = { pid: process.pid, host: hostname(), startedAt: new Date().toISOString() };
        writeFileSync(fd, JSON.stringify(info));
        closeSync(fd);
        fd = undefined;
        // Publish only a complete lock record. Readers never see a newly created, empty file.
        linkSync(tempPath, this.filePath);
        try {
          unlinkSync(tempPath);
        } catch {
          /* a leftover staging link is harmless; the published lock is authoritative */
        }
        this.held = true;
        return { acquired: true };
      } catch (error) {
        if (fd !== undefined) {
          try {
            closeSync(fd);
          } catch {
            /* ignore cleanup errors and report the acquisition failure */
          }
        }
        if (tempCreated) {
          try {
            unlinkSync(tempPath);
          } catch {
            /* ignore cleanup errors and report the acquisition failure */
          }
        }
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const holder = this.readHolder();
        if (holder && holder.host === hostname() && !isProcessAlive(holder.pid)) {
          if (this.reclaimStaleLock(holder)) continue;
          return { acquired: false, holder: this.readHolder() };
        }
        if (!holder && this.reclaimStaleInvalidLock()) continue;
        return { acquired: false, holder };
      }
    }
    return { acquired: false, holder: this.readHolder() };
  }

  release(): void {
    if (!this.held) return;
    const holder = this.readHolder();
    if (holder?.pid === process.pid && holder.host === hostname()) {
      try {
        unlinkSync(this.filePath);
      } catch {
        /* ignore */
      }
    }
    this.held = false;
  }

  readHolder(): LockInfo | undefined {
    try {
      const value: unknown = JSON.parse(readFileSync(this.filePath, "utf8"));
      if (!isLockInfo(value)) return undefined;
      return value;
    } catch {
      return undefined;
    }
  }

  private reclaimStaleInvalidLock(): boolean {
    const initial = this.statLock();
    if (!initial || Date.now() - initial.mtimeMs < INVALID_LOCK_STALE_AFTER_MS) return false;

    return this.withRecoveryClaim(() => {
      // Give a writer time to finish and require the same file to remain unchanged before recovery.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, INVALID_LOCK_STABILITY_CHECK_MS);
      const stable = this.statLock();
      if (!stable || !sameLockSnapshot(initial, stable)) return false;

      if (this.readHolder()) return false;
      const finalCheck = this.statLock();
      if (!finalCheck || !sameLockSnapshot(stable, finalCheck)) return false;

      unlinkSync(this.filePath);
      return true;
    });
  }

  private reclaimStaleLock(expected: LockInfo): boolean {
    const initial = this.statLock();
    if (!initial || !sameLockInfo(this.readHolder(), expected)) return false;

    return this.withRecoveryClaim(() => {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, INVALID_LOCK_STABILITY_CHECK_MS);
      const stable = this.statLock();
      const holder = this.readHolder();
      if (!stable || !sameLockSnapshot(initial, stable) || !sameLockInfo(holder, expected)) return false;
      if (expected.host !== hostname() || isProcessAlive(expected.pid)) return false;

      const finalCheck = this.statLock();
      if (!finalCheck || !sameLockSnapshot(stable, finalCheck)) return false;
      unlinkSync(this.filePath);
      return true;
    });
  }

  private withRecoveryClaim(recover: () => boolean): boolean {
    const recoveryClaimPath = `${this.filePath}.recovery`;
    let claimFd: number | undefined;
    let ownsRecoveryClaim = false;
    try {
      claimFd = openSync(recoveryClaimPath, "wx", 0o600);
      ownsRecoveryClaim = true;
      writeFileSync(claimFd, JSON.stringify({ pid: process.pid, host: hostname(), startedAt: new Date().toISOString() }));
      closeSync(claimFd);
      claimFd = undefined;
      return recover();
    } catch {
      return false;
    } finally {
      if (claimFd !== undefined) {
        try {
          closeSync(claimFd);
        } catch {
          /* ignore cleanup errors */
        }
      }
      if (ownsRecoveryClaim) {
        try {
          unlinkSync(recoveryClaimPath);
        } catch {
          /* another process may have removed the claim */
        }
      }
    }
  }

  private statLock(): { dev: number; ino: number; size: number; mtimeMs: number } | undefined {
    try {
      const stat = statSync(this.filePath);
      return { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs };
    } catch {
      return undefined;
    }
  }
}

function isLockInfo(value: unknown): value is LockInfo {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<LockInfo>;
  return Number.isInteger(candidate.pid) && (candidate.pid ?? 0) > 0 &&
    typeof candidate.host === "string" && candidate.host.length > 0 &&
    typeof candidate.startedAt === "string" && candidate.startedAt.length > 0;
}

function sameLockSnapshot(
  left: { dev: number; ino: number; size: number; mtimeMs: number },
  right: { dev: number; ino: number; size: number; mtimeMs: number }
): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mtimeMs === right.mtimeMs;
}

function sameLockInfo(left: LockInfo | undefined, right: LockInfo): boolean {
  return left?.pid === right.pid && left.host === right.host && left.startedAt === right.startedAt;
}
