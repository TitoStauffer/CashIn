import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import test from 'node:test';
import { createAppJwt, submitReview, validateReview, verifyAccess } from '../src/github-app.mjs';

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });

test('creates a short-lived RS256 app JWT', () => {
  const jwt = createAppJwt('12345', pem, 1_800_000_000);
  const [header, payload, signature] = jwt.split('.');
  assert.equal(JSON.parse(Buffer.from(header, 'base64url')).alg, 'RS256');
  assert.deepEqual(JSON.parse(Buffer.from(payload, 'base64url')), {
    iat: 1_799_999_940,
    exp: 1_800_000_540,
    iss: '12345',
  });
  assert.ok(signature.length > 0);
});

test('rejects decisions that do not match the formal review body', () => {
  assert.throws(() => validateReview('APPROVED', 'Code Review — CHANGES_REQUESTED'), /same decision/);
  assert.throws(() => validateReview('INCONCLUSIVE', 'Code Review — INCONCLUSIVE'), /must be APPROVED/);
  assert.throws(() => validateReview('APPROVED', '  '), /must not be empty/);
});

test('submits an approval for the pull request head as the GitHub App', async () => {
  const calls = [];
  const responses = [
    { slug: 'cashin-code-reviewer' },
    { token: 'installation-token' },
    { state: 'open', user: { login: 'TitoStauffer' }, head: { sha: 'head-sha' } },
    { id: 987, state: 'APPROVED', html_url: 'https://github.com/TitoStauffer/CashIn/pull/11#pullrequestreview-987', commit_id: 'head-sha', user: { login: 'cashin-code-reviewer[bot]' } },
  ];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return new Response(JSON.stringify(responses.shift()), { status: 200 });
  };

  const result = await submitReview({
    appId: '12345',
    installationId: '67890',
    privateKey: pem,
    pullRequestNumber: 11,
    decision: 'APPROVED',
    body: '### Code Review — APPROVED\nNo blockers identified.',
    fetchImpl,
  });

  assert.equal(calls.length, 4);
  assert.equal(calls[3].url, 'https://api.github.com/repos/TitoStauffer/CashIn/pulls/11/reviews');
  assert.deepEqual(JSON.parse(calls[3].options.body), {
    body: '### Code Review — APPROVED\nNo blockers identified.',
    commit_id: 'head-sha',
    event: 'APPROVE',
  });
  assert.equal(result.state, 'APPROVED');
  assert.equal(result.reviewer, 'cashin-code-reviewer[bot]');
});

test('verifies app access without submitting a review', async () => {
  const calls = [];
  const responses = [
    { slug: 'cashin-code-reviewer' },
    { token: 'installation-token' },
    { state: 'open', user: { login: 'TitoStauffer' }, html_url: 'https://github.com/TitoStauffer/CashIn/pull/11', head: { sha: 'head-sha' } },
  ];
  const fetchImpl = async (url) => {
    calls.push(url);
    return new Response(JSON.stringify(responses.shift()), { status: 200 });
  };
  const result = await verifyAccess({ appId: '12345', installationId: '67890', privateKey: pem, pullRequestNumber: 11, fetchImpl });
  assert.equal(result.pullRequest.state, 'open');
  assert.equal(calls.length, 3);
  assert.ok(calls.every((url) => !url.endsWith('/reviews')));
});

test('does not submit a review when the pull request is closed', async () => {
  let submittedReview = false;
  const responses = [{ slug: 'cashin-code-reviewer' }, { token: 'installation-token' }, { state: 'closed' }];
  const fetchImpl = async (url) => {
    if (url.endsWith('/reviews')) submittedReview = true;
    return new Response(JSON.stringify(responses.shift()), { status: 200 });
  };
  await assert.rejects(submitReview({
    appId: '12345', installationId: '67890', privateKey: pem, pullRequestNumber: 11,
    decision: 'APPROVED', body: '### Code Review — APPROVED', fetchImpl,
  }), /not open/);
  assert.equal(submittedReview, false);
});

test('does not allow the app to approve its own pull request', async () => {
  let submittedReview = false;
  const responses = [
    { slug: 'cashin-code-reviewer' }, { token: 'installation-token' },
    { state: 'open', user: { login: 'cashin-code-reviewer[bot]' }, head: { sha: 'head-sha' } },
  ];
  const fetchImpl = async (url) => {
    if (url.endsWith('/reviews')) submittedReview = true;
    return new Response(JSON.stringify(responses.shift()), { status: 200 });
  };
  await assert.rejects(submitReview({
    appId: '12345', installationId: '67890', privateKey: pem, pullRequestNumber: 11,
    decision: 'APPROVED', body: '### Code Review — APPROVED', fetchImpl,
  }), /cannot approve a pull request authored by itself/);
  assert.equal(submittedReview, false);
});
