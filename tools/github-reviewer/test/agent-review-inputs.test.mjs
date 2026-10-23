import assert from 'node:assert/strict';
import test from 'node:test';
import { loadAgentReviewInputs, summarizeAgentChecks, summarizeCheckRunEvidence } from '../dist/agent-review-inputs.js';
import { requestGitHubApiPages } from '../dist/github-api-client.js';

const headSha = 'a'.repeat(40);
const baseSha = 'b'.repeat(40);

function encoded(content) {
  return Buffer.from(content, 'utf8').toString('base64');
}

function createFetch({
  files = [{ filename: 'src/example.ts', status: 'modified' }],
  source = 'export const value = 42;\n',
  sources = {},
  requests = [],
} = {}) {
  return async (url, options = {}) => {
    const parsed = new URL(url);
    const path = parsed.pathname;
    requests.push(parsed);
    let payload;
    let text = false;
    if (path.endsWith('/pulls/7') && options.headers?.Accept === 'application/vnd.github.v3.diff') {
      payload = 'diff --git a/src/example.ts b/src/example.ts\n';
      text = true;
    } else if (path.endsWith(`/commits/${headSha}/check-runs`)) {
      payload = { check_runs: [
        { name: 'API', head_sha: headSha, status: 'completed', conclusion: 'success', details_url: 'https://example.test/api', completed_at: '2026-10-21T10:00:00Z' },
        { name: 'Web', head_sha: headSha, status: 'completed', conclusion: 'success' },
        { name: 'GitHub Reviewer', app: { id: 15368 }, head_sha: headSha, status: 'completed', conclusion: 'success' },
        { name: 'SonarQube', head_sha: headSha, status: 'completed', conclusion: 'success' },
        { name: 'SonarCloud Code Analysis', head_sha: headSha, status: 'completed', conclusion: 'success' },
      ] };
    } else if (path.endsWith('/contents/AGENTS.md')) {
      payload = { encoding: 'base64', content: encoded('Project rules') };
    } else if (path.endsWith('/pulls/7/files')) {
      payload = files;
    } else if (path.includes('/contents/')) {
      const sourcePath = decodeURIComponent(path.split('/contents/')[1]);
      const ref = parsed.searchParams.get('ref');
      const content = sources[`${ref}:${sourcePath}`] ?? sources[sourcePath] ?? (sourcePath === 'src/example.ts' ? source : undefined);
      if (content === undefined) return new Response('{}', { status: 404 });
      payload = { encoding: 'base64', content: encoded(content) };
    } else {
      return new Response('{}', { status: 404 });
    }
    return new Response(text ? payload : JSON.stringify(payload), { status: 200 });
  };
}

test('loads complete changed source snapshots at the PR HEAD alongside diff and checks', async () => {
  const requests = [];
  const inputs = await loadAgentReviewInputs(createFetch({ requests }), 'owner/repo', 7, {
    head: { sha: headSha },
    base: { sha: baseSha },
  }, 'token');

  assert.equal(inputs.diff.startsWith('diff --git'), true);
  assert.equal(inputs.checks.api, 'PASSED');
  assert.equal(inputs.checks.githubReviewer, 'PASSED');
  assert.deepEqual(inputs.checkRuns.find((run) => run.name === 'API'), {
    name: 'API', appId: null, headSha, status: 'completed', conclusion: 'success', detailsUrl: 'https://example.test/api', completedAt: '2026-10-21T10:00:00Z',
    actions: { availability: 'unavailable', reason: 'Verified GitHub Actions job evidence is unavailable.' },
  });
  assert.equal(inputs.repositoryInstructions, 'Project rules');
  assert.deepEqual(inputs.sourceFiles, [{ path: 'src/example.ts', revision: 'head', content: 'export const value = 42;\n' }]);
  assert.equal(requests.some((request) => request.pathname.endsWith('/contents/src/example.ts') && request.searchParams.get('ref') === headSha), true);
});

