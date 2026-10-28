import { posix } from 'node:path';
import { GitHubApiError, requestGitHubApi } from './github-api-client.js';

export interface VaultContextSnapshot {
  path: string;
  revision: 'head' | 'base';
  content: string;
}

interface ChangedFile {
  filename?: unknown;
  status?: unknown;
}

interface ContextRoute {
  paths: string[];
  documents: string[];
}

interface ContextMap {
  version: 1;
  routes: ContextRoute[];
  catalogs: string[];
}

interface GitHubEvidenceReference {
  apiPath: string;
  sourceUrl: string;
  kind: 'review' | 'pullComment' | 'issueComment';
  pullRequestNumber: number;
  evidenceId: string;
}

const VAULT_INDEX = 'docs/knowledge/README.md';
const VAULT_CURRENT_STATE = 'docs/knowledge/current-state.md';
const VAULT_CONTEXT_MAP = 'docs/knowledge/context-map.json';
const MAX_VAULT_ITEMS = 160;
const MAX_VAULT_BYTES = 650_000;
const MAX_SINGLE_RESPONSE_BYTES = 100_000;

export async function loadVaultContext(
  fetchImpl: typeof fetch,
  repository: string,
  changedFiles: ChangedFile[],
  headSha: string,
  baseSha: string,
  token: string,
  knownSources: VaultContextSnapshot[] = [],
): Promise<VaultContextSnapshot[]> {
  const [owner, repositoryName, unexpected] = repository.split('/');
  if (!owner || !repositoryName || unexpected) throw new Error('Invalid repository identity for vault context.');

  const changed = new Map<string, string>();
  for (const file of changedFiles) {
    const filename = stringValue(file.filename);
    const status = stringValue(file.status);
    if (filename && status) changed.set(filename, status);
  }

  const known = new Map(knownSources.map((source) => [`${source.revision}:${source.path}`, source]));
  const snapshots: VaultContextSnapshot[] = [];
  const snapshotsByKey = new Map<string, VaultContextSnapshot>();
  const seen = new Set<string>();
  let totalBytes = 0;

  const addSnapshot = (snapshot: VaultContextSnapshot): boolean => {
    const key = `${snapshot.revision}:${snapshot.path}`;
    if (seen.has(key)) return false;
    const bytes = Buffer.byteLength(snapshot.content, 'utf8');
    if (snapshots.length >= MAX_VAULT_ITEMS || totalBytes + bytes > MAX_VAULT_BYTES) {
      throw new Error('Vault context exceeds the supported item or byte limit.');
    }
    seen.add(key);
    snapshotsByKey.set(key, snapshot);
    snapshots.push(snapshot);
    totalBytes += bytes;
    return true;
  };

  const loadLocal = async (path: string, optional = false): Promise<VaultContextSnapshot | undefined> => {
    assertSafeRepositoryPath(path);
    const status = changed.get(path);
    const revision: 'head' | 'base' = status === 'removed' ? 'base' : 'head';
    const key = `${revision}:${path}`;
    const loadedSource = snapshotsByKey.get(key);
    if (loadedSource) return loadedSource;
    const knownSource = known.get(key);
    if (knownSource) {
      addSnapshot(knownSource);
      return knownSource;
    }

    const ref = revision === 'head' ? headSha : baseSha;
    try {
      const payload = await requestGitHubApi<unknown>(
        fetchImpl,
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repositoryName)}/contents/${encodeRepositoryPath(path)}?ref=${encodeURIComponent(ref)}`,
        token,
        { maxResponseBytes: MAX_SINGLE_RESPONSE_BYTES },
      );
      if (Array.isArray(payload)) {
        throw new Error(`Vault context source must reference an exact file, not a directory: ${path}.`);
      }
      if (!isRecord(payload) || payload.encoding !== 'base64' || typeof payload.content !== 'string') {
        throw new Error(`Could not read vault context source: ${path}.`);
      }
      const content = Buffer.from(payload.content.replace(/\s/g, ''), 'base64').toString('utf8');
      if (content.includes('\0')) throw new Error(`Vault context source is binary: ${path}.`);
      const snapshot = { path, revision, content } satisfies VaultContextSnapshot;
      addSnapshot(snapshot);
      return snapshot;
    } catch (error) {
      if (optional && error instanceof GitHubApiError && error.status === 404) return undefined;
      throw error;
    }
  };

  const index = await loadLocal(VAULT_INDEX, true);
  if (!index) return [];
  const currentState = await loadLocal(VAULT_CURRENT_STATE, true);
  if (!currentState) throw new Error('Vault current state is unavailable.');
  const contextMapSnapshot = await loadLocal(VAULT_CONTEXT_MAP, true);
  const contextMap = contextMapSnapshot ? parseContextMap(contextMapSnapshot.content) : undefined;
  const catalogDocuments = new Set(contextMap?.catalogs ?? []);

  const selectedDocuments = new Set<string>();
  for (const path of changed.keys()) {
    if (path.startsWith('docs/knowledge/') && path.endsWith('.md')) selectedDocuments.add(path);
  }
  for (const route of contextMap?.routes ?? []) {
    if ([...changed.keys()].some((path) => route.paths.some((pattern) => matchesPattern(path, pattern)))) {
      route.documents.forEach((document) => selectedDocuments.add(document));
    }
  }

  const documentsToInspect: VaultContextSnapshot[] = [index, currentState];
  const queuedDocuments = new Set(documentsToInspect.map(({ path }) => path));
  for (const document of selectedDocuments) {
    assertKnowledgeDocument(document);
    const loaded = await loadLocal(document);
    if (loaded && !queuedDocuments.has(loaded.path)) {
      documentsToInspect.push(loaded);
      queuedDocuments.add(loaded.path);
    }
  }

  const remoteReferences = new Map<string, GitHubEvidenceReference>();
  for (let documentIndex = 0; documentIndex < documentsToInspect.length; documentIndex += 1) {
    const document = documentsToInspect[documentIndex];
    if (!document) continue;
    if (catalogDocuments.has(document.path)) continue;
    const targets = markdownLinks(document.content);
    const isNavigationRoot = document.path === VAULT_CURRENT_STATE || document.path.endsWith('/README.md');
    if (isNavigationRoot) continue;
    for (const target of targets) {
      const local = resolveLocalReference(document.path, target);
      if (local) {
        const loaded = await loadLocal(local);
        if (loaded && isKnowledgeDocument(loaded.path) && !queuedDocuments.has(loaded.path)) {
          documentsToInspect.push(loaded);
          queuedDocuments.add(loaded.path);
        }
      }
      const remote = resolveGitHubEvidenceReference(target, owner, repositoryName);
      if (remote) remoteReferences.set(`${remote.kind}:${remote.pullRequestNumber}:${remote.evidenceId}`, remote);
    }
  }

  const pendingEvidencePaths = new Set(
    [...remoteReferences.values()]
      .map(({ apiPath }) => `head:github-evidence://${apiPath.replace(/^\//, '')}`)
      .filter((key) => !seen.has(key)),
  );
  if (snapshots.length + pendingEvidencePaths.size > MAX_VAULT_ITEMS) {
    throw new Error('Vault context exceeds the supported item limit.');
  }

  const evidenceResponses = new Map<string, Record<string, unknown>>();
  for (const reference of remoteReferences.values()) {
    const { apiPath, sourceUrl } = reference;
    let payload = evidenceResponses.get(apiPath);
    if (!payload) {
      const response = await requestGitHubApi<unknown>(fetchImpl, apiPath, token, { maxResponseBytes: MAX_SINGLE_RESPONSE_BYTES });
      if (!isRecord(response)) throw new Error(`GitHub vault evidence is invalid: ${sourceUrl}.`);
      payload = response;
      evidenceResponses.set(apiPath, payload);
    }
    assertGitHubEvidenceAssociation(payload, reference, owner, repositoryName);
    const evidence = normalizeGitHubEvidence(payload, sourceUrl);
    addSnapshot({
      path: `github-evidence://${apiPath.replace(/^\//, '')}`,
      revision: 'head',
      content: `${JSON.stringify(evidence, null, 2)}\n`,
    });
  }

  return snapshots;
}

