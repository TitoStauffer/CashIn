#!/usr/bin/env node
// Applies the mutations a delivery declares and requires each one to be killed by its test (DEV-126).
//
// Mutation used to run only on the developer's machine, so the QA agent, which does not execute commands,
// could never audit it. This runner makes it a CI step whose outcome the QA reads from the job metadata.
//
// A manifest lives in `mutations/<TICKET>.json`. Only the manifests the Pull Request adds or changes are run:
// old manifests stay as a record, but re-running them forever would grow the cost with history and fail as
// soon as a later delivery legitimately rewrites an anchor.
//
// Each mutation fails the step when:
//   - its anchor (`find`) does not occur exactly once in the file — the mutation is not applicable, and
//     "passing" it would be vacuous;
//   - its command still succeeds with the mutation applied — the mutant survived, so the test does not
//     protect what the delivery says it protects;
//   - the file is not byte-for-byte back to the original afterwards — a mutation must never leak into the
//     build or into the next mutation.
// Before any mutation, each distinct command runs once unmutated and must pass: otherwise a command that
// fails for an unrelated reason (a typo, a missing script) would make every mutant look killed.
//
// This runs the Pull Request's own tests, so it belongs to the unprivileged CI job only.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

/** Commands a manifest may run. The runner executes PR code anyway; the allowlist only keeps it to test runners. */
export const ALLOWED_EXECUTABLES = new Set(["node", "npm", "npx"]);
const DEFAULT_TIMEOUT_SECONDS = 600;

const sha256 = (buffer) => createHash("sha256").update(buffer).digest("hex");

