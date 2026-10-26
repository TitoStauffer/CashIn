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

test('loads direct sources but does not expand vault navigation from the required roots', async () => {
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
  ]);
});

test('walks referenced vault notes and loads their local and review evidence', async () => {
  const reviewPath = '/repos/owner/repo/pulls/44/reviews/123';
  const files = baseVault({
    'docs/knowledge/README.md': { value: '# Index\n[Learning](learnings/example.md)\n' },
    'docs/knowledge/learnings/example.md': { value: '# Learning\n[Index](../README.md)\n[Source][source]\n[Review][review]\n\n[source]: ../../../apps/api/src/service.ts\n[review]: https://github.com/owner/repo/pull/44#pullrequestreview-123\n' },
    'apps/api/src/service.ts': { value: 'export const value = 1;\n' },
  });
  const review = { id: 123, state: 'CHANGES_REQUESTED', body: 'First evidence', html_url: 'https://github.com/owner/repo/pull/44#pullrequestreview-123' };

  const changedFiles = [{ filename: 'docs/knowledge/learnings/example.md', status: 'modified' }];
  const first = await loadVaultContext(fakeFetch(files, { [reviewPath]: review }), repository, changedFiles, headSha, baseSha, 'token');
  const second = await loadVaultContext(fakeFetch(files, { [reviewPath]: { ...review, body: 'Updated evidence' } }), repository, changedFiles, headSha, baseSha, 'token');

  assert.deepEqual(first.map(({ path }) => path), [
    'docs/knowledge/README.md',
    'docs/knowledge/current-state.md',
    'docs/knowledge/learnings/example.md',
    'apps/api/src/service.ts',
    `github-evidence://${reviewPath.slice(1)}`,
  ]);
  assert.match(first.at(-1).content, /First evidence/);
  assert.match(second.at(-1).content, /Updated evidence/);
  assert.notEqual(first.at(-1).content, second.at(-1).content);
});

test('resolves collapsed and shortcut Markdown reference links without treating images as sources', async () => {
  const files = baseVault({
    'docs/knowledge/learnings/references.md': {
      value: '# Index\n[Collapsed][]\n[Shortcut]\n![Diagram][image]\n\n[collapsed]: collapsed.md\n[shortcut]: shortcut.md\n[image]: missing.png\n',
    },
    'docs/knowledge/learnings/collapsed.md': { value: '# Collapsed\n' },
    'docs/knowledge/learnings/shortcut.md': { value: '# Shortcut\n' },
  });

  const result = await loadVaultContext(
    fakeFetch(files),
    repository,
    [{ filename: 'docs/knowledge/learnings/references.md', status: 'modified' }],
    headSha,
    baseSha,
    'token',
  );

  assert.deepEqual(result.map(({ path }) => path), [
    'docs/knowledge/README.md',
    'docs/knowledge/current-state.md',
    'docs/knowledge/learnings/references.md',
    'docs/knowledge/learnings/collapsed.md',
    'docs/knowledge/learnings/shortcut.md',
  ]);
});

test('ignores link-shaped examples inside inline and fenced Markdown code', async () => {
  const files = baseVault({
    'docs/knowledge/README.md': {
      value: '# Index\n`[Inline][missing]`\n![Inline image](missing.png "Not a source")\n\n```markdown\n[Fenced][missing]\n```\n\n~~~\n[Other fence](missing.md)\n~~~\n',
    },
  });

  const result = await loadVaultContext(fakeFetch(files), repository, [], headSha, baseSha, 'token');

  assert.deepEqual(result.map(({ path }) => path), [
    'docs/knowledge/README.md',
    'docs/knowledge/current-state.md',
  ]);
});

test('preserves link destinations when their labels contain inline code', async () => {
  const reviewPath = '/repos/owner/repo/pulls/44/reviews/123';
  const files = baseVault({
    'docs/knowledge/README.md': {
      value: '# Index\n[`service.ts`](../../apps/api/src/service.ts)\n[`Review`](https://github.com/owner/repo/pull/44#pullrequestreview-123)\n',
    },
    'apps/api/src/service.ts': { value: 'export const value = 1;\n' },
  });
  const review = { id: 123, state: 'CHANGES_REQUESTED', body: 'Confirmed issue', html_url: 'https://github.com/owner/repo/pull/44#pullrequestreview-123' };

  const result = await loadVaultContext(fakeFetch(files, { [reviewPath]: review }), repository, [], headSha, baseSha, 'token');

  assert.equal(result.some(({ path }) => path === 'apps/api/src/service.ts'), true);
  assert.equal(result.some(({ path, content }) => path === `github-evidence://${reviewPath.slice(1)}` && content.includes('Confirmed issue')), true);
});

