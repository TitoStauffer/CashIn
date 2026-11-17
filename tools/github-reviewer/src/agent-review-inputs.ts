import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import { requestGitHubApi, requestGitHubApiPages, requestGitHubText } from './github-api-client.js';
import { ACTIONS_APP_ID, loadActionsEvidence, loadCiSnapshots, unavailableActionsEvidence, type AgentActionsEvidence, type AgentCiSnapshot } from './agent-ci-evidence.js';
import { loadVaultContext, type VaultContextSnapshot } from './vault-context.js';

const REQUIRED_AGENT_CHECKS = {
  api: (name: string) => /(^|\/\s*)api(\s|$)/i.test(name),
  web: (name: string) => /(^|\/\s*)web(\s|$)/i.test(name),
  // DEV-153: the Expo app job (DEV-141), required and read like API and Web.
  mobile: (name: string) => /(^|\/\s*)mobile(\s|$)/i.test(name),
  githubReviewer: (name: string) => /(^|\/\s*)(?:automation tools|github reviewer)$/i.test(name),
  sonarQube: (name: string) => /sonarqube/i.test(name),
  sonarCloud: (name: string) => /sonarcloud code analysis/i.test(name),
} as const;

export interface AgentReviewInputs {
  diff: string;
  changedFiles: string[];
  checks: Record<keyof typeof REQUIRED_AGENT_CHECKS, string>;
  checkRuns: AgentCheckEvidence[];
  repositoryInstructions: string;
  sourceFiles: Array<{ path: string; revision: 'head' | 'base'; content: string }>;
  vaultContext: VaultContextSnapshot[];
  ciConfiguration?: AgentCiSnapshot[];
}

export interface AgentCheckEvidence {
  name: string;
  appId: number | null;
  headSha: string;
  status: string;
  conclusion: string | null;
  detailsUrl: string | null;
  completedAt: string | null;
  actions?: AgentActionsEvidence;
}

const MAX_SOURCE_FILES = 32;
const MAX_DEPENDENCY_FILES = 64;
const MAX_SOURCE_BYTES = 500_000;
// A lockfile read raw is summarized, never sent whole, but it is still held in memory to be parsed.
const MAX_RAW_LOCKFILE_BYTES = 20_000_000;

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

  const [rawDiff, runs, instructionsPayload, filesPayload] = await Promise.all([
    requestGitHubText(fetchImpl, `/repos/${repository}/pulls/${pullRequestNumber}`, token, 'application/vnd.github.v3.diff'),
    readCheckRuns(fetchImpl, repository, headSha, token),
    requestGitHubApi<Record<string, unknown>>(fetchImpl, `/repos/${repository}/contents/AGENTS.md?ref=${encodeURIComponent(baseSha)}`, token),
    requestGitHubApiPages<Record<string, unknown>>(fetchImpl, `/repos/${repository}/pulls/${pullRequestNumber}/files`, token),
  ]);
  const diff = sanitizeAgentDiff(rawDiff);
  const encoding = stringValue(instructionsPayload.encoding);
  const encodedInstructions = stringValue(instructionsPayload.content);
  if (encoding !== 'base64' || !encodedInstructions) throw new Error('Could not read AGENTS.md from the Pull Request base commit.');
  const repositoryInstructions = Buffer.from(encodedInstructions.replace(/\s/g, ''), 'base64').toString('utf8');
  const vaultContext = await loadVaultContext(fetchImpl, repository, filesPayload, headSha, baseSha, token);
  const vaultPaths = new Set(vaultContext.filter(({ path }) => !path.startsWith('github-evidence://')).map(({ path }) => path));
  const sourceFiles = await loadChangedSourceFiles(fetchImpl, repository, filesPayload, headSha, baseSha, token, vaultPaths);
  const checkRuns = summarizeCheckRunEvidence(runs, headSha);
  const ciChecks = latestRunsByName(runs.filter((run) => run.head_sha === headSha && isTestCheck(String(run.name ?? ''))));
  if (ciChecks.length > 4) throw new Error('Too many CI checks for the supported agent evidence context.');
  for (const check of ciChecks) {
    const summary = checkRuns.find((candidate) => candidate.name === check.name && candidate.appId === (asRecord(check.app)?.id ?? null));
    if (summary) summary.actions = await loadActionsEvidence(fetchImpl, repository, pullRequestNumber, headSha, check, token);
  }
  const ciConfiguration = checkRuns.some((check) => check.actions?.availability === 'available')
    ? await loadCiSnapshots(fetchImpl, repository, headSha, token) : [];
  const changedFiles = filesPayload.map((file) => stringValue(file.filename));
  if (changedFiles.some((path) => !path)) throw new Error('GitHub returned incomplete changed-file metadata.');
  return { diff, changedFiles: changedFiles as string[], checks: summarizeAgentChecks(runs, headSha), checkRuns, repositoryInstructions, sourceFiles, vaultContext, ciConfiguration };
}

