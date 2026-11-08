import { createHash } from 'node:crypto';
import { requestGitHubApi } from './github-api-client.js';

export const ACTIONS_APP_ID = 15368;
const WORKFLOW_PATH = '.github/workflows/ci.yml';
const MAX_RESPONSE_BYTES = 100_000;
const MAX_JOB_STEPS = 40;
const EMPTY_STEPS_ATTEMPTS = 4;
const EMPTY_STEPS_DELAY_MS = 3_000;
const MAX_SNAPSHOT_BYTES = 32_000;
const STATES = new Set(['queued', 'in_progress', 'completed', 'waiting', 'pending', 'requested']);
const CONCLUSIONS = new Set(['success', 'failure', 'neutral', 'cancelled', 'skipped', 'timed_out', 'action_required', 'stale', 'startup_failure']);

export type AgentActionsEvidence = { availability: 'unavailable'; reason: string } | {
  availability: 'available';
  repository: string;
  headSha: string;
  workflowPath: string;
  runId: number;
  jobId: number;
  detailsUrl: string;
  runStatus: string;
  runConclusion: string | null;
  steps: Array<{ number: number; name: string; status: string; conclusion: string | null }>;
};

/** Injection point for tests: real waiting would make the empty-step cases slow instead of fast. */
export interface EmptyStepsRetry {
  attempts?: number;
  delayMs?: number;
  wait?: (ms: number) => Promise<void>;
}

export interface AgentCiSnapshot {
  path: string;
  headSha: string;
  originalSha256: string;
  content: string;
}

export function unavailableActionsEvidence(): AgentActionsEvidence {
  return { availability: 'unavailable', reason: 'Verified GitHub Actions job evidence is unavailable.' };
}

export async function loadActionsEvidence(
  fetchImpl: typeof fetch, repository: string, pullRequestNumber: number, headSha: string,
  check: Record<string, unknown>, token: string, retry: EmptyStepsRetry = {},
): Promise<AgentActionsEvidence> {
  // Never follow the check's URL: validate it, then construct API paths ourselves.
  const details = typeof check.details_url === 'string' ? new URL(check.details_url, 'https://invalid.test') : undefined;
  const prefix = `/${repository}/actions/runs/`;
  const suffix = details?.pathname.startsWith(prefix) ? details.pathname.slice(prefix.length).match(/^(\d+)\/job\/(\d+)$/) : null;
  if (record(check.app)?.id !== ACTIONS_APP_ID || !details || details.origin !== 'https://github.com'
    || details.username || details.password || details.search || details.hash || !suffix
    || !positiveId(check.id) || !positiveId(Number(suffix[1])) || !positiveId(Number(suffix[2]))) return unavailableActionsEvidence();

  const runId = Number(suffix[1]);
  const jobId = Number(suffix[2]);
  const read = (path: string) => requestGitHubApi<Record<string, unknown>>(fetchImpl, `/repos/${repository}${path}`, token, { maxResponseBytes: MAX_RESPONSE_BYTES });
  const [job, run] = await Promise.all([readJobUntilStepsPublished(read, jobId, retry), read(`/actions/runs/${runId}`)]);
  const associatedPr = Array.isArray(run.pull_requests) ? run.pull_requests.map(record).find((pr) => pr?.number === pullRequestNumber) : undefined;
  if (job.id !== jobId || job.run_id !== runId || job.id !== check.id
    || job.head_sha !== headSha || run.head_sha !== headSha || check.head_sha !== headSha
    || job.name !== check.name || job.status !== check.status || job.conclusion !== check.conclusion
    || job.check_run_url !== `https://api.github.com/repos/${repository}/check-runs/${check.id}`
    || job.html_url !== details.href || run.id !== runId || run.path !== WORKFLOW_PATH || run.event !== 'pull_request'
    || record(run.repository)?.full_name !== repository || record(run.head_repository)?.full_name !== repository
    || !positiveId(run.check_suite_id) || run.check_suite_id !== record(check.check_suite)?.id
    || record(associatedPr?.head)?.sha !== headSha) {
    throw new Error('GitHub Actions evidence does not match the current repository, PR, workflow, check, and HEAD SHA.');
  }
  // One message for three conditions cost a whole investigation: the log said "missing or exceed the
  // supported limit" and sent me looking at the 40-step limit while the real cause was an empty list.
  if (!Array.isArray(job.steps)) throw new Error('GitHub Actions job evidence carries no step list.');
  if (job.steps.length === 0) throw new Error('GitHub Actions job evidence still carries an empty step list after every retry.');
  if (job.steps.length > MAX_JOB_STEPS) throw new Error(`GitHub Actions job evidence carries more steps than the supported limit of ${MAX_JOB_STEPS}.`);
  const steps = job.steps.map((value) => {
    const step = record(value);
    if (!step || !positiveId(step.number) || typeof step.name !== 'string' || step.name.length === 0 || step.name.length > 160) {
      throw new Error('GitHub Actions returned invalid step evidence.');
    }
    return { number: step.number, name: step.name, status: state(step.status), conclusion: conclusion(step.conclusion) };
  });
  if (new Set(steps.map(({ number }) => number)).size !== steps.length) throw new Error('GitHub Actions returned duplicate step evidence.');
  return {
    availability: 'available', repository, headSha, workflowPath: WORKFLOW_PATH, runId, jobId, detailsUrl: details.href,
    runStatus: state(run.status), runConclusion: conclusion(run.conclusion), steps,
  };
}

