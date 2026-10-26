import assert from 'node:assert/strict';
import test from 'node:test';
import { loadVaultContext } from '../dist/vault-context.js';

const headSha = 'a'.repeat(40);
const baseSha = 'b'.repeat(40);
const repository = 'owner/repo';

function encoded(content) {
  return { encoding: 'base64', content: Buffer.from(content).toString('base64') };
}

function fakeFetch(files = {}, evidence = {}, requests = []) {
  return async (url) => {
    const parsed = new URL(url);
    requests.push(parsed);
    const contentsMarker = '/repos/owner/repo/contents/';
    if (parsed.pathname.startsWith(contentsMarker)) {
      const path = parsed.pathname.slice(contentsMarker.length).split('/').map(decodeURIComponent).join('/');
      assert.equal(parsed.searchParams.get('ref'), files[path]?.ref ?? headSha);
      const value = files[path]?.value;
      if (value === undefined) return new Response('', { status: 404 });
      return Response.json(typeof value === 'string' ? encoded(value) : value);
    }
    const value = evidence[parsed.pathname];
    if (value === undefined) return new Response('', { status: 404 });
    return Response.json(value);
  };
}

function baseVault(overrides = {}) {
  return {
    'docs/knowledge/README.md': { value: '# Index\n' },
    'docs/knowledge/current-state.md': { value: '# Current state\n' },
    ...overrides,
  };
}

test('loads the vault index, current state, routed note and exact local source at the PR HEAD', async () => {
  const requests = [];
  const files = baseVault({
    'docs/knowledge/context-map.json': { value: JSON.stringify({ version: 1, routes: [{ paths: ['apps/api/src/**'], documents: ['docs/knowledge/domains/backend.md'] }] }) },
    'docs/knowledge/domains/backend.md': { value: '# Backend\n[Service](../../../apps/api/src/service.ts)\n' },
    'apps/api/src/service.ts': { value: 'export const value = 1;\n' },
  });

  const result = await loadVaultContext(fakeFetch(files, {}, requests), repository, [{ filename: 'apps/api/src/route.ts', status: 'modified' }], headSha, baseSha, 'token');

  assert.deepEqual(result.map(({ path }) => path), [
    'docs/knowledge/README.md',
    'docs/knowledge/current-state.md',
    'docs/knowledge/context-map.json',
    'docs/knowledge/domains/backend.md',
    'apps/api/src/service.ts',
  ]);
  assert.equal(result.every(({ revision }) => revision === 'head'), true);
  assert.equal(requests.every((request) => request.searchParams.get('ref') === headSha), true);
});

test('inspects references from the required index and current state when only code changed', async () => {
  const files = baseVault({
    'docs/knowledge/README.md': { value: '# Index\n[Architecture](architecture.md)\n' },
    'docs/knowledge/current-state.md': { value: '# Current state\n[Contract](../../docs/contract.md)\n' },
    'docs/knowledge/architecture.md': { value: '# Architecture\n' },
    'docs/contract.md': { value: '# Contract\n' },
  });

  const result = await loadVaultContext(fakeFetch(files), repository, [{ filename: 'apps/api/src/route.ts', status: 'modified' }], headSha, baseSha, 'token');

  assert.deepEqual(result.map(({ path }) => path), [
    'docs/knowledge/README.md',
    'docs/knowledge/current-state.md',
    'docs/contract.md',
    'docs/knowledge/architecture.md',
  ]);
});

test('loads only verifiable same-repository GitHub review evidence', async () => {
  const files = baseVault({
    'docs/knowledge/learnings/code-review.md': {
      value: [
        '# Learning',
        '[Formal review](https://github.com/owner/repo/pull/44#pullrequestreview-123)',
        '[Inline comment](https://github.com/owner/repo/pull/44#discussion_r456)',
        '[External](https://github.com/other/repo/pull/1#issuecomment-789)',
      ].join('\n'),
    },
  });
  const evidence = {
    '/repos/owner/repo/pulls/44/reviews/123': { id: 123, state: 'CHANGES_REQUESTED', commit_id: headSha, body: 'Confirmed issue', user: { login: 'reviewer' }, html_url: 'https://github.com/owner/repo/pull/44#pullrequestreview-123' },
    '/repos/owner/repo/pulls/comments/456': { id: 456, body: 'Inline issue', user: { login: 'reviewer' }, path: 'src/a.ts', line: 10, html_url: 'https://github.com/owner/repo/pull/44#discussion_r456', pull_request_url: 'https://api.github.com/repos/owner/repo/pulls/44' },
  };

  const result = await loadVaultContext(fakeFetch(files, evidence), repository, [{ filename: 'docs/knowledge/learnings/code-review.md', status: 'added' }], headSha, baseSha, 'token');

  const remote = result.filter(({ path }) => path.startsWith('github-evidence://'));
  assert.equal(remote.length, 2);
  assert.match(remote[0].content, /Confirmed issue/);
  assert.match(remote[1].content, /Inline issue/);
  assert.equal(result.some(({ content }) => content.includes('other/repo/issues/comments')), false);
});