async function loadChangedSourceFiles(
  fetchImpl: typeof fetch,
  repository: string,
  files: Array<Record<string, unknown>>,
  headSha: string,
  baseSha: string,
  token: string,
  alreadyLoadedPaths: ReadonlySet<string> = new Set(),
): Promise<AgentReviewInputs['sourceFiles']> {
  const changedFiles = files.map((file) => ({ ...file, filename: stringValue(file.filename), status: stringValue(file.status) }));
  for (const file of changedFiles) {
    if (!file.filename || !file.status) throw new Error('GitHub returned incomplete changed-file metadata.');
  }
  const sourceCandidates = changedFiles.filter(({ filename }) => {
    const path = filename as string;
    return !alreadyLoadedPaths.has(path) || !isVaultManagedDocument(path);
  });
  if (sourceCandidates.length > MAX_SOURCE_FILES) throw new Error('Pull Request changes too many files for a complete agent review context.');

  const sourceFiles: AgentReviewInputs['sourceFiles'] = [];
  let totalBytes = 0;
  const changedFileCount = sourceCandidates.length;
  const pendingFiles = [...sourceCandidates];
  const seen = new Set(pendingFiles.map((file) => `${file.status === 'removed' ? 'base' : 'head'}:${file.filename}`));
  for (let index = 0; index < pendingFiles.length; index += 1) {
    const file = pendingFiles[index];
    const isChangedFile = index < changedFileCount;
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
    // GitHub omits the body of files over 1 MB from this response (`encoding: none`). A lockfile can
    // pass that size and is summarized anyway, so it alone is read again through the raw media type.
    const rawLockfile = isNpmLockfile(path) && payload.encoding === 'none'
      ? await requestGitHubText(fetchImpl, `/repos/${repository}/contents/${encodedPath}?ref=${encodeURIComponent(ref)}`, token, 'application/vnd.github.raw')
      : null;
    if (rawLockfile !== null && Buffer.byteLength(rawLockfile, 'utf8') > MAX_RAW_LOCKFILE_BYTES) {
      throw new Error(`Pull Request lockfile exceeds the supported raw read size: ${path}.`);
    }
    if (rawLockfile === null && (payload.encoding !== 'base64' || typeof payload.content !== 'string')) {
      throw new Error(`Could not read the full Pull Request source file: ${path}.`);
    }
    const content = rawLockfile ?? Buffer.from(String(payload.content).replace(/\s/g, ''), 'base64').toString('utf8');
    if (content.includes('\0')) throw new Error(`Pull Request includes a binary file that cannot be reviewed as source: ${path}.`);
    const reviewContent = isEncodedReviewFixture(path)
      ? encodedFixtureMarker(path, content)
      : isNpmLockfile(path) ? summarizeNpmLockfile(path, content) : content;
    const contentBytes = Buffer.byteLength(reviewContent, 'utf8');
    if (totalBytes + contentBytes > MAX_SOURCE_BYTES) {
      if (isChangedFile) throw new Error('Pull Request source files exceed the supported review context size.');
      continue;
    }
    totalBytes += contentBytes;
    sourceFiles.push({ path, revision, content: reviewContent });
    if (isChangedFile && /\.[cm]?tsx?$/.test(path)) {
      for (const match of reviewContent.matchAll(/\bfrom\s+['"](\.[^'"]+\.js)['"]/g)) {
        const dependency = posix.normalize(posix.join(posix.dirname(path), match[1].replace(/\.js$/, '.ts')));
        const key = `${revision}:${dependency}`;
        if (dependency.startsWith('../') || seen.has(key)) continue;
        if (pendingFiles.length >= changedFileCount + MAX_DEPENDENCY_FILES) throw new Error('Pull Request dependencies exceed the supported source file limit.');
        seen.add(key);
        pendingFiles.push({ filename: dependency, status: revision === 'base' ? 'removed' : 'modified' });
      }
    }
  }
  return sourceFiles;
}

export function sanitizeAgentDiff(diff: string): string {
  return diff.split(/(?=^diff --git )/m).map((section) => {
    const path = section.match(/^diff --git a\/.+ b\/(.+)$/m)?.[1]?.trim();
    if (!path) return section;
    const header = section.split(/\r?\n/, 1)[0];
    const bytes = Buffer.byteLength(section, 'utf8');
    if (isEncodedReviewFixture(path)) {
      return `${header}\n[encoded test fixture diff section omitted from model context; diffSectionBytes=${bytes}; diffSectionSha256=${hash(section)}]\n`;
    }
    if (isNpmLockfile(path)) {
      return `${header}\n[npm lockfile diff section omitted from model context; the source context carries its deterministic summary; diffSectionBytes=${bytes}; diffSectionSha256=${hash(section)}]\n`;
    }
    return section;
  }).join('');
}

