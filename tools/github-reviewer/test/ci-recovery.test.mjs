import assert from 'node:assert/strict';
import test from 'node:test';
import { recoverCiAfterMetadataEdit } from '../dist/ci-recovery.js';

const repository = 'owner/repo';
const pullRequestNumber = 43;
const headSha = 'a'.repeat(40);

function response(body, status = 200) {
  return new Response(body === undefined ? undefined : JSON.stringify(body), { status });
}

function run(status, conclusion = null) {
  return { id: 99, status, conclusion, created_at: '2026-10-25T10:00:00Z', pull_requests: [{ number: pullRequestNumber }] };
}

function options(fetchImpl, overrides = {}) {
  return {
    fetchImpl, repository, pullRequestNumber, headSha, token: 'secret-token',
    maxAttempts: 4, delayMs: 0, sleep: async () => {}, ...overrides,
  };
}

test('reruns a CI that had already completed before the metadata edit', async () => {
  const requests = [];
  const result = await recoverCiAfterMetadataEdit(options(async (url, init = {}) => {
    requests.push({ url, init });
    return init.method === 'POST' ? response(undefined, 201) : response({ workflow_runs: [run('completed', 'success')] });
  }));

  assert.deepEqual(result, { action: 'rerun_requested', runId: 99 });
  assert.equal(requests.at(-1).url.endsWith('/actions/runs/99/rerun'), true);
});

test('waits for an active successful CI and does not duplicate it', async () => {
  let reads = 0;
  let writes = 0;
  const result = await recoverCiAfterMetadataEdit(options(async (_url, init = {}) => {
    if (init.method === 'POST') { writes += 1; return response(undefined, 201); }
    reads += 1;
    return response({ workflow_runs: [reads === 1 ? run('in_progress') : run('completed', 'success')] });
  }));

  assert.deepEqual(result, { action: 'active_run_succeeded', runId: 99 });
  assert.equal(writes, 0);
});

test('reruns an active CI after it completes with failure', async () => {
  let reads = 0;
  let writes = 0;
  const result = await recoverCiAfterMetadataEdit(options(async (_url, init = {}) => {
    if (init.method === 'POST') { writes += 1; return response(undefined, 201); }
    reads += 1;
    return response({ workflow_runs: [reads === 1 ? run('in_progress') : run('completed', 'failure')] });
  }));

  assert.deepEqual(result, { action: 'rerun_requested', runId: 99 });
  assert.equal(writes, 1);
});

test('times out when the matching CI run never becomes available', async () => {
  await assert.rejects(
    recoverCiAfterMetadataEdit(options(async () => response({ workflow_runs: [] }), { maxAttempts: 2 })),
    /Timed out/,
  );
});

test('reports only the GitHub status code when the API rejects recovery', async () => {
  await assert.rejects(
    recoverCiAfterMetadataEdit(options(async () => new Response('secret response body', { status: 403 }))),
    (error) => error.message === 'GitHub API HTTP 403 while reading CI runs.' && !error.message.includes('secret'),
  );
});
