import assert from 'node:assert/strict';
import test from 'node:test';
import { recoverCiAfterMetadataEdit } from '../dist/ci-recovery.js';

const repository = 'owner/repo';
const pullRequestNumber = 43;
const headSha = 'a'.repeat(40);

function response(body, status = 200) {
  return new Response(body === undefined ? undefined : JSON.stringify(body), { status });
}

// The default shape is the one GitHub actually returns for these runs: `pull_requests` **empty**.
// Every test here used to build the run with the array populated, which is why the DEV-110 defect — a
// filter that required the association — passed five tests while failing in production every single
// time a Pull Request body was edited. The populated shape is still exercised, explicitly, below.
function run(status, conclusion = null, pullRequests = []) {
  return { id: 99, status, conclusion, created_at: '2026-10-25T10:00:00Z', pull_requests: pullRequests };
}

function associatedRun(status, conclusion = null) {
  return run(status, conclusion, [{ number: pullRequestNumber }]);
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
    return init.method === 'POST' ? response(undefined, 201) : response({ workflow_runs: [associatedRun('completed', 'success')] });
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
    return response({ workflow_runs: [reads === 1 ? associatedRun('in_progress') : associatedRun('completed', 'failure')] });
  }));

  assert.deepEqual(result, { action: 'rerun_requested', runId: 99 });
  assert.equal(writes, 1);
});

// The defect this ticket exists for: GitHub returns these runs with `pull_requests` empty, and an
// empty array carries no information — it cannot mean "belongs to another Pull Request". Requiring the
// association made the job fail on every substantive metadata edit. Verified against the real API for
// three different heads.
test('accepts the CI run at this head when GitHub leaves it unassociated', async () => {
  const requests = [];
  const result = await recoverCiAfterMetadataEdit(options(async (url, init = {}) => {
    requests.push(url);
    return init.method === 'POST' ? response(undefined, 201) : response({ workflow_runs: [run('completed', 'success')] });
  }));

  assert.deepEqual(result, { action: 'rerun_requested', runId: 99 });
  assert.equal(requests.at(-1).endsWith('/actions/runs/99/rerun'), true);
  // The query is what identifies the run, so it has to keep pinning workflow, event and head.
  assert.match(requests[0], /\/actions\/workflows\/ci\.yml\/runs\?/);
  assert.match(requests[0], /event=pull_request/);
  assert.match(requests[0], new RegExp(`head_sha=${headSha}`));
});

// The other half: when GitHub does populate the array, it means something, and a run belonging to a
// different Pull Request must still be refused. Dropping the check entirely would pass the test above
// and lose this one.
test('still refuses a run that GitHub associates with another pull request', async () => {
  await assert.rejects(
    recoverCiAfterMetadataEdit(options(
      async () => response({ workflow_runs: [run('completed', 'success', [{ number: pullRequestNumber + 1 }])] }),
      { maxAttempts: 2 },
    )),
    /No CI run exists for the current Pull Request head\./,
  );
});

test('distinguishes a head with no CI run from one whose run never finished', async () => {
  await assert.rejects(
    recoverCiAfterMetadataEdit(options(async () => response({ workflow_runs: [] }), { maxAttempts: 2 })),
    /No CI run exists for the current Pull Request head\./,
  );

  await assert.rejects(
    recoverCiAfterMetadataEdit(options(async () => response({ workflow_runs: [run('in_progress')] }), { maxAttempts: 2 })),
    /never completed within the wait window\./,
  );
});

test('waits for an active successful CI that GitHub leaves unassociated', async () => {
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

test('reports only the GitHub status code when the API rejects recovery', async () => {
  await assert.rejects(
    recoverCiAfterMetadataEdit(options(async () => new Response('secret response body', { status: 403 }))),
    (error) => error.message === 'GitHub API HTTP 403 while reading CI runs.' && !error.message.includes('secret'),
  );
});