function parseContextMap(content: string): ContextMap {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error('Vault context map is not valid JSON.');
  }
  if (!isRecord(parsed) || parsed.version !== 1 || !Array.isArray(parsed.routes)) {
    throw new Error('Vault context map must declare version 1 and a routes array.');
  }
  const routes = parsed.routes.map((route) => {
    if (!isRecord(route) || !isStringArray(route.paths) || !isStringArray(route.documents)
      || route.paths.length === 0 || route.documents.length === 0) {
      throw new Error('Vault context map contains an invalid route.');
    }
    route.documents.forEach(assertKnowledgeDocument);
    route.paths.forEach((pattern) => {
      if (pattern.startsWith('/') || pattern.includes('..') || pattern.includes('\\')) {
        throw new Error(`Vault context map contains an unsafe path pattern: ${pattern}.`);
      }
    });
    return { paths: route.paths, documents: route.documents };
  });
  const catalogs = parsed.catalogs === undefined ? [] : parsed.catalogs;
  if (!isStringArray(catalogs)) throw new Error('Vault context map catalogs must be an array of documents.');
  catalogs.forEach(assertKnowledgeDocument);
  return { version: 1, routes, catalogs };
}

function markdownLinks(content: string): string[] {
  const markdown = withoutMarkdownCode(content);
  const targets = new Set(inlineMarkdownLinks(markdown));

  const definitions = new Map<string, string>();
  const definitionPattern = /^[ \t]{0,3}\[([^\]\r\n]+)\]:[ \t]*(?:<([^>\r\n]+)>|(\S+))(?:[ \t]+(?:"[^"\r\n]*"|'[^'\r\n]*'|\([^)]*\)))?[ \t]*$/gm;
  for (const match of markdown.matchAll(definitionPattern)) {
    const label = normalizeReferenceLabel(match[1]);
    const target = (match[2] ?? match[3])?.trim();
    if (!label || !target) continue;
    const existing = definitions.get(label);
    if (existing && existing !== target) {
      throw new Error(`Vault document contains conflicting Markdown link definitions: ${match[1]}.`);
    }
    definitions.set(label, target);
  }

  for (const match of markdown.matchAll(/(?<!!)\[([^\]\r\n]+)\]\[([^\]\r\n]*)\]/g)) {
    const label = normalizeReferenceLabel(match[2] || match[1]);
    const target = definitions.get(label);
    if (!target) throw new Error(`Vault document contains an undefined Markdown link reference: ${label}.`);
    targets.add(target);
  }

  for (const match of markdown.matchAll(/(?<![!\]])\[([^\]\r\n]+)\](?![\[(:])/g)) {
    const target = definitions.get(normalizeReferenceLabel(match[1]));
    if (target) targets.add(target);
  }

  return [...targets];
}