// An empty step list is not the same as absent evidence. The orchestration starts from the CI
// workflow's `workflow_run` event, so GitHub has already published the job's conclusion while
// `/actions/jobs/{id}` can still answer `steps: []` for a few seconds. Failing on the first read
// turned that race into a review aborted before any analysis and a gate left INCONCLUSIVE waiting for
// a report that would never come, recoverable only by dispatching the orchestration by hand.
//
// So re-read before deciding — and keep failing closed afterwards: a list that is still empty once the
// attempts run out stays a refusal, because evidence that never arrives must never become an approval.
// Only an empty array is retried. An absent or non-array `steps` is a malformed payload rather than a
// publication delay, and retrying it would only postpone the same refusal.
async function readJobUntilStepsPublished(
  read: (path: string) => Promise<Record<string, unknown>>, jobId: number, retry: EmptyStepsRetry,
): Promise<Record<string, unknown>> {
  const attempts = retry.attempts ?? EMPTY_STEPS_ATTEMPTS;
  const delayMs = retry.delayMs ?? EMPTY_STEPS_DELAY_MS;
  const wait = retry.wait ?? ((ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); }));
  let job = await read(`/actions/jobs/${jobId}`);
  for (let attempt = 1; attempt < attempts && Array.isArray(job.steps) && job.steps.length === 0; attempt += 1) {
    await wait(delayMs);
    job = await read(`/actions/jobs/${jobId}`);
  }
  return job;
}

export async function loadCiSnapshots(fetchImpl: typeof fetch, repository: string, headSha: string, token: string): Promise<AgentCiSnapshot[]> {
  const snapshots: AgentCiSnapshot[] = [];
  for (const path of [
    WORKFLOW_PATH,
    'apps/api/package.json',
    'apps/web/package.json',
    'tools/github-reviewer/package.json',
    'tools/jira-dispatcher/package.json',
  ]) {
    const payload = await requestGitHubApi<Record<string, unknown>>(
      fetchImpl, `/repos/${repository}/contents/${path}?ref=${headSha}`, token, { maxResponseBytes: MAX_RESPONSE_BYTES },
    );
    if (payload.encoding !== 'base64' || typeof payload.content !== 'string') throw new Error('Could not read the CI configuration snapshot.');
    const original = Buffer.from(payload.content.replace(/\s/g, ''), 'base64').toString('utf8');
    if (Buffer.byteLength(original, 'utf8') > MAX_SNAPSHOT_BYTES || original.includes('\0')) throw new Error('CI configuration snapshot exceeds the supported source size or format.');
    const content = path === WORKFLOW_PATH ? redactWorkflowEnvironment(original) : projectPackageScripts(original);
    snapshots.push({ path, headSha, originalSha256: createHash('sha256').update(original).digest('hex'), content });
  }
  return snapshots;
}

