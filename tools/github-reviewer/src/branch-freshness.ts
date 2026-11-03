import { requestGitHubApi } from './github-api-client.js';

interface PullRequestReference {
  sha?: unknown;
}

interface PullRequestForFreshness {
  base?: PullRequestReference;
  head?: PullRequestReference;
}

export async function assertPullRequestContainsBase(
  fetchImpl: typeof fetch,
  repository: string,
  pullRequest: PullRequestForFreshness,
  token: string,
): Promise<void> {
  const baseSha = commitSha(pullRequest.base?.sha, 'base');
  const headSha = commitSha(pullRequest.head?.sha, 'head');
  const comparison = await requestGitHubApi<Record<string, unknown>>(
    fetchImpl,
    `/repos/${repository}/compare/${baseSha}...${headSha}`,
    token,
  );
  const status = typeof comparison.status === 'string' ? comparison.status : undefined;

  if (status === 'ahead' || status === 'identical') return;
  if (status === 'behind' || status === 'diverged') {
    throw new Error(`Pull Request branch must be updated with master before agent orchestration (${status}).`);
  }
  throw new Error('GitHub did not confirm that the Pull Request branch contains the current master commit.');
}

function commitSha(value: unknown, reference: 'base' | 'head'): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{40}$/i.test(value)) {
    throw new Error(`Pull Request ${reference} SHA is unavailable or invalid.`);
  }
  return value.toLowerCase();
}