function isEncodedReviewFixture(path: string): boolean {
  return /^tools\/github-reviewer\/test\/fixtures\/[A-Za-z0-9._-]+\.json\.gz\.base64$/.test(path);
}

// An npm lockfile is generated, and most of it is integrity hashes no reader can check by eye; an
// Expo app's lockfile alone passes the whole source budget (DEV-152). What a reviewer can judge is
// where each package comes from, so the lockfile reaches the model as a deterministic summary that
// names every package resolved outside the official registry and every package without an integrity
// hash. That the lockfile matches its package.json is enforced by `npm ci` in every CI job that
// installs a package, not by the model.
//
// Everything in the lockfile is written by whoever opens the PR, so no value of it reaches the summary
// raw: a newline or a `]` in a key, a URL or `lockfileVersion` could otherwise write a whole clean-looking
// summary ahead of the real one. Integers are kept only when they are integers, and every string —
// path, location, URL, host — is emitted as a JSON string literal, cut to a bounded length first.
const NPM_REGISTRY_PREFIX = 'https://registry.npmjs.org/';
const MAX_LISTED_LOCKFILE_ANOMALIES = 50;
const MAX_LOCKFILE_VALUE_CHARS = 200;

function isNpmLockfile(path: string): boolean {
  return /(^|\/)package-lock\.json$/.test(path);
}

function quoted(value: string): string {
  const bounded = value.length > MAX_LOCKFILE_VALUE_CHARS ? `${value.slice(0, MAX_LOCKFILE_VALUE_CHARS)}…` : value;
  return JSON.stringify(bounded);
}

export function summarizeNpmLockfile(path: string, content: string): string {
  const header = `[npm lockfile summarized for the model context; path=${quoted(path)}; sourceBytes=${Buffer.byteLength(content, 'utf8')}; sourceSha256=${hash(content)}`;
  let lockfile: unknown;
  try {
    lockfile = JSON.parse(content);
  } catch {
    return `${header}; parse=INVALID_JSON]`;
  }
  const packages = asRecord(asRecord(lockfile)?.packages);
  if (!packages) return `${header}; parse=NO_PACKAGES_OBJECT]`;

  const hosts = new Map<string, number>();
  const outsideRegistry: string[] = [];
  const withoutIntegrity: string[] = [];
  let installed = 0;
  for (const [location, entry] of Object.entries(packages)) {
    // The empty key is the project itself; links point at local folders and carry no tarball.
    const record = asRecord(entry);
    if (location === '' || !record || record.link === true) continue;
    installed += 1;
    const resolved = typeof record.resolved === 'string' ? record.resolved : '';
    const host = resolvedHost(resolved);
    hosts.set(host, (hosts.get(host) ?? 0) + 1);
    if (!resolved.startsWith(NPM_REGISTRY_PREFIX)) outsideRegistry.push(`${quoted(location)} -> ${resolved ? quoted(resolved) : '(no resolved)'}`);
    if (typeof record.integrity !== 'string' || !/^sha(256|384|512)-/.test(record.integrity)) withoutIntegrity.push(quoted(location));
  }
  const hostList = [...hosts.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([host, count]) => `${quoted(host)}=${count}`).join(', ');
  const version = asRecord(lockfile)?.lockfileVersion;
  return [
    `${header}; lockfileVersion=${Number.isSafeInteger(version) ? String(version) : 'invalid'}; installedPackages=${installed}`,
    `resolvedHosts: ${hostList || '(none)'}`,
    `packagesResolvedOutsideRegistry (${outsideRegistry.length}): ${listAnomalies(outsideRegistry)}`,
    `packagesWithoutIntegrity (${withoutIntegrity.length}): ${listAnomalies(withoutIntegrity)}]`,
  ].join('\n');
}

function resolvedHost(resolved: string): string {
  if (!resolved) return '(no resolved)';
  try {
    const url = new URL(resolved);
    return `${url.protocol}//${url.host}`;
  } catch {
    return '(not a URL)';
  }
}

function listAnomalies(entries: string[]): string {
  if (entries.length === 0) return 'none';
  const listed = entries.slice(0, MAX_LISTED_LOCKFILE_ANOMALIES).join('; ');
  return entries.length > MAX_LISTED_LOCKFILE_ANOMALIES ? `${listed}; ... and ${entries.length - MAX_LISTED_LOCKFILE_ANOMALIES} more` : listed;
}

function encodedFixtureMarker(path: string, content: string): string {
  return `[encoded test fixture source omitted from model context; path=${path}; sourceBytes=${Buffer.byteLength(content, 'utf8')}; sourceSha256=${hash(content)}]`;
}