test('resolves inline destinations with titles, angle brackets, escapes and balanced parentheses', async () => {
  const reviewPath = '/repos/owner/repo/pulls/44/reviews/123';
  const files = baseVault({
    'docs/knowledge/README.md': {
      value: [
        '# Index',
        '[Service](../../apps/api/src/service.ts "Serviço")',
        "[Spaced](\u003c../../apps/api/src/spaced file.ts\u003e 'Arquivo')",
        '[Nested](../../apps/api/src/value(test).ts)',
        '[Escaped](../../apps/api/src/value\\(escaped\\).ts)',
        '[Review](\u003chttps://github.com/owner/repo/pull/44#pullrequestreview-123\u003e "Evidência")',
      ].join('\n'),
    },
    'apps/api/src/service.ts': { value: 'export const service = 1;\n' },
    'apps/api/src/spaced file.ts': { value: 'export const spaced = 1;\n' },
    'apps/api/src/value(test).ts': { value: 'export const nested = 1;\n' },
    'apps/api/src/value(escaped).ts': { value: 'export const escaped = 1;\n' },
  });
  const review = { id: 123, state: 'CHANGES_REQUESTED', body: 'Confirmed issue', html_url: 'https://github.com/owner/repo/pull/44#pullrequestreview-123' };

  const result = await loadVaultContext(fakeFetch(files, { [reviewPath]: review }), repository, [], headSha, baseSha, 'token');

  assert.deepEqual(result.map(({ path }) => path), [
    'docs/knowledge/README.md',
    'docs/knowledge/current-state.md',
    'apps/api/src/service.ts',
    'apps/api/src/spaced file.ts',
    'apps/api/src/value(test).ts',
    'apps/api/src/value(escaped).ts',
    `github-evidence://${reviewPath.slice(1)}`,
  ]);
});

test('fails closed for a missing source whose link label contains inline code', async () => {
  const files = baseVault({
    'docs/knowledge/README.md': { value: '# Index\n[`missing.ts`](../../apps/api/src/missing.ts)\n' },
  });

  await assert.rejects(
    loadVaultContext(fakeFetch(files), repository, [], headSha, baseSha, 'token'),
    /GitHub API request failed \(404\)/,
  );
});

test('fails closed for a missing source in a titled inline link', async () => {
  const files = baseVault({
    'docs/knowledge/README.md': { value: '# Index\n[Missing](../../apps/api/src/missing.ts "Source")\n' },
  });

  await assert.rejects(
    loadVaultContext(fakeFetch(files), repository, [], headSha, baseSha, 'token'),
    /GitHub API request failed \(404\)/,
  );
});

test('fails closed for unsupported or malformed inline link syntax', async () => {
  const files = baseVault({
    'docs/knowledge/README.md': { value: '# Index\n[Malformed](../../apps/api/src/service.ts "Missing close)\n' },
  });

  await assert.rejects(
    loadVaultContext(fakeFetch(files), repository, [], headSha, baseSha, 'token'),
    /unsupported or malformed inline Markdown link/,
  );
});

test('fails closed when a referenced vault note cites a missing source', async () => {
  const files = baseVault({
    'docs/knowledge/README.md': { value: '# Index\n[Learning](learnings/example.md)\n' },
    'docs/knowledge/learnings/example.md': { value: '# Learning\n[Missing][source]\n\n[source]: ../../../apps/api/src/missing.ts\n' },
  });

  await assert.rejects(
    loadVaultContext(fakeFetch(files), repository, [{ filename: 'docs/knowledge/learnings/example.md', status: 'modified' }], headSha, baseSha, 'token'),
    /GitHub API request failed \(404\)/,
  );
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
  await t.test('invalid catalog path', async () => {
    const files = baseVault({ 'docs/knowledge/context-map.json': { value: JSON.stringify({ version: 1, routes: [], catalogs: ['docs/outside.md'] }) } });
    await assert.rejects(loadVaultContext(fakeFetch(files), repository, [], headSha, baseSha, 'token'), /outside docs\/knowledge or is not Markdown/);
  });
  await t.test('undefined Markdown link reference', async () => {
    const files = baseVault({ 'docs/knowledge/README.md': { value: '# Index\n[Missing][source]\n' } });
    await assert.rejects(loadVaultContext(fakeFetch(files), repository, [], headSha, baseSha, 'token'), /undefined Markdown link reference/);
  });
  await t.test('conflicting Markdown link definitions', async () => {
    const files = baseVault({ 'docs/knowledge/README.md': { value: '# Index\n[Source][source]\n\n[source]: current-state.md\n[source]: other.md\n' } });
    await assert.rejects(loadVaultContext(fakeFetch(files), repository, [], headSha, baseSha, 'token'), /conflicting Markdown link definitions/);
  });
});

