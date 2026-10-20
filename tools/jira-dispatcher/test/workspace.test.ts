import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { GitWorkspace } from "../src/workspace.js";
import { makeConfig, tempDir } from "./helpers.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

/** Creates a bare "origin" with one commit on master and a clone of it. */
function repoWithOrigin() {
  const root = tempDir("dispatcher-git-");
  const origin = join(root, "origin.git");
  const seed = join(root, "seed");
  const clone = join(root, "SaldoCerto2.0");
  execFileSync("git", ["init", "--bare", "-b", "master", origin]);
  execFileSync("git", ["init", "-b", "master", seed]);
  git(seed, "config", "user.email", "test@example.com");
  git(seed, "config", "user.name", "Test");
  writeFileSync(join(seed, "AGENTS.md"), "# rules\n");
  git(seed, "add", ".");
  git(seed, "commit", "-m", "init");
  git(seed, "remote", "add", "origin", origin);
  git(seed, "push", "origin", "master");
  execFileSync("git", ["clone", origin, clone]);
  return { root, origin, seed, clone };
}

describe("GitWorkspace", () => {
  it("creates a detached worktree at the latest remote default branch, leaving the main checkout untouched", async () => {
    const { root, seed, clone } = repoWithOrigin();
    git(clone, "checkout", "-b", "feature/DEV-9-local-work");
    // A newer commit lands on origin/master after the clone.
    writeFileSync(join(seed, "new.txt"), "x");
    git(seed, "add", ".");
    git(seed, "commit", "-m", "newer");
    git(seed, "push", "origin", "master");

    const config = makeConfig({ repoPath: clone, stateDir: join(root, "state"), worktree: { enabled: true, baseDir: join(root, "wt") } }, root);
    const workspace = new GitWorkspace(config);
    await workspace.verifyRepository();
    const prepared = await workspace.prepare("DEV-10", "1234567890abcdef");

    assert.equal(prepared.workdir, join(root, "wt", "DEV-10-12345678"));
    assert.ok(existsSync(join(prepared.workdir, "AGENTS.md")), "AGENTS.md is available to Codex in the worktree");
    assert.ok(existsSync(join(prepared.workdir, "new.txt")), "worktree starts from the fetched origin/master");
    assert.equal(git(prepared.workdir, "rev-parse", "--abbrev-ref", "HEAD"), "HEAD", "detached: the PM agent creates the branch");
    assert.equal(git(clone, "rev-parse", "--abbrev-ref", "HEAD"), "feature/DEV-9-local-work", "main checkout untouched");
    assert.deepEqual(prepared.extraWritableDirs, [join(clone, ".git")]);

    const snapshot = await workspace.snapshot(prepared.workdir);
    assert.equal(snapshot.exists, true);
    assert.equal(snapshot.dirtyFiles, 0);

    await assert.rejects(() => workspace.prepare("DEV-10", "1234567890abcdef"), /já existe/);
  });

  it("in checkout mode, refuses to start on a dirty working tree", async () => {
    const { root, clone } = repoWithOrigin();
    writeFileSync(join(clone, "wip.txt"), "uncommitted");
    const config = makeConfig({ repoPath: clone, stateDir: join(root, "state"), worktree: { enabled: false } }, root);
    await assert.rejects(() => new GitWorkspace(config).prepare("DEV-10", "abcdefgh"), /alterações locais/);
  });

  it("reports a missing default branch", async () => {
    const { root, clone } = repoWithOrigin();
    const config = makeConfig({ repoPath: clone, defaultBranch: "main", stateDir: join(root, "state") }, root);
    await assert.rejects(() => new GitWorkspace(config).verifyRepository(), /git rev-parse falhou/);
  });
});
