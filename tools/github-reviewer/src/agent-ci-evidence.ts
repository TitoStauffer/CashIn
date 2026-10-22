import { createHash } from 'node:crypto';
import { requestGitHubApi } from './github-api-client.js';

const ACTIONS_APP_ID = 15368;
const WORKFLOW_PATH = '.github/workflows/ci.yml';
const MAX_RESPONSE_BYTES = 100_000;
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
  check: Record<string, unknown>, token: string,
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
  const [job, run] = await Promise.all([read(`/actions/jobs/${jobId}`), read(`/actions/runs/${runId}`)]);
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
  if (!Array.isArray(job.steps) || job.steps.length === 0 || job.steps.length > 40) throw new Error('GitHub Actions job steps are missing or exceed the supported limit.');
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

export async function loadCiSnapshots(fetchImpl: typeof fetch, repository: string, headSha: string, token: string): Promise<AgentCiSnapshot[]> {
  const snapshots: AgentCiSnapshot[] = [];
  for (const path of [WORKFLOW_PATH, 'apps/api/package.json', 'apps/web/package.json']) {
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