test('loads catalog metadata without hydrating its outbound evidence links', async () => {
  const files = baseVault({
    'docs/knowledge/context-map.json': {
      value: JSON.stringify({ version: 1, routes: [], catalogs: ['docs/knowledge/evidence/catalog.md'] }),
    },
    'docs/knowledge/README.md': { value: '# Index\n[Catalog](evidence/catalog.md)\n' },
    'docs/knowledge/evidence/catalog.md': {
      value: '# Catalog\n[Missing](../../../apps/api/src/missing.ts)\n[Review](https://github.com/owner/repo/pull/44#pullrequestreview-123)\n',
    },
  });
  const requests = [];

  const result = await loadVaultContext(
    fakeFetch(files, {}, requests),
    repository,
    [{ filename: 'docs/knowledge/evidence/catalog.md', status: 'modified' }],
    headSha,
    baseSha,
    'token',
  );

  assert.deepEqual(result.map(({ path }) => path), [
    'docs/knowledge/README.md',
    'docs/knowledge/current-state.md',
    'docs/knowledge/context-map.json',
    'docs/knowledge/evidence/catalog.md',
  ]);
  assert.equal(requests.some(({ pathname }) => pathname.includes('missing.ts') || pathname.includes('/pulls/44/reviews/123')), false);
});

test('fails closed before fetching evidence when the item limit would be exceeded', async () => {
  const links = Array.from({ length: 160 }, (_, index) => `[Review ${index}](https://github.com/owner/repo/pull/44#pullrequestreview-${index + 1})`).join('\n');
  const files = baseVault({ 'docs/knowledge/large.md': { value: links } });
  const requests = [];

  await assert.rejects(loadVaultContext(fakeFetch(files, {}, requests), repository, [{ filename: 'docs/knowledge/large.md', status: 'added' }], headSha, baseSha, 'token'), /item limit/);
  assert.equal(requests.some(({ pathname }) => pathname.includes('/pulls/44/reviews/')), false);
});

test('counts routed and linked vault documents only once when enforcing the item limit', async () => {
  const documents = Array.from({ length: 157 }, (_, index) => `docs/knowledge/generated/note-${index}.md`);
  const files = baseVault({
    'docs/knowledge/README.md': { value: `# Index\n${documents.map((path, index) => `[Note ${index}](${path.replace('docs/knowledge/', '')})`).join('\n')}\n` },
    'docs/knowledge/context-map.json': { value: JSON.stringify({ version: 1, routes: [{ paths: ['apps/api/src/**'], documents }] }) },
    ...Object.fromEntries(documents.map((path, index) => [path, { value: `# Note ${index}\n` }])),
  });
  const requests = [];

  const result = await loadVaultContext(fakeFetch(files, {}, requests), repository, [{ filename: 'apps/api/src/route.ts', status: 'modified' }], headSha, baseSha, 'token');

  assert.equal(result.length, 160);
  assert.equal(new Set(result.map(({ revision, path }) => `${revision}:${path}`)).size, 160);
  for (const document of documents) {
    assert.equal(requests.filter(({ pathname }) => pathname.endsWith(document)).length, 1);
  }
});

test('treats a missing vault index as an optional empty context', async () => {
  assert.deepEqual(await loadVaultContext(fakeFetch(), repository, [], headSha, baseSha, 'token'), []);
});

test('fails closed when the vault index exists without the required current state', async () => {
  const files = { 'docs/knowledge/README.md': { value: '# Index\n' } };
  await assert.rejects(loadVaultContext(fakeFetch(files), repository, [], headSha, baseSha, 'token'), /current state is unavailable/);
});
