const API_BASE = 'https://api.github.com';

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
  const maxAttempts = options.maxAttempts ?? 24;
  const delayMs = options.delayMs ?? 5_000;
  const sleep = options.sleep ?? ((delay: number) => new Promise<void>((resolve) => setTimeout(resolve, delay)));
  let observedActive = false;
  let observedAnyRun = false;
  let refusedByAssociation = false;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const { run, refusedByAssociation: refused } = await loadLatestCiRun(options);
    refusedByAssociation = refusedByAssociation || refused;
    if (!run) {
      if (attempt < maxAttempts) await sleep(delayMs);
      continue;
    }
    observedAnyRun = true;

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

  // Three different failures used to share one message, and the operator could not tell them apart.
  // Each names the condition that actually produced it, rather than deriving a cause from the absence
  // of an observation: a head with no CI run at all is missing evidence, a run that never finished is
  // a slow pipeline, and a run refused because GitHub attributes it to another Pull Request is neither.
  // All three still fail closed — absent evidence keeps blocking the merge.
  if (observedAnyRun) {
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
 * The first version required `pull_requests` to carry the PR number, which looked like the safe
 * reading and was in fact the defect (DEV-110): GitHub leaves that array **empty** for these runs, so
 * no run was ever accepted, the loop burned all its attempts and the job failed with a timeout —
 * every time a Pull Request body was edited, not occasionally. Three occurrences, all identical. The
 * five tests missed it because their fixture always populated the array.
 *
 * An empty array therefore cannot be read as "belongs to another Pull Request": it carries no
 * information at all. What identifies the run is the query that produced it — the `ci.yml` workflow,
 * the `pull_request` event and this exact `head_sha` — so an unassociated run at this head is
 * accepted. When GitHub does populate the array, it is still checked, because then it does mean
 * something.
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
  if (!Number.isInteger(options.maxAttempts ?? 24) || (options.maxAttempts ?? 24) <= 0) throw new Error('maxAttempts must be positive.');
}
