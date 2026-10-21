import { createAppAuth } from '@octokit/auth-app';

const API_BASE = 'https://api.github.com';
const API_VERSION = '2022-11-28';

export interface GitHubApiClientOptions {
  appId: string;
  privateKey: string;
  owner: string;
  repository: string;
  installationId?: string;
  fetchImpl?: typeof fetch;
  authFactory?: typeof createAppAuth;
}

export interface GitHubInstallationSession {
  installationToken: string;
  installationId: number;
  appSlug?: string;
}

export class GitHubApiError extends Error {
  constructor(readonly status: number) {
    super(`GitHub API request failed (${status}).`);
    this.name = 'GitHubApiError';
  }
}

export async function createGitHubInstallationSession(
  options: GitHubApiClientOptions,
  includeAppIdentity = false,
): Promise<GitHubInstallationSession> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const authFactory = options.authFactory ?? createAppAuth;
  const auth = authFactory({ appId: options.appId, privateKey: options.privateKey });
  let installationId = options.installationId ? parseInstallationId(options.installationId) : undefined;
  let appSlug: string | undefined;

  if (installationId === undefined || includeAppIdentity) {
    const appAuthentication = await auth({ type: 'app' });
    if (includeAppIdentity) {
      const app = await requestGitHubApi(fetchImpl, '/app', appAuthentication.token);
      if (typeof app.slug !== 'string' || app.slug.length === 0) throw new Error('GitHub App identity is unavailable.');
      appSlug = app.slug;
    }
    if (installationId === undefined) {
      const repositoryPath = getRepositoryPath(options.owner, options.repository);
      const installation = await requestGitHubApi(fetchImpl, `${repositoryPath}/installation`, appAuthentication.token);
      installationId = parseInstallationId(installation.id);
    }
  }

  const installationAuthentication = await auth({ type: 'installation', installationId });
  if (typeof installationAuthentication.token !== 'string' || installationAuthentication.token.length === 0) {
    throw new Error('GitHub did not return an installation token.');
  }

  return { installationToken: installationAuthentication.token, installationId, appSlug };
}

export async function requestGitHubApi<T = Record<string, unknown>>(
  fetchImpl: typeof fetch,
  path: string,
  token: string,
  options: { method?: string; body?: string } = {},
): Promise<T> {
  const response = await fetchImpl(`${API_BASE}${path}`, {
    method: options.method ?? 'GET',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': API_VERSION,
      ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(options.body === undefined ? {} : { body: options.body }),
  });

  const payload: unknown = await response.json().catch(() => ({}));
  if (!response.ok) throw new GitHubApiError(response.status);
  if (!isRecord(payload) && !Array.isArray(payload)) throw new Error('GitHub API returned an invalid response.');
  return payload as T;
}

export function getRepositoryPath(owner: string, repository: string): string {
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}`;
}

function parseInstallationId(value: unknown): number {
  const installationId = Number(value);
  if (!Number.isSafeInteger(installationId) || installationId < 1) {
    throw new Error('GitHub App installation ID must be a positive integer.');
  }
  return installationId;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