function inlineMarkdownLinks(markdown: string): string[] {
  const targets = new Set<string>();
  for (const line of markdown.split(/\r?\n/)) {
    let cursor = 0;
    while (cursor < line.length) {
      const labelStart = line.indexOf('[', cursor);
      if (labelStart < 0) break;
      if (isEscaped(line, labelStart)) {
        cursor = labelStart + 1;
        continue;
      }
      const labelEnd = closingDelimiter(line, labelStart, '[', ']');
      if (line[labelStart - 1] === '!' && !isEscaped(line, labelStart - 1)) {
        cursor = labelEnd < 0 ? labelStart + 1 : labelEnd + 1;
        continue;
      }
      if (labelEnd < 0 || line[labelEnd + 1] !== '(') {
        cursor = labelStart + 1;
        continue;
      }
      const parsed = inlineLinkDestination(line, labelEnd + 2);
      if (!parsed) {
        throw new Error('Vault document contains an unsupported or malformed inline Markdown link.');
      }
      if (parsed.target) targets.add(unescapeMarkdownDestination(parsed.target));
      cursor = parsed.end + 1;
    }
  }
  return [...targets];
}

function inlineLinkDestination(line: string, start: number): { target: string; end: number } | undefined {
  let cursor = skipHorizontalWhitespace(line, start);
  let target: string;

  if (line[cursor] === '<') {
    const destinationStart = ++cursor;
    while (cursor < line.length && line[cursor] !== '>') {
      if (line[cursor] === '\\') cursor++;
      cursor++;
    }
    if (line[cursor] !== '>') return undefined;
    target = line.slice(destinationStart, cursor);
    cursor++;
  } else {
    const destinationStart = cursor;
    let nestedParentheses = 0;
    while (cursor < line.length) {
      const character = line[cursor];
      if (character === '\\') {
        cursor += 2;
        continue;
      }
      if (character === '(') nestedParentheses++;
      if (character === ')') {
        if (nestedParentheses === 0) break;
        nestedParentheses--;
      }
      if ((character === ' ' || character === '\t') && nestedParentheses === 0) break;
      cursor++;
    }
    if (nestedParentheses !== 0) return undefined;
    target = line.slice(destinationStart, cursor);
  }

  const afterDestination = cursor;
  cursor = skipHorizontalWhitespace(line, cursor);
  if (line[cursor] === ')') return { target, end: cursor };
  if (cursor === afterDestination) return undefined;

  const titleStart = line[cursor];
  const titleEnd = titleStart === '(' ? ')' : titleStart === '"' || titleStart === "'" ? titleStart : undefined;
  if (!titleEnd) return undefined;
  cursor++;
  while (cursor < line.length && line[cursor] !== titleEnd) {
    if (line[cursor] === '\\') cursor++;
    cursor++;
  }
  if (line[cursor] !== titleEnd) return undefined;
  cursor = skipHorizontalWhitespace(line, cursor + 1);
  return line[cursor] === ')' ? { target, end: cursor } : undefined;
}