function inside(root, candidate) {
  const rel = relative(root, candidate);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/** Reads and validates one manifest; returns its mutations or throws with a message that names the problem. */
export function readManifest(repoRoot, manifestPath) {
  const raw = JSON.parse(readFileSync(join(repoRoot, manifestPath), "utf8"));
  if (!raw || typeof raw.ticket !== "string" || !/^[A-Z]+-\d+$/.test(raw.ticket)) {
    throw new Error(`${manifestPath}: "ticket" must be a Jira key such as DEV-126.`);
  }
  if (!Array.isArray(raw.mutations) || raw.mutations.length === 0) {
    throw new Error(`${manifestPath}: "mutations" must be a non-empty list.`);
  }
  const ids = new Set();
  return raw.mutations.map((mutation, index) => {
    const where = `${manifestPath} mutation #${index + 1}`;
    for (const key of ["id", "package", "file", "find", "replace"]) {
      if (typeof mutation?.[key] !== "string" || mutation[key] === "") throw new Error(`${where}: "${key}" must be a non-empty string.`);
    }
    if (mutation.find === mutation.replace) throw new Error(`${where}: "find" and "replace" are identical, so nothing would be mutated.`);
    if (ids.has(mutation.id)) throw new Error(`${where}: duplicate id "${mutation.id}".`);
    ids.add(mutation.id);
    if (!Array.isArray(mutation.command) || mutation.command.length === 0 || mutation.command.some((part) => typeof part !== "string")) {
      throw new Error(`${where}: "command" must be a non-empty list of strings.`);
    }
    if (!ALLOWED_EXECUTABLES.has(mutation.command[0])) {
      throw new Error(`${where}: command "${mutation.command[0]}" is not allowed; use one of ${[...ALLOWED_EXECUTABLES].join(", ")}.`);
    }
    const packageDir = resolve(repoRoot, normalize(mutation.package));
    const file = resolve(repoRoot, normalize(mutation.file));
    if (!inside(repoRoot, packageDir)) throw new Error(`${where}: "package" must be a directory inside the repository.`);
    if (!inside(packageDir, file)) throw new Error(`${where}: "file" must be inside its package (${mutation.package}).`);
    const timeoutSeconds = mutation.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS;
    if (!Number.isInteger(timeoutSeconds) || timeoutSeconds <= 0) throw new Error(`${where}: "timeoutSeconds" must be a positive integer.`);
    return { ticket: raw.ticket, manifest: manifestPath, ...mutation, packageDir, filePath: file, timeoutSeconds };
  });
}

/** Output a full test suite can print; the default 1 MiB would turn a verbose suite into a spurious error. */
const MAX_OUTPUT_BYTES = 256 * 1024 * 1024;
const OUTPUT_TAIL_LINES = 40;

/**
 * Maps a spawnSync result to the runner's statuses. Only a normal exit counts as passed or failed: a timeout,
 * a spawn error or a death by signal (an OOM kill, for example) proves nothing about the mutant.
 */
export function classifyRun(result) {
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.split(/\r?\n/).slice(-OUTPUT_TAIL_LINES).join("\n");
  if (result.error?.code === "ETIMEDOUT") return { status: "timeout", output };
  if (result.error) return { status: "error", detail: result.error.message, output };
  if (result.signal) return { status: "signal", detail: `terminated by ${result.signal}`, output };
  return { status: result.status === 0 ? "passed" : "failed", code: result.status, output };
}

function run(command, cwd, timeoutSeconds) {
  const executable = process.platform === "win32" && command[0] !== "node" ? `${command[0]}.cmd` : command[0];
  return classifyRun(spawnSync(executable, command.slice(1), {
    cwd, encoding: "utf8", timeout: timeoutSeconds * 1000, maxBuffer: MAX_OUTPUT_BYTES,
    shell: process.platform === "win32" && command[0] !== "node", env: process.env,
  }));
}

const describe = (outcome) => (outcome.detail ? `${outcome.status}: ${outcome.detail}` : outcome.status);

/**
 * Runs every mutation and returns one result per mutation plus the baseline outcome per command.
 * `runCommand` and `writeFile` are injectable so the runner can be tested without spawning real test suites
 * and so the restoration check can be proven to catch a restore that went wrong.
 */
export function runMutations(mutations, { runCommand = run, writeFile = writeFileSync } = {}) {
  const results = [];
  const baselines = new Map();
  for (const mutation of mutations) {
    const key = `${mutation.packageDir}\0${JSON.stringify(mutation.command)}`;
    if (!baselines.has(key)) baselines.set(key, runCommand(mutation.command, mutation.packageDir, mutation.timeoutSeconds));
    const baseline = baselines.get(key);
    if (baseline.status !== "passed") {
      results.push({ mutation, outcome: "BASELINE_FAILED", detail: `the command does not pass without the mutation (${describe(baseline)})`, output: baseline.output });
      continue;
    }
    if (!existsSync(mutation.filePath)) {
      results.push({ mutation, outcome: "NOT_APPLICABLE", detail: "the file does not exist" });
      continue;
    }
    const original = readFileSync(mutation.filePath);
    const text = original.toString("utf8");
    const occurrences = text.split(mutation.find).length - 1;
    if (occurrences !== 1) {
      results.push({ mutation, outcome: "NOT_APPLICABLE", detail: `the anchor occurs ${occurrences} times; it must occur exactly once` });
      continue;
    }
    const originalHash = sha256(original);
    let outcome;
    try {
      writeFile(mutation.filePath, text.replace(mutation.find, () => mutation.replace));
      outcome = runCommand(mutation.command, mutation.packageDir, mutation.timeoutSeconds);
    } finally {
      writeFile(mutation.filePath, original);
    }
    if (sha256(readFileSync(mutation.filePath)) !== originalHash) {
      results.push({ mutation, outcome: "NOT_RESTORED", detail: "the file differs from the original after the run" });
    } else if (outcome.status === "failed") {
      results.push({ mutation, outcome: "KILLED", detail: `exit code ${outcome.code}` });
    } else if (outcome.status === "passed") {
      results.push({ mutation, outcome: "SURVIVED", detail: "the command still passes with the mutation applied" });
    } else {
      results.push({ mutation, outcome: "INCONCLUSIVE", detail: `the mutated run did not finish cleanly (${describe(outcome)})`, output: outcome.output });
    }
  }
  return results;
}

/** Manifests under `mutations/` that the Pull Request added or changed, compared with `base`. */
export function changedManifests(repoRoot, base) {
  const result = spawnSync("git", ["diff", "--name-only", "--no-renames", "--diff-filter=AM", base, "HEAD", "--", "mutations/"], { cwd: repoRoot, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git diff against ${base} failed: ${result.stderr.trim()}`);
  return result.stdout.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.endsWith(".json"));
}

/** A Markdown table cell: manifest strings must not break the row or open a code span. */
const cell = (value) => String(value).replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/`/g, "'").replace(/[\r\n]+/g, " ");
/** A workflow command message, escaped as GitHub Actions requires. */
export const annotation = (value) => String(value).replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");

export function formatReport(results, packages) {
  const lines = [`### Verificação por mutação (${packages.map(cell).join(", ")})`, ""];
  if (results.length === 0) {
    lines.push("Nenhum mutante declarado para este pacote nos manifestos alterados por este Pull Request.");
  } else {
    lines.push("| Ticket | Mutante | Arquivo | Resultado | Detalhe |", "| --- | --- | --- | --- | --- |");
    for (const { mutation, outcome, detail } of results) {
      lines.push(`| ${cell(mutation.ticket)} | ${cell(mutation.id)} | \`${cell(mutation.file)}\` | ${outcome} | ${cell(detail)} |`);
    }
  }
  return lines.join("\n");
}

function report(results, packages) {
  const text = formatReport(results, packages);
  process.stdout.write(`${text}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${text}\n\n`);
  // The tail of the command output explains a baseline or run that failed for a reason other than the mutant.
  for (const { mutation, outcome, output } of results) {
    if (!output) continue;
    process.stdout.write(`::group::${annotation(`${mutation.id} (${outcome}): últimas linhas da saída`)}\n${output}\n::endgroup::\n`);
  }
}

const toPosix = (path) => normalize(path).split(sep).join("/");

function parseArgs(argv) {
  const packages = [];
  const coveredElsewhere = [];
  let base;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--package") packages.push(toPosix(argv[++i] ?? ""));
    else if (argv[i] === "--covered-elsewhere") coveredElsewhere.push(toPosix(argv[++i] ?? ""));
    else if (argv[i] === "--base") base = argv[++i];
    else throw new Error(`unknown argument ${argv[i]}`);
  }
  if (packages.length === 0 || packages.some((p) => !p)) throw new Error("pass at least one --package <dir>.");
  if (!base) throw new Error("pass --base <git ref> to select the manifests this Pull Request changed.");
  return { packages, coveredElsewhere, base };
}

export function main(argv, repoRoot = process.cwd()) {
  const { packages, coveredElsewhere, base } = parseArgs(argv);
  const manifests = changedManifests(repoRoot, base);
  const declared = manifests.flatMap((manifest) => readManifest(repoRoot, manifest));
  // A mutant whose package no CI job runs would be silently skipped by every job. The job that passes
  // --covered-elsewhere knows the full package list and refuses that instead of reporting green.
  if (coveredElsewhere.length > 0) {
    const orphan = declared.filter((mutation) => ![...packages, ...coveredElsewhere].includes(toPosix(mutation.package)));
    if (orphan.length > 0) {
      throw new Error(`no CI job runs the package of: ${orphan.map((m) => `${m.manifest} ${m.id} (${m.package})`).join(", ")}. Use one of ${[...packages, ...coveredElsewhere].join(", ")}.`);
    }
  }
  const mutations = declared.filter((mutation) => packages.includes(toPosix(mutation.package)));
  const results = runMutations(mutations);
  report(results, packages);
  const failed = results.filter((result) => result.outcome !== "KILLED");
  if (failed.length > 0) {
    process.stderr.write(`::error title=Verificação por mutação::${annotation(`${failed.length} mutante(s) não foram mortos: ${failed.map((r) => `${r.mutation.id} (${r.outcome})`).join(", ")}`)}\n`);
    return 1;
  }
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`::error title=Verificação por mutação::${annotation(error.message)}\n`);
    process.exitCode = 1;
  }
}
