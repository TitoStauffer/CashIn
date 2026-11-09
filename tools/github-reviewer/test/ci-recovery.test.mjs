import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_DELAY_MS, DEFAULT_MAX_ATTEMPTS, recoverCiAfterMetadataEdit } from '../dist/ci-recovery.js';

const repository = 'owner/repo';
const pullRequestNumber = 43;
const headSha = 'a'.repeat(40);

function response(body, status = 200) {
  return new Response(body === undefined ? undefined : JSON.stringify(body), { status });
}

// Two shapes, both real, and the default is the one that is **not** covered elsewhere: `pull_requests`
// empty, which is what GitHub returns once the Pull Request has closed. While it is open the array is
// populated — measured on PR #95, length 1 — and that shape is exercised through `associatedRun`
// below. Neither shape was the DEV-110 defect; the defect was the wait window, and the empty shape is
// accepted as defence in depth. See the JSDoc of `belongsToPullRequest` for the measurement.
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

// The populated association on the wait-then-succeed path: with the empty shape now the default
// fixture, this is the case that keeps the association branch covered end to end. Its twin below
// exercises the same path with the shape GitHub actually returns.
test('waits for an active successful CI and does not duplicate it', async () => {
  let reads = 0;
  let writes = 0;
  const result = await recoverCiAfterMetadataEdit(options(async (_url, init = {}) => {
    if (init.method === 'POST') { writes += 1; return response(undefined, 201); }
    reads += 1;
    return response({ workflow_runs: [reads === 1 ? associatedRun('in_progress') : associatedRun('completed', 'success')] });
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

// Defence in depth, not the fix: an empty array carries no information, so it cannot be read as
// "belongs to another Pull Request" — and that is the state after the Pull Request closes, which is
// when a late recovery run would read it. The DEV-110 defect was the wait window; this case exists so
// the lenient half of the identity stays covered, with `still refuses a run that GitHub associates
// with another pull request` covering the strict half.
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
    /associates it with another Pull Request\./,
  );
});

// Each message has to name the condition that produced it. Deriving the cause from "we observed
// nothing" made a refused association report that no run exists for the head, which is not why.
test('names the condition behind each failure instead of inferring one', async () => {
  await assert.rejects(
    recoverCiAfterMetadataEdit(options(async () => response({ workflow_runs: [] }), { maxAttempts: 2 })),
    /No CI run exists for the current Pull Request head\./,
  );

  await assert.rejects(
    recoverCiAfterMetadataEdit(options(async () => response({ workflow_runs: [run('in_progress')] }), { maxAttempts: 2 })),
    /never completed within the wait window\./,
  );

  await assert.rejects(
    recoverCiAfterMetadataEdit(options(
      async () => response({ workflow_runs: [run('completed', 'success', [{ number: pullRequestNumber + 7 }])] }),
      { maxAttempts: 2 },
    )),
    /A CI run exists for this head but GitHub associates it with another Pull Request\./,
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

// The window is the DEV-110 fix, and every other test passes `maxAttempts` explicitly — so without
// this case the defaults could go back to the 2 minutes that caused the defect and the suite would
// stay green. Exercises the real defaults, counting the waits instead of serving them.
test('waits a window that covers a complete CI run, by default', async () => {
  const waits = [];
  let reads = 0;
  await assert.rejects(
    recoverCiAfterMetadataEdit({
      fetchImpl: async () => { reads += 1; return response({ workflow_runs: [run('in_progress')] }); },
      repository,
      pullRequestNumber,
      headSha,
      token: 'secret-token',
      sleep: async (delay) => { waits.push(delay); },
    }),
    /never completed within the wait window\./,
  );

  assert.deepEqual([DEFAULT_MAX_ATTEMPTS, DEFAULT_DELAY_MS], [60, 10_000]);
  assert.equal(reads, DEFAULT_MAX_ATTEMPTS);
  assert.equal(waits.length, DEFAULT_MAX_ATTEMPTS - 1);
  assert.ok(waits.every((delay) => delay === DEFAULT_DELAY_MS));
  // Ten minutes: about double the slowest CI run measured on this repository (4m52s).
  assert.equal((DEFAULT_MAX_ATTEMPTS - 1) * DEFAULT_DELAY_MS, 590_000);
});

// Each message names the condition that produced it, so the refusal flag has to describe the latest
// observation. Accumulating it blamed the association after the run had simply disappeared.
test('reports the condition it last observed, not the first one it saw', async () => {
  let reads = 0;
  await assert.rejects(
    recoverCiAfterMetadataEdit(options(async () => {
      reads += 1;
      return reads === 1
        ? response({ workflow_runs: [run('completed', 'success', [{ number: pullRequestNumber + 1 }])] })
        : response({ workflow_runs: [] });
    }, { maxAttempts: 3 })),
    /No CI run exists for the current Pull Request head\./,
  );
});

// The declared precedence, which is not simply "the last read": a run seen running outweighs later
// reads that saw nothing, because "it existed and did not finish" is the more actionable report and a
// run vanishing from the listing is more likely a lag than a run that never existed.
test('keeps the running-run report when the listing later goes empty', async () => {
  let reads = 0;
  await assert.rejects(
    recoverCiAfterMetadataEdit(options(async () => {
      reads += 1;
      return reads === 1 ? response({ workflow_runs: [run('in_progress')] }) : response({ workflow_runs: [] });
    }, { maxAttempts: 3 })),
    /never completed within the wait window\./,
  );
});

test('reports only the GitHub status code when the API rejects recovery', async () => {
  await assert.rejects(
    recoverCiAfterMetadataEdit(options(async () => new Response('secret response body', { status: 403 }))),
    (error) => error.message === 'GitHub API HTTP 403 while reading CI runs.' && !error.message.includes('secret'),
  );
});
