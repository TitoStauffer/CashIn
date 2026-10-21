import assert from 'node:assert/strict';
import test from 'node:test';
import { requestGitHubApi, requestGitHubText } from '../dist/github-api-client.js';

function response(payload, status = 200, headers = {}) {
  return new Response(JSON.stringify(payload), { status, headers });
}

test('retries transient reads with a bounded number of attempts', async () => {
  let calls = 0;
  const result = await requestGitHubApi(async () => {
    calls += 1;
    return calls < 3 ? response({}, 503) : response({ ok: true });
  }, '/repos/TitoStauffer/CashIn', 'test-token');

  assert.deepEqual(result, { ok: true });
  assert.equal(calls, 3);
});

test('does not automatically repeat POST writes after ambiguous API failures', async () => {
  let calls = 0;
  await assert.rejects(requestGitHubApi(async () => {
    calls += 1;
    return response({}, 503);
  }, '/repos/TitoStauffer/CashIn/pulls/26/reviews', 'test-token', { method: 'POST', body: '{}' }), /503/);
  assert.equal(calls, 1);
});

test('retries a transient network error for an idempotent read without logging credentials', async () => {
  let calls = 0;
  const result = await requestGitHubApi(async () => {
    calls += 1;
    if (calls === 1) throw new Error('temporary network issue');
    return response({ ok: true });
  }, '/repos/TitoStauffer/CashIn', 'sensitive-test-token');
  assert.deepEqual(result, { ok: true });
  assert.equal(calls, 2);
});

test('retries the pull request diff read and preserves its media type', async () => {
  let calls = 0;
  const diff = await requestGitHubText(async (_url, options) => {
    calls += 1;
    assert.equal(options.headers.Accept, 'application/vnd.github.v3.diff');
    return calls === 1 ? new Response('', { status: 502 }) : new Response('diff contents');
  }, '/repos/TitoStauffer/CashIn/pulls/26', 'test-token', 'application/vnd.github.v3.diff');

  assert.equal(diff, 'diff contents');
  assert.equal(calls, 2);
});
