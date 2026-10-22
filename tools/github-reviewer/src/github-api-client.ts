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
  options: { method?: string; body?: string; maxResponseBytes?: number } = {},
): Promise<T> {
  const method = options.method ?? 'GET';
  const retrySafe = method === 'GET' || method === 'PATCH';
  for (let attempt = 1; attempt <= (retrySafe ? 3 : 1); attempt += 1) {
    let response: Response;
    try {
      response = await fetchImpl(`${API_BASE}${path}`, {
        method,
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${token}`,
          'X-GitHub-Api-Version': API_VERSION,
          ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(options.body === undefined ? {} : { body: options.body }),
        ...(options.maxResponseBytes === undefined ? {} : { signal: AbortSignal.timeout(15_000), redirect: 'error' as const }),
      });
    } catch (error) {
      if (!retrySafe || attempt === 3) throw error;
      await retryDelay(attempt);
      continue;
    }

    if (!response.ok && retrySafe && isTransientStatus(response.status) && attempt < 3) {
      const retryAfter = Number(response.headers.get('Retry-After'));
      if (options.maxResponseBytes === undefined) await response.arrayBuffer().catch(() => undefined);
      else await response.body?.cancel().catch(() => undefined);
      await retryDelay(attempt, Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : undefined);
      continue;
    }
    if (!response.ok) throw new GitHubApiError(response.status);
    const payload: unknown = options.maxResponseBytes === undefined
      ? await response.json().catch(() => ({}))
      : await readBoundedJson(response, options.maxResponseBytes);
    if (!isRecord(payload) && !Array.isArray(payload)) throw new Error('GitHub API returned an invalid response.');
    return payload as T;
  }
  throw new Error('GitHub API request exhausted its retry attempts.');
}

async function readBoundedJson(response: Response, maxBytes: number): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('GitHub API returned an empty evidence response.');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new Error('GitHub evidence response exceeds the supported size.');
      chunks.push(value);
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    } catch {
      throw new Error('GitHub evidence response is not valid JSON.');
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

export async function requestGitHubText(
  fetchImpl: typeof fetch,
  path: string,
  token: string,
  accept: string,
): Promise<string> {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    let response: Response;
    try {
      response = await fetchImpl(`${API_BASE}${path}`, {
        headers: { Accept: accept, Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': API_VERSION },
      });
    } catch (error) {
      if (attempt === 3) throw error;
      await retryDelay(attempt);
      continue;
    }
    if (!response.ok && isTransientStatus(response.status) && attempt < 3) {
      const retryAfter = Number(response.headers.get('Retry-After'));
      await response.arrayBuffer().catch(() => undefined);
      await retryDelay(attempt, Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : undefined);
      continue;
    }
    if (!response.ok) throw new GitHubApiError(response.status);
    return response.text();
  }
  throw new Error('GitHub API request exhausted its retry attempts.');
}

function isTransientStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

async function retryDelay(attempt: number, retryAfterMs?: number): Promise<void> {
  const delayMs = Math.min(2_000, retryAfterMs ?? 250 * 2 ** (attempt - 1));
  await new Promise((resolve) => setTimeout(resolve, delayMs));
}

export async function requestGitHubApiPages<T = Record<string, unknown>>(
  fetchImpl: typeof fetch,
  path: string,
  token: string,
): Promise<T[]> {
  const separator = path.includes('?') ? '&' : '?';
  const values: T[] = [];
  for (let page = 1; page <= 100; page += 1) {
    const response = await requestGitHubApi<unknown>(fetchImpl, `${path}${separator}per_page=100&page=${page}`, token);
    if (!Array.isArray(response)) throw new Error('GitHub API returned an invalid paginated response.');
    values.push(...response as T[]);
    if (response.length < 100) return values;
  }
  throw new Error('GitHub API pagination exceeded the supported page limit.');
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