test('rejects GitHub comments that do not belong to the Pull Request cited by the vault', async (t) => {
  await t.test('inline review comment', async () => {
    const files = baseVault({ 'docs/knowledge/note.md': { value: '[Comment](https://github.com/owner/repo/pull/44#discussion_r456)\n' } });
    const evidence = { '/repos/owner/repo/pulls/comments/456': { id: 456, html_url: 'https://github.com/owner/repo/pull/45#discussion_r456', pull_request_url: 'https://api.github.com/repos/owner/repo/pulls/45' } };
    await assert.rejects(loadVaultContext(fakeFetch(files, evidence), repository, [{ filename: 'docs/knowledge/note.md', status: 'added' }], headSha, baseSha, 'token'), /does not match|does not belong/);
  });
  await t.test('Pull Request conversation comment', async () => {
    const files = baseVault({ 'docs/knowledge/note.md': { value: '[Comment](https://github.com/owner/repo/pull/44#issuecomment-789)\n' } });
    const evidence = { '/repos/owner/repo/issues/comments/789': { id: 789, html_url: 'https://github.com/owner/repo/pull/45#issuecomment-789', issue_url: 'https://api.github.com/repos/owner/repo/issues/45' } };
    await assert.rejects(loadVaultContext(fakeFetch(files, evidence), repository, [{ filename: 'docs/knowledge/note.md', status: 'added' }], headSha, baseSha, 'token'), /does not match|does not belong/);
  });
  await t.test('contradictory links for the same comment', async () => {
    const files = baseVault({ 'docs/knowledge/note.md': { value: '[Wrong](https://github.com/owner/repo/pull/43#discussion_r456)\n[Right](https://github.com/owner/repo/pull/44#discussion_r456)\n' } });
    const evidence = { '/repos/owner/repo/pulls/comments/456': { id: 456, html_url: 'https://github.com/owner/repo/pull/44#discussion_r456', pull_request_url: 'https://api.github.com/repos/owner/repo/pulls/44' } };
    await assert.rejects(loadVaultContext(fakeFetch(files, evidence), repository, [{ filename: 'docs/knowledge/note.md', status: 'added' }], headSha, baseSha, 'token'), /does not match|does not belong/);
  });
});

test('uses the base revision only for a removed vault document', async () => {
  const files = baseVault({
    'docs/knowledge/removed.md': { ref: baseSha, value: '# Removed\n' },
  });
  const result = await loadVaultContext(fakeFetch(files), repository, [{ filename: 'docs/knowledge/removed.md', status: 'removed' }], headSha, baseSha, 'token');
  assert.equal(result.find(({ path }) => path === 'docs/knowledge/removed.md').revision, 'base');
});

test('fails closed for unsafe local paths, directories and invalid context maps', async (t) => {
  await t.test('unsafe local link', async () => {
    const files = baseVault({ 'docs/knowledge/note.md': { value: '[Unsafe](../../../..//outside.md)\n' } });
    await assert.rejects(loadVaultContext(fakeFetch(files), repository, [{ filename: 'docs/knowledge/note.md', status: 'added' }], headSha, baseSha, 'token'), /unsafe repository path/);
  });
  await t.test('directory source', async () => {
    const files = baseVault({
      'docs/knowledge/note.md': { value: '[Directory](source)\n' },
      'docs/knowledge/source': { value: [{ name: 'file.md' }] },
    });
    await assert.rejects(loadVaultContext(fakeFetch(files), repository, [{ filename: 'docs/knowledge/note.md', status: 'added' }], headSha, baseSha, 'token'), /exact file, not a directory/);
  });
  await t.test('invalid context map', async () => {
    const files = baseVault({ 'docs/knowledge/context-map.json': { value: '{invalid' } });
    await assert.rejects(loadVaultContext(fakeFetch(files), repository, [], headSha, baseSha, 'token'), /not valid JSON/);
  });
});

test('fails closed before fetching evidence when the item limit would be exceeded', async () => {
  const links = Array.from({ length: 160 }, (_, index) => `[Review ${index}](https://github.com/owner/repo/pull/44#pullrequestreview-${index + 1})`).join('\n');
  const files = baseVault({ 'docs/knowledge/large.md': { value: links } });
  const requests = [];

  await assert.rejects(loadVaultContext(fakeFetch(files, {}, requests), repository, [{ filename: 'docs/knowledge/large.md', status: 'added' }], headSha, baseSha, 'token'), /item limit/);
  assert.equal(requests.some(({ pathname }) => pathname.includes('/pulls/44/reviews/')), false);
});

test('treats a missing vault index as an optional empty context', async () => {
  assert.deepEqual(await loadVaultContext(fakeFetch(), repository, [], headSha, baseSha, 'token'), []);
});

test('fails closed when the vault index exists without the required current state', async () => {
  const files = { 'docs/knowledge/README.md': { value: '# Index\n' } };
  await assert.rejects(loadVaultContext(fakeFetch(files), repository, [], headSha, baseSha, 'token'), /current state is unavailable/);
});
