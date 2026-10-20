import { execFile } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import type { DispatcherConfig } from "./config.js";

const execFileAsync = promisify(execFile);

export interface PreparedWorkspace {
  /** Directory where Codex runs. */
  workdir: string;
  /** Worktree created for the run, when worktree mode is enabled. */
  worktreePath?: string;
  /** Extra directories Codex needs to write (the shared .git directory of a worktree). */
  extraWritableDirs: string[];
}

export interface WorkspaceSnapshot {
  exists: boolean;
  branch?: string;
  head?: string;
  dirtyFiles?: number;
}

export interface Workspace {
  prepare(issueKey: string, runId: string): Promise<PreparedWorkspace>;
  reuse(workdir: string, worktreePath?: string): Promise<PreparedWorkspace>;
  snapshot(workdir: string): Promise<WorkspaceSnapshot>;
  verifyRepository(): Promise<void>;
}

export class WorkspaceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceError";
  }
}

/**
 * Prepares the directory Codex runs in. It never creates branches, commits, pushes or deletes anything:
 * in worktree mode it only adds a detached worktree at the up-to-date default branch, so the
 * Product Manager agent can create the issue branch as AGENTS.md requires.
 */
export class GitWorkspace implements Workspace {
  constructor(private readonly config: DispatcherConfig) {}

  async verifyRepository(): Promise<void> {
    const inside = await this.git(this.config.repoPath, ["rev-parse", "--is-inside-work-tree"]);
    if (inside.trim() !== "true") throw new WorkspaceError(`${this.config.repoPath} não é um repositório Git.`);
    await this.git(this.config.repoPath, ["rev-parse", "--verify", `refs/heads/${this.config.defaultBranch}`]).catch(async () => {
      await this.git(this.config.repoPath, ["rev-parse", "--verify", `refs/remotes/${this.config.remote}/${this.config.defaultBranch}`]);
    });
  }

  async prepare(issueKey: string, runId: string): Promise<PreparedWorkspace> {
    const { repoPath, remote, defaultBranch } = this.config;

    if (!this.config.worktree.enabled) {
      const status = await this.git(repoPath, ["status", "--porcelain"]);
      if (status.trim() !== "") {
        throw new WorkspaceError("O checkout principal tem alterações locais; o dispatcher não inicia execuções sobre ele.");
      }
      return { workdir: repoPath, extraWritableDirs: [] };
    }

    await this.git(repoPath, ["fetch", remote, defaultBranch]);
    mkdirSync(this.config.worktree.baseDir, { recursive: true });
    const worktreePath = join(this.config.worktree.baseDir, `${issueKey}-${runId.slice(0, 8)}`);
    if (existsSync(worktreePath)) throw new WorkspaceError(`A worktree ${worktreePath} já existe.`);
    await this.git(repoPath, ["worktree", "add", "--detach", worktreePath, `${remote}/${defaultBranch}`]);
    return { workdir: worktreePath, worktreePath, extraWritableDirs: [await this.commonGitDir()] };
  }

  async reuse(workdir: string, worktreePath?: string): Promise<PreparedWorkspace> {
    if (!existsSync(workdir)) throw new WorkspaceError(`O diretório da execução anterior não existe: ${workdir}`);
    return { workdir, worktreePath, extraWritableDirs: worktreePath ? [await this.commonGitDir()] : [] };
  }

  async snapshot(workdir: string): Promise<WorkspaceSnapshot> {
    if (!existsSync(workdir)) return { exists: false };
    const [branch, head, status] = await Promise.all([
      this.git(workdir, ["rev-parse", "--abbrev-ref", "HEAD"]).catch(() => ""),
      this.git(workdir, ["rev-parse", "--short", "HEAD"]).catch(() => ""),
      this.git(workdir, ["status", "--porcelain"]).catch(() => "")
    ]);
    return {
      exists: true,
      branch: branch.trim() || undefined,
      head: head.trim() || undefined,
      dirtyFiles: status.split("\n").filter((line) => line.trim() !== "").length
    };
  }

  private async commonGitDir(): Promise<string> {
    const dir = await this.git(this.config.repoPath, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    return normalizeGitPath(dir.trim());
  }

  private async git(cwd: string, args: string[]): Promise<string> {
    try {
      const { stdout } = await execFileAsync("git", args, { cwd, windowsHide: true, maxBuffer: 10 * 1024 * 1024 });
      return stdout;
    } catch (error) {
      const stderr = String((error as { stderr?: string }).stderr ?? "").trim();
      throw new WorkspaceError(`git ${args[0]} falhou${stderr ? `: ${stderr.slice(0, 500)}` : ""}`);
    }
  }
}

/** Git for Windows can emit MSYS paths; convert them before passing paths to Windows clients. */
function normalizeGitPath(value: string): string {
  if (process.platform !== "win32") return value;

  const drivePath = value.match(/^\/([a-z]):\/(.*)$/i);
  if (drivePath) return `${drivePath[1]!.toUpperCase()}:\\${drivePath[2]!.replaceAll("/", "\\")}`;

  const msysPath = value.match(/^\/([a-z])\/(.*)$/i);
  if (msysPath) return `${msysPath[1]!.toUpperCase()}:\\${msysPath[2]!.replaceAll("/", "\\")}`;

  return value;
}
