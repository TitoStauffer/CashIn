import assert from 'node:assert/strict';
import test from 'node:test';
import { formatReadinessSummary, mapReadinessToCommitStatus, MERGE_READINESS_CONTEXT, publishCommitStatus, workflowExecutionExitCode } from '../dist/workflow-status.js';

function result(status, overrides = {}) {
  return {
    status,
    pullRequest: { number: 7, title: 'Safe title', baseBranch: 'master', headSha: 'a'.repeat(40) },
    evaluatedAt: '2026-10-21T12:00:00.000Z',
    evidence: { requiredCheckResults: [{ name: 'API', state: 'SUCCESS' }] },
    reasons: [],
    limitations: [],
    ...overrides,
  };
}

test('maps gate outcomes to non-ambiguous commit status states', () => {
  assert.equal(mapReadinessToCommitStatus(result('READY_TO_MERGE')).state, 'success');
  assert.equal(mapReadinessToCommitStatus(result('BLOCKED', { reasons: ['CI failed'] })).state, 'failure');
  assert.equal(mapReadinessToCommitStatus(result('INCONCLUSIVE', { limitations: ['HTTP 403'] })).state, 'error');
});

test('keeps readiness in the commit status while failing the workflow only when publication fails', () => {
  assert.equal(workflowExecutionExitCode(true), 0);
  assert.equal(workflowExecutionExitCode(false), 2);
});

test('truncates status descriptions to the GitHub limit', () => {
  const mapped = mapReadinessToCommitStatus(result('BLOCKED', { reasons: ['x'.repeat(300)] }));
  assert.ok(mapped.description.length <= 140);
});

test('publishes status to the evaluated SHA with a stable context', async () => {
  let captured;
  await publishCommitStatus({
    owner: 'owner',
    repository: 'repo',
    headSha: 'a'.repeat(40),
    token: 'token',
    targetUrl: 'https://github.com/owner/repo/actions/runs/1',
    result: result('READY_TO_MERGE'),
    fetchImpl: async (url, options) => {
      captured = { url, options, body: JSON.parse(options.body) };
      return new Response('{}', { status: 201 });
    },
  });
  assert.equal(captured.url, `https://api.github.com/repos/owner/repo/statuses/${'a'.repeat(40)}`);
  assert.equal(captured.body.context, MERGE_READINESS_CONTEXT);
  assert.equal(captured.body.state, 'success');
  assert.equal(captured.body.target_url, 'https://github.com/owner/repo/actions/runs/1');
  assert.equal(captured.options.headers.Authorization, 'Bearer token');
});

test('does not disclose the response body when status publication fails', async () => {
  await assert.rejects(
    publishCommitStatus({
      owner: 'owner',
      repository: 'repo',
      headSha: 'a'.repeat(40),
      token: 'token',
      targetUrl: 'https://github.com/owner/repo/actions/runs/1',
      result: result('BLOCKED'),
      fetchImpl: async () => new Response('{"message":"secret response"}', { status: 403 }),
    }),
    (error) => error.message.includes('HTTP 403') && !error.message.includes('secret response'),
  );
});

test('escapes untrusted pull request titles and reasons in the job summary', () => {
  const summary = formatReadinessSummary(result('BLOCKED', {
    pullRequest: { number: 7, title: '```\n## injected', baseBranch: 'master', headSha: 'a'.repeat(40) },
    reasons: ['unsafe `reason`'],
  }));
  assert.doesNotMatch(summary, /```\s*## injected/);
  assert.match(summary, /unsafe \\`reason\\`/);
});