test('uses latest rerun results for summaries and exposes only current-SHA required checks', () => {
  const runs = [
    { name: 'API', head_sha: headSha, status: 'completed', conclusion: 'failure', started_at: '2026-10-21T09:00:00Z' },
    { name: 'API', head_sha: headSha, status: 'completed', conclusion: 'success', started_at: '2026-10-21T10:00:00Z' },
    { name: 'Web', head_sha: 'c'.repeat(40), status: 'completed', conclusion: 'success' },
  ];

  assert.equal(summarizeAgentChecks(runs, headSha).api, 'PASSED');
  assert.equal(summarizeAgentChecks(runs, headSha).web, 'MISSING');
  assert.deepEqual(summarizeCheckRunEvidence(runs, headSha).map(({ name, conclusion }) => ({ name, conclusion })), [{ name: 'API', conclusion: 'success' }]);
});

test('requires a current successful GitHub Actions Reviewer check in the prerequisite summary', () => {
  const reviewer = { name: 'GitHub Reviewer', app: { id: 15368 }, head_sha: headSha, status: 'completed', conclusion: 'success' };
  for (const [runs, expected] of [
    [[], 'MISSING'], [[reviewer], 'PASSED'], [[{ ...reviewer, head_sha: baseSha }], 'MISSING'],
    [[{ ...reviewer, app: { id: 999 } }], 'MISSING'], [[{ ...reviewer, app: undefined }], 'MISSING'],
    [[{ ...reviewer, conclusion: 'failure' }], 'FAILED'], [[{ ...reviewer, conclusion: 'skipped' }], 'FAILED'],
    [[{ ...reviewer, status: 'in_progress', conclusion: null }], 'PENDING'],
  ]) assert.equal(summarizeAgentChecks(runs, headSha).githubReviewer, expected);
});

test('loads removed source files from the base commit', async () => {
  const requests = [];
  const inputs = await loadAgentReviewInputs(createFetch({
    files: [{ filename: 'src/removed.ts', status: 'removed' }],
    sources: { [`${baseSha}:src/removed.ts`]: 'export const legacy = true;\n' },
    requests,
  }), 'owner/repo', 7, { head: { sha: headSha }, base: { sha: baseSha } }, 'token');

  assert.deepEqual(inputs.sourceFiles, [{ path: 'src/removed.ts', revision: 'base', content: 'export const legacy = true;\n' }]);
  assert.equal(requests.some((request) => request.pathname.endsWith('/contents/src/removed.ts') && request.searchParams.get('ref') === baseSha), true);
});

test('includes unchanged direct local dependencies without following imports recursively', async () => {
  const inputs = await loadAgentReviewInputs(createFetch({
    source: "import { value } from './helper.js'; export { value };",
    sources: { 'src/helper.ts': "import { other } from './other.js'; export const value = other;" },
  }), 'owner/repo', 7, { head: { sha: headSha }, base: { sha: baseSha } }, 'token');
  assert.deepEqual(inputs.sourceFiles.map(({ path }) => path), ['src/example.ts', 'src/helper.ts']);
});

test('loads all 32 changed files at the supported boundary without omitting sources', async () => {
  const files = Array.from({ length: 32 }, (_, index) => ({ filename: `src/file-${index}.ts`, status: 'modified' }));
  const sources = Object.fromEntries(files.map(({ filename }) => [filename, 'export const value = 1;']));
  const inputs = await loadAgentReviewInputs(createFetch({ files, sources }), 'owner/repo', 7, { head: { sha: headSha }, base: { sha: baseSha } }, 'token');
  assert.deepEqual(inputs.sourceFiles.map(({ path }) => path), files.map(({ filename }) => filename));
});

test('fails closed when changed source context exceeds the supported file limit', async () => {
  const files = Array.from({ length: 33 }, (_, index) => ({ filename: `src/file-${index}.ts`, status: 'modified' }));
  await assert.rejects(
    loadAgentReviewInputs(createFetch({ files }), 'owner/repo', 7, { head: { sha: headSha }, base: { sha: baseSha } }, 'token'),
    /too many files/,
  );
});