function closingDelimiter(line: string, start: number, opening: string, closing: string): number {
  let depth = 0;
  for (let cursor = start; cursor < line.length; cursor++) {
    if (line[cursor] === '\\') {
      cursor++;
      continue;
    }
    if (line[cursor] === opening) depth++;
    if (line[cursor] === closing && --depth === 0) return cursor;
  }
  return -1;
}

function skipHorizontalWhitespace(value: string, start: number): number {
  let cursor = start;
  while (value[cursor] === ' ' || value[cursor] === '\t') cursor++;
  return cursor;
}

function isEscaped(value: string, index: number): boolean {
  let backslashes = 0;
  for (let cursor = index - 1; cursor >= 0 && value[cursor] === '\\'; cursor--) backslashes++;
  return backslashes % 2 === 1;
}

function unescapeMarkdownDestination(value: string): string {
  return value.replace(/\\([!"#$%&'()*+,\-.\/:;<=\>?@[\]\\^_`{|}~])/g, '$1');
}

function withoutMarkdownCode(content: string): string {
  let fence: { marker: '`' | '~'; length: number } | undefined;
  return content.split(/\r?\n/).map((line) => {
    const fenceMatch = line.match(/^[ \t]{0,3}(`{3,}|~{3,})/);
    if (fence) {
      if (fenceMatch && fenceMatch[1]?.startsWith(fence.marker) && fenceMatch[1].length >= fence.length
        && /^[ \t]*$/.test(line.slice(fenceMatch[0].length))) {
        fence = undefined;
      }
      return '';
    }
    if (fenceMatch) {
      const delimiter = fenceMatch[1];
      if (delimiter) fence = { marker: delimiter[0] as '`' | '~', length: delimiter.length };
      return '';
    }
    return line.replace(/(`+)([^`\r\n]*?)\1/g, 'CODE');
  }).join('\n');
}

function normalizeReferenceLabel(value: string | undefined): string {
  return value?.trim().replace(/\s+/g, ' ').toLowerCase() ?? '';
}

function resolveLocalReference(documentPath: string, target: string): string | undefined {
  if (/^(?:https?:\/\/|mailto:|#)/i.test(target)) return undefined;
  const withoutFragment = target.split('#', 1)[0];
  if (!withoutFragment) return undefined;
  let decoded: string;
  try {
    decoded = decodeURIComponent(withoutFragment);
  } catch {
    throw new Error(`Vault document contains an invalid encoded link: ${target}.`);
  }
  const resolved = posix.normalize(posix.join(posix.dirname(documentPath), decoded));
  assertSafeRepositoryPath(resolved);
  return resolved;
}

function resolveGitHubEvidenceReference(
  target: string,
  owner: string,
  repository: string,
): GitHubEvidenceReference | undefined {
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== 'github.com') return undefined;
  const match = url.pathname.match(/^\/([^/]+)\/([^/]+)\/pull\/(\d+)\/?$/i);
  if (!match || match[1]?.toLowerCase() !== owner.toLowerCase() || match[2]?.toLowerCase() !== repository.toLowerCase()) return undefined;
  const pullRequestNumber = Number(match[3]);
  const review = url.hash.match(/^#pullrequestreview-(\d+)$/);
  if (review) return { apiPath: `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/pulls/${pullRequestNumber}/reviews/${review[1]}`, sourceUrl: url.href, kind: 'review', pullRequestNumber, evidenceId: review[1] };
  const comment = url.hash.match(/^#discussion_r(\d+)$/);
  if (comment) return { apiPath: `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/pulls/comments/${comment[1]}`, sourceUrl: url.href, kind: 'pullComment', pullRequestNumber, evidenceId: comment[1] };
  const issueComment = url.hash.match(/^#issuecomment-(\d+)$/);
  if (issueComment) return { apiPath: `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/issues/comments/${issueComment[1]}`, sourceUrl: url.href, kind: 'issueComment', pullRequestNumber, evidenceId: issueComment[1] };
  return undefined;
}

function assertGitHubEvidenceAssociation(
  payload: Record<string, unknown>,
  reference: GitHubEvidenceReference,
  owner: string,
  repository: string,
): void {
  if (String(payload.id ?? '') !== reference.evidenceId) {
    throw new Error(`GitHub vault evidence identifier does not match its reference: ${reference.sourceUrl}.`);
  }
  const expectedHash = reference.kind === 'review'
    ? `#pullrequestreview-${reference.evidenceId}`
    : reference.kind === 'pullComment' ? `#discussion_r${reference.evidenceId}` : `#issuecomment-${reference.evidenceId}`;
  if (!matchesGitHubPullRequestUrl(payload.html_url, owner, repository, reference.pullRequestNumber, expectedHash)) {
    throw new Error(`GitHub vault evidence URL does not match its reference: ${reference.sourceUrl}.`);
  }
  if (reference.kind === 'pullComment'
    && !matchesGitHubApiUrl(payload.pull_request_url, owner, repository, 'pulls', reference.pullRequestNumber)) {
    throw new Error(`GitHub review comment does not belong to the referenced Pull Request: ${reference.sourceUrl}.`);
  }
  if (reference.kind === 'issueComment'
    && !matchesGitHubApiUrl(payload.issue_url, owner, repository, 'issues', reference.pullRequestNumber)) {
    throw new Error(`GitHub conversation comment does not belong to the referenced Pull Request: ${reference.sourceUrl}.`);
  }
}

function matchesGitHubPullRequestUrl(
  value: unknown,
  owner: string,
  repository: string,
  pullRequestNumber: number,
  expectedHash: string,
): boolean {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:'
      && url.hostname.toLowerCase() === 'github.com'
      && url.pathname.toLowerCase() === `/${owner}/${repository}/pull/${pullRequestNumber}`.toLowerCase()
      && url.hash === expectedHash
      && url.search === '';
  } catch {
    return false;
  }
}

function matchesGitHubApiUrl(
  value: unknown,
  owner: string,
  repository: string,
  collection: 'pulls' | 'issues',
  pullRequestNumber: number,
): boolean {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:'
      && url.hostname.toLowerCase() === 'api.github.com'
      && url.pathname.toLowerCase() === `/repos/${owner}/${repository}/${collection}/${pullRequestNumber}`.toLowerCase()
      && url.search === ''
      && url.hash === '';
  } catch {
    return false;
  }
}

function normalizeGitHubEvidence(payload: Record<string, unknown>, sourceUrl: string): Record<string, unknown> {
  const user = isRecord(payload.user) ? payload.user : undefined;
  return {
    sourceUrl,
    id: payload.id ?? null,
    state: payload.state ?? null,
    commitId: payload.commit_id ?? null,
    submittedAt: payload.submitted_at ?? payload.created_at ?? null,
    author: user?.login ?? null,
    body: typeof payload.body === 'string' ? payload.body : '',
    htmlUrl: payload.html_url ?? null,
    path: payload.path ?? null,
    line: payload.line ?? payload.original_line ?? null,
  };
}

function matchesPattern(path: string, pattern: string): boolean {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '\0').replace(/\*/g, '[^/]*').replace(/\0/g, '.*');
  return new RegExp(`^${escaped}$`).test(path);
}

function assertKnowledgeDocument(path: string): void {
  assertSafeRepositoryPath(path);
  if (!isKnowledgeDocument(path)) {
    throw new Error(`Vault context document is outside docs/knowledge or is not Markdown: ${path}.`);
  }
}

function isKnowledgeDocument(path: string): boolean {
  return path.startsWith('docs/knowledge/') && path.endsWith('.md');
}

function assertSafeRepositoryPath(path: string): void {
  if (!path || path.startsWith('/') || path.startsWith('../') || path.includes('/../') || path.includes('\\') || path.includes('\0')) {
    throw new Error(`Vault context contains an unsafe repository path: ${path}.`);
  }
}

function encodeRepositoryPath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string' && item.length > 0);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