function isVaultManagedDocument(path: string): boolean {
  return path === 'docs/knowledge/context-map.json'
    || (path.startsWith('docs/knowledge/') && path.endsWith('.md'));
}

export function summarizeAgentChecks(runs: Array<Record<string, unknown>>, expectedHeadSha?: string): AgentReviewInputs['checks'] {
  const currentRuns = expectedHeadSha ? runs.filter((run) => run.head_sha === expectedHeadSha) : runs;
  const status = (matcher: (name: string) => boolean, appId?: number): string => {
    const matches = latestRunsByName(currentRuns.filter((run) => matcher(String(run.name ?? ''))
      && (appId === undefined || asRecord(run.app)?.id === appId)));
    if (matches.length === 0) return 'MISSING';
    if (matches.some((run) => run.status !== 'completed')) return 'PENDING';
    if (matches.some((run) => run.conclusion !== 'success')) return 'FAILED';
    return 'PASSED';
  };
  return {
    api: status(REQUIRED_AGENT_CHECKS.api),
    web: status(REQUIRED_AGENT_CHECKS.web),
    mobile: status(REQUIRED_AGENT_CHECKS.mobile),
    githubReviewer: status(REQUIRED_AGENT_CHECKS.githubReviewer, ACTIONS_APP_ID),
    sonarQube: status(REQUIRED_AGENT_CHECKS.sonarQube),
    sonarCloud: status(REQUIRED_AGENT_CHECKS.sonarCloud),
  };
}

export function fingerprintAgentReviewInputs(inputs: AgentReviewInputs): Record<string, unknown> {
  return {
    diffSha256: hash(inputs.diff),
    changedFiles: inputs.changedFiles ?? [],
    checks: inputs.checks,
    checkRuns: (inputs.checkRuns ?? []).map(({ name, appId, headSha, status, conclusion, actions }) => ({
      name, appId, headSha, status, conclusion,
      actions: actions?.availability === 'available'
        ? { availability: actions.availability, repository: actions.repository, headSha: actions.headSha, workflowPath: actions.workflowPath, runStatus: actions.runStatus, runConclusion: actions.runConclusion, steps: actions.steps }
        : actions,
    })),
    repositoryInstructionsSha256: hash(inputs.repositoryInstructions),
    vaultContext: (inputs.vaultContext ?? []).map(({ path, revision, content }) => ({ path, revision, sha256: hash(content) })),
    sourceFiles: inputs.sourceFiles.map(({ path, revision, content }) => ({ path, revision, sha256: hash(content) })),
    ciConfiguration: (inputs.ciConfiguration ?? []).map(({ path, headSha, originalSha256, content }) => ({ path, headSha, originalSha256, sha256: hash(content) })),
  };
}

export function summarizeCheckRunEvidence(runs: Array<Record<string, unknown>>, expectedHeadSha: string): AgentCheckEvidence[] {
  const relevantRuns = latestRunsByName(runs.filter((run) => run.head_sha === expectedHeadSha
    && Object.values(REQUIRED_AGENT_CHECKS).some((matcher) => matcher(String(run.name ?? '')))));
  return relevantRuns
    .map((run) => ({
      name: String(run.name ?? 'Unnamed check'),
      appId: typeof asRecord(run.app)?.id === 'number' ? asRecord(run.app)!.id as number : null,
      headSha: expectedHeadSha,
      status: String(run.status ?? 'unknown'),
      conclusion: typeof run.conclusion === 'string' ? run.conclusion : null,
      detailsUrl: typeof run.details_url === 'string' ? run.details_url : null,
      completedAt: typeof run.completed_at === 'string' ? run.completed_at : null,
      ...(isTestCheck(String(run.name ?? '')) ? { actions: unavailableActionsEvidence() } : {}),
    }))
    .sort((left, right) => left.name.localeCompare(right.name) || (left.appId ?? 0) - (right.appId ?? 0));
}

function isTestCheck(name: string): boolean {
  return REQUIRED_AGENT_CHECKS.api(name) || REQUIRED_AGENT_CHECKS.web(name) || REQUIRED_AGENT_CHECKS.mobile(name) || REQUIRED_AGENT_CHECKS.githubReviewer(name);
}

function latestRunsByName(runs: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  const latest = new Map<string, Record<string, unknown>>();
  for (const run of runs) {
    const app = asRecord(run.app);
    const key = `${String(run.name ?? 'Unnamed check')}:${String(app?.id ?? '')}`;
    const prior = latest.get(key);
    const timestamp = String(run.started_at ?? run.completed_at ?? run.created_at ?? '');
    const priorTimestamp = String(prior?.started_at ?? prior?.completed_at ?? prior?.created_at ?? '');
    if (!prior || timestamp.localeCompare(priorTimestamp) >= 0) latest.set(key, run);
  }
  return [...latest.values()];
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
