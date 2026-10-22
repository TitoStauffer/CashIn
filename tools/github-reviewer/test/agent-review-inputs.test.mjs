import assert from 'node:assert/strict';
import test from 'node:test';
import { loadAgentReviewInputs } from '../dist/agent-review-inputs.js';

const headSha = 'a'.repeat(40);
const baseSha = 'b'.repeat(40);

function encoded(content) {
  return Buffer.from(content, 'utf8').toString('base64');
}

function createFetch({ files = [{ filename: 'src/example.ts', status: 'modified' }], source = 'export const value = 42;\n' } = {}) {
  return async (url, options = {}) => {
    const parsed = new URL(url);
    const path = parsed.pathname;
    let payload;
    let text = false;
    if (path.endsWith('/pulls/7') && options.headers?.Accept === 'application/vnd.github.v3.diff') {
      payload = 'diff --git a/src/example.ts b/src/example.ts\n';
      text = true;
    } else if (path.endsWith(`/commits/${headSha}/check-runs`)) {
      payload = { check_runs: [
        { name: 'API', status: 'completed', conclusion: 'success' },
        { name: 'Web', status: 'completed', conclusion: 'success' },
        { name: 'SonarQube', status: 'completed', conclusion: 'success' },
        { name: 'SonarCloud Code Analysis', status: 'completed', conclusion: 'success' },
      ] };
    } else if (path.endsWith('/contents/AGENTS.md')) {
      payload = { encoding: 'base64', content: encoded('Project rules') };
    } else if (path.endsWith('/pulls/7/files')) {
      payload = files;
    } else if (path.endsWith('/contents/src/example.ts')) {
      payload = { encoding: 'base64', content: encoded(source) };
    } else {
      return new Response('{}', { status: 404 });
    }
    return new Response(text ? payload : JSON.stringify(payload), { status: 200 });
  };
}

test('loads complete changed source snapshots at the PR HEAD alongside diff and checks', async () => {
  const inputs = await loadAgentReviewInputs(createFetch(), 'owner/repo', 7, {
    head: { sha: headSha },
    base: { sha: baseSha },
  }, 'token');

  assert.equal(inputs.diff.startsWith('diff --git'), true);
  assert.equal(inputs.checks.api, 'PASSED');
  assert.equal(inputs.repositoryInstructions, 'Project rules');
  assert.deepEqual(inputs.sourceFiles, [{ path: 'src/example.ts', revision: 'head', content: 'export const value = 42;\n' }]);
});

test('fails closed when changed source context exceeds the supported file limit', async () => {
  const files = Array.from({ length: 21 }, (_, index) => ({ filename: `src/file-${index}.ts`, status: 'modified' }));
  await assert.rejects(
    loadAgentReviewInputs(createFetch({ files }), 'owner/repo', 7, { head: { sha: headSha }, base: { sha: baseSha } }, 'token'),
    /too many files/,
  );
});
