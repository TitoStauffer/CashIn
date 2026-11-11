import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { annotation, classifyRun, formatReport, main, readManifest, runMutations } from "./run.mjs";

// DEV-126: the runner is the evidence the QA reads, so its own failure modes are tested here — especially the
// ones that would let a mutation "pass" without proving anything.

function workspace() {
  const root = mkdtempSync(join(tmpdir(), "mutation-check-"));
  mkdirSync(join(root, "pkg", "src"), { recursive: true });
  mkdirSync(join(root, "mutations"));
  writeFileSync(join(root, "pkg", "src", "guard.js"), "export const limit = 10;\nexport function allowed(n) { return n <= limit; }\n");
  return root;
}

function manifest(root, mutations, ticket = "DEV-126") {
  writeFileSync(join(root, "mutations", "DEV-126.json"), JSON.stringify({ ticket, mutations }));
  return readManifest(root, "mutations/DEV-126.json");
}

const base = { id: "limit", package: "pkg", file: "pkg/src/guard.js", find: "n <= limit", replace: "n < limit", command: ["node", "check.js"] };

/** A fake test command: it fails when the mutated file contains `failsOn`, like a test catching the mutant. */
function fakeRunner(root, { failsOn, baseline = "passed" } = {}) {
  const calls = [];
  const original = readFileSync(join(root, "pkg", "src", "guard.js"), "utf8");
  return {
    calls,
    runCommand: () => {
      const content = readFileSync(join(root, "pkg", "src", "guard.js"), "utf8");
      const mutated = content !== original;
      calls.push(mutated ? "mutated" : "baseline");
      if (!mutated) return { status: baseline };
      return failsOn && content.includes(failsOn) ? { status: "failed", code: 1 } : { status: "passed", code: 0 };
    },
  };
}

