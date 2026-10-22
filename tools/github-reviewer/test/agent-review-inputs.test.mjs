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
  assert.deepEqual(inputs.checkRuns.find((run) => run.name === 'API'), {
    name: 'API', headSha, status: 'completed', conclusion: 'success', detailsUrl: 'https://example.test/api', completedAt: '2026-10-21T10:00:00Z',
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

test('fails closed when changed source context exceeds the supported file limit', async () => {
  const files = Array.from({ length: 21 }, (_, index) => ({ filename: `src/file-${index}.ts`, status: 'modified' }));
  await assert.rejects(
    loadAgentReviewInputs(createFetch({ files }), 'owner/repo', 7, { head: { sha: headSha }, base: { sha: baseSha } }, 'token'),
    /too many files/,
  );
});

test('fails closed when changed source context exceeds the supported byte limit', async () => {
  await assert.rejects(
    loadAgentReviewInputs(createFetch({ source: 'x'.repeat(250_001) }), 'owner/repo', 7, { head: { sha: headSha }, base: { sha: baseSha } }, 'token'),
    /supported review context size/,
  );
});

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