test('loads all 64 direct dependencies at the supported boundary', async () => {
  const source = Array.from({ length: 64 }, (_, index) => `import { value as value${index} } from './helper-${index}.js';`).join('\n');
  const sources = Object.fromEntries(Array.from({ length: 64 }, (_, index) => [`src/helper-${index}.ts`, 'export const value = 1;']));
  const inputs = await loadAgentReviewInputs(
    createFetch({ source, sources }),
    'owner/repo',
    7,
    { head: { sha: headSha }, base: { sha: baseSha } },
    'token',
  );
  assert.equal(inputs.sourceFiles.length, 65);
});

test('keeps the direct dependency limit at 64 additional files', async () => {
  const source = Array.from({ length: 65 }, (_, index) => `import { value as value${index} } from './helper-${index}.js';`).join('\n');
  await assert.rejects(
    loadAgentReviewInputs(createFetch({ source }), 'owner/repo', 7, { head: { sha: headSha }, base: { sha: baseSha } }, 'token'),
    /dependencies exceed the supported source file limit/,
  );
});

test('fails closed when changed source context exceeds the supported byte limit', async () => {
  await assert.rejects(
    loadAgentReviewInputs(createFetch({ source: 'x'.repeat(500_001) }), 'owner/repo', 7, { head: { sha: headSha }, base: { sha: baseSha } }, 'token'),
    /supported review context size/,
  );
});

for (const totalBytes of [499_999, 500_000, 500_001]) {
  test(`enforces the cumulative UTF-8 source boundary at ${totalBytes} bytes across changed, removed and dependency files`, async () => {
    const source = "import { value } from './helper.js';\n";
    const removed = 'á'.repeat(100_000);
    const dependency = 'x'.repeat(totalBytes - Buffer.byteLength(source, 'utf8') - Buffer.byteLength(removed, 'utf8'));
    const expected = [
      { path: 'src/example.ts', revision: 'head', content: source },
      { path: 'src/removed.ts', revision: 'base', content: removed },
      { path: 'src/helper.ts', revision: 'head', content: dependency },
    ];
    const pending = loadAgentReviewInputs(createFetch({
      files: [{ filename: 'src/example.ts', status: 'modified' }, { filename: 'src/removed.ts', status: 'removed' }],
      source,
      sources: { [`${baseSha}:src/removed.ts`]: removed, 'src/helper.ts': dependency },
    }), 'owner/repo', 7, { head: { sha: headSha }, base: { sha: baseSha } }, 'token');

    if (totalBytes > 500_000) {
      await assert.rejects(pending, /supported review context size/);
    } else {
      const inputs = await pending;
      assert.deepEqual(inputs.sourceFiles, expected);
      assert.equal(inputs.sourceFiles.reduce((size, file) => size + Buffer.byteLength(file.content, 'utf8'), 0), totalBytes);
    }
  });
}

test('loads every page returned by the GitHub pagination helper', async () => {
  const requests = [];
  const items = await requestGitHubApiPages(async (url) => {
    const parsed = new URL(url);
    requests.push(parsed);
    const page = parsed.searchParams.get('page');
    const payload = page === '1'
      ? Array.from({ length: 100 }, (_, index) => ({ id: index + 1 }))
      : [{ id: 101 }];
    return new Response(JSON.stringify(payload), { status: 200 });
  }, '/repos/owner/repo/pulls/7/files', 'token');

  assert.equal(items.length, 101);
  assert.deepEqual(items.slice(-2), [{ id: 100 }, { id: 101 }]);
  assert.deepEqual(requests.map((request) => request.searchParams.get('page')), ['1', '2']);
});

test('fails closed when a paginated GitHub response is not an array', async () => {
  await assert.rejects(
    requestGitHubApiPages(async () => new Response(JSON.stringify({ items: [] }), { status: 200 }), '/repos/owner/repo/pulls/7/files', 'token'),
    /invalid paginated response/,
  );
});
