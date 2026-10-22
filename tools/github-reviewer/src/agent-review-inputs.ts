import { createHash } from 'node:crypto';
import { requestGitHubApi, requestGitHubApiPages, requestGitHubText } from './github-api-client.js';

const REQUIRED_AGENT_CHECKS = {
  api: (name: string) => /(^|\/\s*)api(\s|$)/i.test(name),
  web: (name: string) => /(^|\/\s*)web(\s|$)/i.test(name),
  sonarQube: (name: string) => /sonarqube/i.test(name),
  sonarCloud: (name: string) => /sonarcloud code analysis/i.test(name),
} as const;

export interface AgentReviewInputs {
  diff: string;
  checks: Record<keyof typeof REQUIRED_AGENT_CHECKS, string>;
  repositoryInstructions: string;
  sourceFiles: Array<{ path: string; revision: 'head' | 'base'; content: string }>;
}

const MAX_SOURCE_FILES = 20;
const MAX_SOURCE_BYTES = 250_000;

export async function loadAgentReviewInputs(
  fetchImpl: typeof fetch,
  repository: string,
  pullRequestNumber: number,
  pullRequest: Record<string, unknown>,
  token: string,
): Promise<AgentReviewInputs> {
  const head = asRecord(pullRequest.head);
  const base = asRecord(pullRequest.base);
  const headSha = stringValue(head?.sha);
  const baseSha = stringValue(base?.sha);
  if (!headSha || !baseSha) throw new Error('Pull Request is missing a complete head or base commit.');

  const [diff, runs, instructionsPayload, filesPayload] = await Promise.all([
    requestGitHubText(fetchImpl, `/repos/${repository}/pulls/${pullRequestNumber}`, token, 'application/vnd.github.v3.diff'),
    readCheckRuns(fetchImpl, repository, headSha, token),
    requestGitHubApi<Record<string, unknown>>(fetchImpl, `/repos/${repository}/contents/AGENTS.md?ref=${encodeURIComponent(baseSha)}`, token),
    requestGitHubApiPages<Record<string, unknown>>(fetchImpl, `/repos/${repository}/pulls/${pullRequestNumber}/files`, token),
  ]);
  const encoding = stringValue(instructionsPayload.encoding);
  const encodedInstructions = stringValue(instructionsPayload.content);
  if (encoding !== 'base64' || !encodedInstructions) throw new Error('Could not read AGENTS.md from the Pull Request base commit.');
  const repositoryInstructions = Buffer.from(encodedInstructions.replace(/\s/g, ''), 'base64').toString('utf8');
  const sourceFiles = await loadChangedSourceFiles(fetchImpl, repository, filesPayload, headSha, baseSha, token);
  return { diff, checks: summarizeAgentChecks(runs), repositoryInstructions, sourceFiles };
}

async function loadChangedSourceFiles(
  fetchImpl: typeof fetch,
  repository: string,
  files: Array<Record<string, unknown>>,
  headSha: string,
  baseSha: string,
  token: string,
): Promise<AgentReviewInputs['sourceFiles']> {
  if (files.length > MAX_SOURCE_FILES) throw new Error('Pull Request changes too many files for a complete agent review context.');

  const sourceFiles: AgentReviewInputs['sourceFiles'] = [];
  let totalBytes = 0;
  for (const file of files) {
    const path = stringValue(file.filename);
    const status = stringValue(file.status);
    if (!path || !status) throw new Error('GitHub returned incomplete changed-file metadata.');
    const revision = status === 'removed' ? 'base' : 'head';
    const ref = revision === 'head' ? headSha : baseSha;
    const encodedPath = path.split('/').map(encodeURIComponent).join('/');
    const payload = await requestGitHubApi<Record<string, unknown>>(
      fetchImpl,
      `/repos/${repository}/contents/${encodedPath}?ref=${encodeURIComponent(ref)}`,
      token,
    );
    if (payload.encoding !== 'base64' || typeof payload.content !== 'string') {
      throw new Error(`Could not read the full Pull Request source file: ${path}.`);
    }
    const content = Buffer.from(payload.content.replace(/\s/g, ''), 'base64').toString('utf8');
    if (content.includes('\0')) throw new Error(`Pull Request includes a binary file that cannot be reviewed as source: ${path}.`);
    totalBytes += Buffer.byteLength(content, 'utf8');
    if (totalBytes > MAX_SOURCE_BYTES) throw new Error('Pull Request source files exceed the supported review context size.');
    sourceFiles.push({ path, revision, content });
  }
  return sourceFiles;
}

export function summarizeAgentChecks(runs: Array<Record<string, unknown>>): AgentReviewInputs['checks'] {
  const status = (matcher: (name: string) => boolean): string => {
    const matches = runs.filter((run) => matcher(String(run.name ?? '')));
    if (matches.length === 0) return 'MISSING';
    if (matches.some((run) => run.status !== 'completed')) return 'PENDING';
    if (matches.some((run) => run.conclusion !== 'success')) return 'FAILED';
    return 'PASSED';
  };
  return {
    api: status(REQUIRED_AGENT_CHECKS.api),
    web: status(REQUIRED_AGENT_CHECKS.web),
    sonarQube: status(REQUIRED_AGENT_CHECKS.sonarQube),
    sonarCloud: status(REQUIRED_AGENT_CHECKS.sonarCloud),
  };
}

export function fingerprintAgentReviewInputs(inputs: AgentReviewInputs): Record<string, unknown> {
  return {
    diffSha256: hash(inputs.diff),
    checks: inputs.checks,
    repositoryInstructionsSha256: hash(inputs.repositoryInstructions),
    sourceFiles: inputs.sourceFiles.map(({ path, revision, content }) => ({ path, revision, sha256: hash(content) })),
  };
}

function readCheckRuns(fetchImpl: typeof fetch, repository: string, sha: string, token: string): Promise<Array<Record<string, unknown>>> {
  return readCheckRunPages(fetchImpl, repository, sha, token);
}

async function readCheckRunPages(fetchImpl: typeof fetch, repository: string, sha: string, token: string): Promise<Array<Record<string, unknown>>> {
  const runs: Array<Record<string, unknown>> = [];
  for (let page = 1; page <= 100; page += 1) {
    const payload = await requestGitHubApi<{ check_runs?: Array<Record<string, unknown>> }>(
      fetchImpl,
      `/repos/${repository}/commits/${sha}/check-runs?per_page=100&page=${page}`,
      token,
    );
    const batch = payload.check_runs ?? [];
    runs.push(...batch);
    if (batch.length < 100) return runs;
  }
  throw new Error('GitHub check-run pagination exceeded the supported page limit.');
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