test("a mutant the test catches is KILLED and the file is restored byte for byte", () => {
  const root = workspace();
  try {
    const before = readFileSync(join(root, "pkg", "src", "guard.js"));
    const { runCommand, calls } = fakeRunner(root, { failsOn: "n < limit" });
    const [result] = runMutations(manifest(root, [base]), { runCommand });
    assert.equal(result.outcome, "KILLED");
    assert.deepEqual(calls, ["baseline", "mutated"]);
    assert.deepEqual(readFileSync(join(root, "pkg", "src", "guard.js")), before);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a mutant the test does not catch SURVIVED, which fails the step", () => {
  const root = workspace();
  try {
    const { runCommand } = fakeRunner(root, { failsOn: "never-present" });
    assert.equal(runMutations(manifest(root, [base]), { runCommand })[0].outcome, "SURVIVED");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("an anchor that is missing or repeated makes the mutation NOT_APPLICABLE instead of passing vacuously", () => {
  const root = workspace();
  try {
    const { runCommand, calls } = fakeRunner(root, { failsOn: "x" });
    const missing = runMutations(manifest(root, [{ ...base, find: "n >= limit" }]), { runCommand })[0];
    assert.equal(missing.outcome, "NOT_APPLICABLE");
    assert.match(missing.detail, /occurs 0 times/);
    const repeated = runMutations(manifest(root, [{ ...base, find: "limit" }]), { runCommand })[0];
    assert.equal(repeated.outcome, "NOT_APPLICABLE");
    assert.match(repeated.detail, /occurs 2 times/);
    assert.ok(!calls.includes("mutated"), "a non-applicable mutation must not run the command mutated");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a command that fails without the mutation is BASELINE_FAILED, so a typo cannot fake a kill", () => {
  const root = workspace();
  try {
    const { runCommand, calls } = fakeRunner(root, { failsOn: "n < limit", baseline: "failed" });
    assert.equal(runMutations(manifest(root, [base]), { runCommand })[0].outcome, "BASELINE_FAILED");
    assert.deepEqual(calls, ["baseline"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("the baseline runs once per command, not once per mutation", () => {
  const root = workspace();
  try {
    const { runCommand, calls } = fakeRunner(root, { failsOn: "limit;" });
    const results = runMutations(manifest(root, [
      { ...base, id: "a", find: "n <= limit", replace: "n <= limit;" },
      { ...base, id: "b", find: "= 10;", replace: "= 10;;" },
    ]), { runCommand });
    assert.deepEqual(results.map((r) => r.outcome), ["KILLED", "KILLED"]);
    assert.equal(calls.filter((c) => c === "baseline").length, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a run that does not finish cleanly is INCONCLUSIVE, never counted as a kill", () => {
  const root = workspace();
  try {
    let first = true;
    const runCommand = () => { if (first) { first = false; return { status: "passed" }; } return { status: "timeout" }; };
    assert.equal(runMutations(manifest(root, [base]), { runCommand })[0].outcome, "INCONCLUSIVE");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("the file is restored even when the command throws", () => {
  const root = workspace();
  try {
    const before = readFileSync(join(root, "pkg", "src", "guard.js"));
    let first = true;
    const runCommand = () => { if (first) { first = false; return { status: "passed" }; } throw new Error("crash"); };
    assert.throws(() => runMutations(manifest(root, [base]), { runCommand }), /crash/);
    assert.deepEqual(readFileSync(join(root, "pkg", "src", "guard.js")), before);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a restore that does not bring the file back byte for byte is NOT_RESTORED, even when the mutant was killed", () => {
  const root = workspace();
  try {
    const { runCommand } = fakeRunner(root, { failsOn: "n < limit" });
    let writes = 0;
    // The second write is the restore; it leaves a trailing newline behind, as a botched restore would.
    const writeFile = (path, content) => writeFileSync(path, ++writes === 2 ? `${content}\n` : content);
    const [result] = runMutations(manifest(root, [base]), { runCommand, writeFile });
    assert.equal(result.outcome, "NOT_RESTORED");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a manifest is refused when it could escape its package, run another program, or mutate nothing", () => {
  const root = workspace();
  try {
    assert.throws(() => manifest(root, [{ ...base, file: "pkg/../outside.js" }]), /must be inside its package/);
    assert.throws(() => manifest(root, [{ ...base, package: "../elsewhere" }]), /inside the repository/);
    assert.throws(() => manifest(root, [{ ...base, command: ["bash", "-c", "true"] }]), /not allowed/);
    assert.throws(() => manifest(root, [{ ...base, replace: base.find }]), /identical/);
    assert.throws(() => manifest(root, [base, base]), /duplicate id/);
    assert.throws(() => manifest(root, [base], "dev126"), /Jira key/);
    assert.throws(() => manifest(root, []), /non-empty list/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// End to end: a throwaway git repository, a real `node` test command and the manifest selection by diff.
function gitRepository() {
  const root = workspace();
  const git = (...args) => {
    const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
    if (result.status !== 0) throw new Error(result.stderr);
  };
  writeFileSync(join(root, "pkg", "check.mjs"),
    'import { readFileSync } from "node:fs";\nprocess.exit(readFileSync("src/guard.js", "utf8").includes("n <= limit") ? 0 : 1);\n');
  git("init", "-q");
  git("-c", "user.email=ci@example.invalid", "-c", "user.name=ci", "commit", "-q", "--allow-empty", "-m", "base");
  git("add", ".");
  git("-c", "user.email=ci@example.invalid", "-c", "user.name=ci", "commit", "-q", "-m", "code");
  return { root, git };
}

function commitManifest({ root, git }, name, mutations) {
  writeFileSync(join(root, "mutations", name), JSON.stringify({ ticket: "DEV-126", mutations }));
  git("add", ".");
  git("-c", "user.email=ci@example.invalid", "-c", "user.name=ci", "commit", "-q", "-m", name);
}

const realMutation = { ...base, command: ["node", "check.mjs"] };

/**
 * Runs main with its report and annotations captured: a deliberately failing case would otherwise print a real
 * `::error` workflow command and leave a red annotation on a green CI job.
 */
function quietMain(argv, root) {
  const out = process.stdout.write, err = process.stderr.write, summary = process.env.GITHUB_STEP_SUMMARY;
  process.stdout.write = () => true;
  process.stderr.write = () => true;
  // In CI the fixtures' tables would otherwise land in the job summary next to the real mutation evidence.
  delete process.env.GITHUB_STEP_SUMMARY;
  try { return main(argv, root); } finally {
    process.stdout.write = out; process.stderr.write = err;
    if (summary !== undefined) process.env.GITHUB_STEP_SUMMARY = summary;
  }
}

test("main runs the manifests the branch changed with the real command and exits 0 only when every mutant is killed", () => {
  const repo = gitRepository();
  try {
    commitManifest(repo, "DEV-126.json", [realMutation]);
    assert.equal(quietMain(["--base", "HEAD~2", "--package", "pkg"], repo.root), 0);
    commitManifest(repo, "DEV-126.json", [{ ...realMutation, find: "= 10;", replace: "= 11;" }]);
    assert.equal(quietMain(["--base", "HEAD~1", "--package", "pkg"], repo.root), 1, "a surviving mutant must fail the step");
  } finally { rmSync(repo.root, { recursive: true, force: true }); }
});

test("main ignores manifests the branch did not touch and other packages' mutants", () => {
  const repo = gitRepository();
  try {
    commitManifest(repo, "DEV-1.json", [{ ...realMutation, find: "= 10;", replace: "= 11;" }]);
    commitManifest(repo, "DEV-126.json", [realMutation]);
    assert.equal(quietMain(["--base", "HEAD~1", "--package", "pkg"], repo.root), 0, "the old surviving manifest is history, not this PR");
    assert.equal(quietMain(["--base", "HEAD~2", "--package", "other"], repo.root), 0);
  } finally { rmSync(repo.root, { recursive: true, force: true }); }
});

test("main refuses a mutant whose package no CI job runs, instead of every job skipping it", () => {
  const repo = gitRepository();
  try {
    commitManifest(repo, "DEV-126.json", [realMutation]);
    assert.throws(() => quietMain(["--base", "HEAD~1", "--package", "tools", "--covered-elsewhere", "apps/api"], repo.root), /no CI job runs the package/);
    assert.equal(quietMain(["--base", "HEAD~1", "--package", "tools", "--covered-elsewhere", "pkg"], repo.root), 0);
  } finally { rmSync(repo.root, { recursive: true, force: true }); }
});

test("only a normal exit is passed or failed: a death by signal, a timeout or a spawn error is not a kill", () => {
  assert.equal(classifyRun({ status: 1, signal: null, stdout: "", stderr: "" }).status, "failed");
  assert.equal(classifyRun({ status: 0, signal: null, stdout: "", stderr: "" }).status, "passed");
  assert.equal(classifyRun({ status: null, signal: "SIGKILL", stdout: "", stderr: "" }).status, "signal");
  assert.equal(classifyRun({ status: null, signal: "SIGTERM", error: Object.assign(new Error("t"), { code: "ETIMEDOUT" }) }).status, "timeout");
  const overflow = classifyRun({ status: null, signal: "SIGTERM", error: Object.assign(new Error("spawnSync node ENOBUFS"), { code: "ENOBUFS" }) });
  assert.equal(overflow.status, "error");
  assert.match(overflow.detail, /ENOBUFS/, "the reason must reach the report instead of a bare (error)");
});

test("a mutated run killed by a signal is INCONCLUSIVE and its reason and output tail reach the result", () => {
  const root = workspace();
  try {
    let first = true;
    const runCommand = () => {
      if (first) { first = false; return { status: "passed" }; }
      return classifyRun({ status: null, signal: "SIGKILL", stdout: "line 1\nlast line", stderr: "" });
    };
    const [result] = runMutations(manifest(root, [base]), { runCommand });
    assert.equal(result.outcome, "INCONCLUSIVE");
    assert.match(result.detail, /terminated by SIGKILL/);
    assert.match(result.output, /last line/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("manifest strings cannot break the report table or the error annotation", () => {
  const mutation = { ticket: "DEV-1", id: "a|b`c\nd", file: "pkg/x|y.js" };
  const row = formatReport([{ mutation, outcome: "SURVIVED", detail: "x|y" }], ["pkg"]).split("\n").at(-1);
  assert.equal(row, "| DEV-1 | a\\|b'c d | `pkg/x\\|y.js` | SURVIVED | x\\|y |");
  assert.equal(annotation("50%\nnext"), "50%25%0Anext");
});

test("main runs a manifest the branch renamed and edited, instead of skipping it as a rename", () => {
  const repo = gitRepository();
  try {
    // The edit is tiny so git still pairs the two paths as a rename (R) rather than a delete plus an add.
    const surviving = { ...realMutation, find: "= 10;", replace: "= 11;" };
    commitManifest(repo, "DEV-1.json", [{ ...surviving, timeoutSeconds: 600 }]);
    repo.git("mv", "mutations/DEV-1.json", "mutations/DEV-126.json");
    commitManifest(repo, "DEV-126.json", [{ ...surviving, timeoutSeconds: 601 }]);
    assert.equal(quietMain(["--base", "HEAD~1", "--package", "pkg"], repo.root), 1, "the renamed manifest's surviving mutant must run");
  } finally { rmSync(repo.root, { recursive: true, force: true }); }
});

test("main runs a manifest whose name git would quote, and refuses anything under mutations/ that is not a manifest", () => {
  const repo = gitRepository();
  try {
    commitManifest(repo, "DEV-126-ç.json", [{ ...realMutation, find: "= 10;", replace: "= 11;" }]);
    assert.equal(quietMain(["--base", "HEAD~1", "--package", "pkg"], repo.root), 1, "the quoted manifest's surviving mutant must run");
    writeFileSync(join(repo.root, "mutations", "notes.txt"), "not a manifest");
    repo.git("add", ".");
    repo.git("-c", "user.email=ci@example.invalid", "-c", "user.name=ci", "commit", "-q", "-m", "notes");
    assert.throws(() => quietMain(["--base", "HEAD~1", "--package", "pkg"], repo.root), /only mutations\/<TICKET>\.json/);
  } finally { rmSync(repo.root, { recursive: true, force: true }); }
});
