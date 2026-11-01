import assert from 'node:assert/strict';
import test from 'node:test';
import { agentReportMarker } from '../dist/agent-evidence.js';
import { planReadinessEvaluation } from '../dist/readiness-preflight.js';
import { mapReadinessToCommitStatus } from '../dist/workflow-status.js';

const sha = 'a'.repeat(40);
const ctx = 'b'.repeat(64);
const bot = 'cashin-devagents[bot]';
function report({ commitSha = sha, contextHash = ctx, login = bot, decision = 'APPROVED' } = {}) {
  return {
    user: { login },
    body: `${agentReportMarker('qualityGate', commitSha, contextHash)}\n### Codex — Quality Gate Coordinator\n\n**Status:** ${decision}\n**Commit:** \`${commitSha}\`\n\n### Checks verificados\nRelatório para avaliação completa.`,
  };
}
function options(overrides = {}) {
  return {
    eventName: 'pull_request_target', payload: { action: 'opened' },
    owner: 'test-owner', repository: 'test-repo', pullRequestNumber: 7,
    headSha: sha, botLogin: bot, token: 'test-token',
    fetchImpl: async (url, init) => {
      assert.equal(new URL(url).pathname, '/repos/test-owner/test-repo/issues/7/comments');
      assert.equal(init.method, 'GET');
      return Response.json([]);
    },
    ...overrides,
  };
}

test('initial events without a coordinator report invalidate instead of fully evaluating', async () => {
  for (const eventName of ['pull_request_target', 'workflow_run', 'issue_comment']) {
    const result = await planReadinessEvaluation(options({ eventName }));
    assert.equal(result.mode, 'invalidate');
    assert.match(result.reason, /Aguardando/);
    assert.equal(mapReadinessToCommitStatus({ status: 'INCONCLUSIVE', reasons: [], limitations: [result.reason] }).state, 'error');
  }
});

test('manual recovery always uses the full evaluator without a preflight API request', async () => {
  const result = await planReadinessEvaluation(options({
    eventName: 'workflow_dispatch', fetchImpl: async () => { assert.fail('unneeded preflight request'); },
  }));
  assert.equal(result.mode, 'evaluate');
});

test('current coordinator publication goes directly to the full evaluator', async () => {
  const result = await planReadinessEvaluation(options({
    eventName: 'issue_comment', payload: { comment: report() },
    fetchImpl: async () => { assert.fail('unneeded preflight request'); },
  }));
  assert.equal(result.mode, 'evaluate');
});

test('delayed CI, review and metadata events re-evaluate existing final evidence', async () => {
  for (const [eventName, payload] of [
    ['workflow_run', { workflow_run: { name: 'CI', conclusion: 'success' } }],
    ['workflow_run', { workflow_run: { name: 'CI', conclusion: 'failure' } }],
    ['workflow_run', { workflow_run: { name: 'PR Review Signal' } }],
    ['pull_request_target', { action: 'edited' }],
    ['issue_comment', { comment: { body: '### Codex — QA Agent' } }],
  ]) {
    const result = await planReadinessEvaluation(options({ eventName, payload, fetchImpl: async () => Response.json([report()]) }));
    assert.equal(result.mode, 'evaluate');
  }
});

test('a rejected or stale-context candidate is never trusted as approval and is fully evaluated', async () => {
  for (const decision of ['APPROVED', 'CHANGES_REQUESTED', 'INCONCLUSIVE']) {
    const result = await planReadinessEvaluation(options({
      fetchImpl: async () => Response.json([report({ decision, contextHash: 'c'.repeat(64) })]),
    }));
    assert.deepEqual(result, { mode: 'evaluate', reason: 'Avaliação completa das evidências e proteções necessária.' });
    assert.equal('status' in result, false);
  }
});

test('an old HEAD, unrelated author or malformed report cannot stand in for coordinator evidence', async () => {
  for (const candidate of [
    report({ commitSha: 'c'.repeat(40) }), report({ login: 'some-user' }),
    { user: { login: bot }, body: '### Codex — Quality Gate Coordinator\nAPPROVED' },
    null,
  ]) {
    const result = await planReadinessEvaluation(options({
      eventName: 'issue_comment', payload: { comment: candidate },
      fetchImpl: async () => Response.json([candidate]),
    }));
    assert.equal(result.mode, 'invalidate');
  }
});

test('paginated comments preserve final evidence even beyond the first page', async () => {
  let requests = 0;
  const result = await planReadinessEvaluation(options({ fetchImpl: async (url) => {
    requests++;
    return Response.json(new URL(url).searchParams.get('page') === '1'
      ? Array.from({ length: 100 }, () => ({ body: 'unrelated comment' })) : [report()]);
  } }));
  assert.equal(result.mode, 'evaluate');
  assert.equal(requests, 2);
});

test('API permission failures and malformed pages invalidate without pretending evidence is absent', async () => {
  for (const response of [new Response('', { status: 403 }), Response.json({ unexpected: true })]) {
    const result = await planReadinessEvaluation(options({ fetchImpl: async () => response }));
    assert.equal(result.mode, 'invalidate');
    assert.match(result.reason, /Não foi possível consultar/);
  }
});

test('missing identity, token or full SHA fail closed without querying GitHub', async () => {
  for (const missing of [{ botLogin: '' }, { token: '' }, { headSha: 'abcdef' }]) {
    const result = await planReadinessEvaluation(options({
      ...missing, fetchImpl: async () => { assert.fail('invalid preflight request'); },
    }));
    assert.equal(result.mode, 'invalidate');
  }
});
