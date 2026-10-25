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

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const run = await loadLatestCiRun(options);
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

  throw new Error('Timed out waiting for the CI run associated with the current Pull Request head.');
}

async function loadLatestCiRun(options: CiRecoveryOptions): Promise<WorkflowRun | undefined> {
  const query = new URLSearchParams({ event: 'pull_request', head_sha: options.headSha, per_page: '100' });
  const response = await options.fetchImpl(
    `${API_BASE}/repos/${options.repository}/actions/workflows/ci.yml/runs?${query}`,
    { headers: headers(options.token) },
  );
  if (!response.ok) throw new Error(`GitHub API HTTP ${response.status} while reading CI runs.`);
  const payload = await response.json() as { workflow_runs?: WorkflowRun[] };
  const runs = Array.isArray(payload.workflow_runs) ? payload.workflow_runs : [];
  return runs
    .filter((run) => Number.isSafeInteger(run.id)
      && Array.isArray(run.pull_requests)
      && run.pull_requests.some((pullRequest) => pullRequest.number === options.pullRequestNumber))
    .sort((left, right) => String(right.created_at ?? '').localeCompare(String(left.created_at ?? '')))[0];
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
