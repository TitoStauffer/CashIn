const API_BASE = 'https://api.github.com';

/**
 * The wait window, which is the DEV-110 fix: it has to cover a complete CI run.
 *
 * Measured on this repository. The run at head `636e262` took 4m52s (created 05:09:26Z, completed
 * 05:14:18Z) and the recovery job that edited metadata while it was running gave up at 05:11:50Z,
 * two minutes in, with CI still in progress. The run at head `c4d85f6` took 2m05s and the same job
 * succeeded, by about a second. That is the whole defect: an edit made during CI timed out, an edit
 * made after it did not. 60 × 10s is roughly double the slowest run observed, and the job's
 * `timeout-minutes` sits above it so the process decides and reports which condition it saw.
 */
export const DEFAULT_MAX_ATTEMPTS = 60;
export const DEFAULT_DELAY_MS = 10_000;

interface WorkflowRun {
  id?: number;
  status?: string;
  conclusion?: string | null;
  created_at?: string;
  pull_requests?: Array<{ number?: number }>;
}

export interface CiRecoveryOptions {
  fetchImpl: typeof fetch;
  repository: string;
  pullRequestNumber: number;
  headSha: string;
  token: string;
  maxAttempts?: number;
  delayMs?: number;
  sleep?: (delayMs: number) => Promise<void>;
}

interface RunSearch {
  run?: WorkflowRun;
  /** A run exists at this head but GitHub associates it with a different Pull Request. */
  refusedByAssociation: boolean;
}

export interface CiRecoveryResult {
  action: 'rerun_requested' | 'active_run_succeeded';
  runId: number;
}

export async function recoverCiAfterMetadataEdit(options: CiRecoveryOptions): Promise<CiRecoveryResult> {
  validateOptions(options);
  // The window is the fix; see DEFAULT_MAX_ATTEMPTS for the measurement behind these numbers.
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const delayMs = options.delayMs ?? DEFAULT_DELAY_MS;
  const sleep = options.sleep ?? ((delay: number) => new Promise<void>((resolve) => setTimeout(resolve, delay)));
  // One flag, not two: every accepted run that is `completed` returns from this function, so reaching
  // the end of the loop means each accepted run was still running — which is exactly `observedActive`.
  let observedActive = false;
  let refusedByAssociation = false;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const { run, refusedByAssociation: refused } = await loadLatestCiRun(options);
    // The latest observation, not an accumulation: a first read that saw another Pull Request's run
    // followed by empty reads must not end up blaming the association, when what the job last
    // observed was the absence of any run. Each message names the condition that produced it.
    refusedByAssociation = refused;
    if (!run) {
      if (attempt < maxAttempts) await sleep(delayMs);
      continue;
    }

    if (run.status !== 'completed') {
      observedActive = true;
      if (attempt < maxAttempts) await sleep(delayMs);
      continue;
    }

    if (observedActive && run.conclusion === 'success') {
      return { action: 'active_run_succeeded', runId: run.id! };
    }

    await requestRerun(options, run.id!);
    return { action: 'rerun_requested', runId: run.id! };
  }

  // Precedence, declared because it is not simply "the last thing observed": a run that was seen
  // running outweighs later reads that saw nothing. `observedActive` accumulates on purpose — "it
  // existed and did not finish" is the more actionable report, and it is also the safer one, since a
  // run that vanishes from the listing is more likely a listing lag than a run that never existed.
  // `refusedByAssociation`, by contrast, is reassigned, because there the latest read is the truth.
  //
  // Three different failures used to share one message, and the operator could not tell them apart.
  // Each names the condition that actually produced it, rather than deriving a cause from the absence
  // of an observation: a head with no CI run at all is missing evidence, a run that never finished is
  // a slow pipeline, and a run refused because GitHub attributes it to another Pull Request is neither.
  // All three still fail closed — absent evidence keeps blocking the merge.
  if (observedActive) {
    throw new Error('The CI run for the current Pull Request head never completed within the wait window.');
  }
  throw new Error(refusedByAssociation
    ? 'A CI run exists for this head but GitHub associates it with another Pull Request.'
    : 'No CI run exists for the current Pull Request head.');
}

async function loadLatestCiRun(options: CiRecoveryOptions): Promise<RunSearch> {
  const query = new URLSearchParams({ event: 'pull_request', head_sha: options.headSha, per_page: '100' });
  const response = await options.fetchImpl(
    `${API_BASE}/repos/${options.repository}/actions/workflows/ci.yml/runs?${query}`,
    { headers: headers(options.token) },
  );
  if (!response.ok) throw new Error(`GitHub API HTTP ${response.status} while reading CI runs.`);
  const payload = await response.json() as { workflow_runs?: WorkflowRun[] };
  const runs = Array.isArray(payload.workflow_runs) ? payload.workflow_runs : [];
  const identified = runs.filter((run) => Number.isSafeInteger(run.id));
  const mine = identified.filter((run) => belongsToPullRequest(run, options.pullRequestNumber));
  return {
    run: [...mine].sort((left, right) => String(right.created_at ?? '').localeCompare(String(left.created_at ?? '')))[0],
    refusedByAssociation: mine.length === 0 && identified.length > 0,
  };
}

/**
 * Whether a run of the CI workflow at this head is the run this recovery is about.
 *
 * **This was not the DEV-110 defect.** An earlier version of this comment said it was, on the strength
 * of three readings where `pull_requests` came back empty — and those readings were taken after the
 * Pull Requests had been merged, when GitHub has already dropped the association. While a Pull
 * Request is open the array **is** populated: measured on PR #95, length 1, number 95. The defect was
 * the wait window, documented in `recoverCiAfterMetadataEdit`.
 *
 * Accepting an unassociated run is kept as defence in depth, because an empty array carries no
 * information and so cannot be read as "belongs to another Pull Request" — which is the state after
 * the Pull Request closes. What identifies the run is the query that produced it: the `ci.yml`
 * workflow, the `pull_request` event and this exact `head_sha`. When GitHub does populate the array,
 * it is still checked, because then it does mean something.
 */
function belongsToPullRequest(run: WorkflowRun, pullRequestNumber: number): boolean {
  const associations = Array.isArray(run.pull_requests) ? run.pull_requests : [];
  if (associations.length === 0) return true;
  return associations.some((pullRequest) => pullRequest.number === pullRequestNumber);
}

async function requestRerun(options: CiRecoveryOptions, runId: number): Promise<void> {
  const response = await options.fetchImpl(
    `${API_BASE}/repos/${options.repository}/actions/runs/${runId}/rerun`,
    { method: 'POST', headers: headers(options.token) },
  );
  if (!response.ok) throw new Error(`GitHub API HTTP ${response.status} while requesting the CI rerun.`);
}

function headers(token: string): Record<string, string> {
  return {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

function validateOptions(options: CiRecoveryOptions): void {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(options.repository)) throw new Error('GITHUB_REPOSITORY is invalid.');
  if (!Number.isSafeInteger(options.pullRequestNumber) || options.pullRequestNumber <= 0) throw new Error('PR_NUMBER is invalid.');
  if (!/^[a-f0-9]{40}$/i.test(options.headSha)) throw new Error('PR_HEAD_SHA is invalid.');
  if (!options.token) throw new Error('GITHUB_TOKEN is required.');
  const attempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  if (!Number.isInteger(attempts) || attempts <= 0) throw new Error('maxAttempts must be positive.');
}