function redactWorkflowEnvironment(content: string): string {
  // Support only scalar env mappings; reject other YAML forms without interpreting them.
  assertSupportedWorkflowStructure(content);
  if (/^[ \t]*(?:-[ \t]+)?["'][^\r\n]*["'][ \t]*:/m.test(content)
    || /^[ \t]*env[ \t]+:/m.test(content) || /^[ \t]*-[ \t]+env[ \t]*:/m.test(content)) {
    throw new Error('CI environment format cannot be safely projected.');
  }
  let envIndent: number | undefined;
  let entryIndent: number | undefined;
  return content.split(/\r?\n/).map((line) => {
    if (/^[ \t]*(#.*)?$/.test(line)) return line;
    const indent = line.match(/^ */)?.[0].length ?? 0;
    if (envIndent !== undefined && indent <= envIndent) envIndent = entryIndent = undefined;
    if (envIndent !== undefined) {
      const entry = line.match(/^( +)([A-Za-z_][A-Za-z0-9_]*):[ \t]*(.+)$/);
      if (!entry || (entryIndent !== undefined && indent !== entryIndent) || /^[|>&*!{\[]/.test(entry[3])
        || ((entry[3].startsWith('"') || entry[3].startsWith("'")) && !entry[3].endsWith(entry[3][0]))) {
        throw new Error('CI environment format cannot be safely projected.');
      }
      entryIndent = indent;
      return `${entry[1]}${entry[2]}: [value omitted; variable configured]`;
    }
    if (/^[ \t]*env:/.test(line)) {
      if (!/^ *env:[ \t]*(#.*)?$/.test(line)) throw new Error('CI environment format cannot be safely projected.');
      envIndent = indent;
    }
    return line;
  }).join('\n');
}

function assertSupportedWorkflowStructure(content: string): void {
  // This is an allowlist for the repository's block-style workflow, not a YAML parser.
  // Flow mappings can hide env at any depth. Reject them outside scalar blocks,
  // allowing only simple scalar lists and the current single-line GitHub expressions.
  let scalarIndent: number | undefined;
  for (const line of content.split(/\r?\n/)) {
    if (/^ *(#.*)?$/.test(line)) continue;
    const indent = line.match(/^ */)![0].length;
    if (scalarIndent !== undefined && indent > scalarIndent) continue;
    scalarIndent = undefined;
    const mapping = line.match(/^( *(?:- +)?)([A-Za-z_][A-Za-z0-9_-]*):(?:[ \t]+(.*))?$/);
    if (!mapping) {
      if (/^ *- +[A-Za-z0-9_.*\/:-]+$/.test(line)) continue;
      throw new Error('CI environment format cannot be safely projected.');
    }
    const value = (mapping[3] ?? '').replace(/\$\{\{[^{}\r\n]*\}\}/g, 'GITHUB_EXPRESSION');
    const scalarList = /^\[(?:[A-Za-z0-9_.*\/-]+(?:, *[A-Za-z0-9_.*\/-]+)*)?\](?:[ \t]+#.*)?$/;
    const quotedScalar = /^(?:"(?:[^"\\]|\\.)*"|'(?:[^']|'')*')(?:[ \t]+#.*)?$/;
    if (/[{}]/.test(value) || (/[\[\]]/.test(value) && !scalarList.test(value))
      || (/^["']/.test(value) && !quotedScalar.test(value))) {
      throw new Error('CI environment format cannot be safely projected.');
    }
    if (/^[|>]/.test(value)) {
      if (!/^[|>][+-]?(?:[ \t]+#.*)?$/.test(value)) throw new Error('CI environment format cannot be safely projected.');
      scalarIndent = mapping[1].length;
    }
  }
}

function projectPackageScripts(content: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error('Package scripts snapshot is not valid JSON.');
  }
  const scripts = record(record(parsed)?.scripts);
  if (!scripts || Object.keys(scripts).length > 40 || Object.values(scripts).some((value) => typeof value !== 'string')) {
    throw new Error('Package test scripts cannot be safely projected.');
  }
  return JSON.stringify({ scripts }, null, 2);
}

function state(value: unknown): string {
  if (typeof value !== 'string' || !STATES.has(value)) throw new Error('GitHub Actions returned an invalid state.');
  return value;
}

function conclusion(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || !CONCLUSIONS.has(value)) throw new Error('GitHub Actions returned an invalid conclusion.');
  return value;
}

function positiveId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
