import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveWorkflowEvent } from '../dist/workflow-event.js';

const sha = 'a'.repeat(40);
const repo = 'TitoStauffer/CashIn';

function response(payload, status = 200) {
  return new Response(JSON.stringify(payload), { status });
}

function pullRequest(overrides = {}) {
  return {
    number: 7,
    state: 'open',
    head: { sha },
    base: { ref: 'master' },
    ...overrides,
  };
}

function baseOptions(overrides = {}) {
  return {
    eventName: 'pull_request_target',
    payload: { action: 'opened', pull_request: { number: 7, head: { sha } } },
    repository: repo,
    botLogin: 'cashin-devagents[bot]',
    token: 'test-token',
    fetchImpl: async (url) => {
      assert.equal(new URL(url).pathname, '/repos/TitoStauffer/CashIn/pulls/7');
      return response(pullRequest());
    },
    ...overrides,
  };
}

test('resolves an opened pull_request_target for master', async () => {
  const result = await resolveWorkflowEvent(baseOptions());
  assert.deepEqual(result, {
    action: 'evaluate',
    pullRequestNumber: 7,
    headSha: sha,
    reason: 'Pull Request aberto e destinado a master.',
  });
});

test('skips a pull request targeting another branch', async () => {
  const result = await resolveWorkflowEvent(baseOptions({ fetchImpl: async () => response(pullRequest({ base: { ref: 'develop' } })) }));
  assert.equal(result.action, 'skip');
  assert.match(result.reason, /master/);
});

test('skips comments by users other than the configured GitHub App', async () => {
  const result = await resolveWorkflowEvent(baseOptions({
    eventName: 'issue_comment',
    payload: { action: 'created', issue: { number: 7, pull_request: {} }, comment: { user: { login: 'human' }, body: '### Codex — QA Agent' } },
    fetchImpl: async () => { throw new Error('must not request GitHub'); },
  }));
  assert.equal(result.action, 'skip');
  assert.match(result.reason, /GitHub App/);
});

test('accepts a structured report comment from the configured GitHub App', async () => {
  const result = await resolveWorkflowEvent(baseOptions({
    eventName: 'issue_comment',
    payload: { action: 'created', issue: { number: 7, pull_request: {} }, comment: { user: { login: 'cashin-devagents[bot]' }, body: '### Codex — QA Agent\n**Status:** APPROVED' } },
  }));
  assert.equal(result.action, 'evaluate');
  assert.equal(result.pullRequestNumber, 7);
});

test('ignores comments that do not contain a recognized report signature', async () => {
  const result = await resolveWorkflowEvent(baseOptions({
    eventName: 'issue_comment',
    payload: { action: 'created', issue: { number: 7, pull_request: {} }, comment: { user: { login: 'cashin-devagents[bot]' }, body: 'Deploy approved.' } },
    fetchImpl: async () => { throw new Error('must not request GitHub'); },
  }));
  assert.equal(result.action, 'skip');
});

test('resolves the open PR associated with a completed CI run from the event payload', async () => {
  const result = await resolveWorkflowEvent(baseOptions({
    eventName: 'workflow_run',
    payload: { workflow: { name: 'CI' }, workflow_run: { event: 'pull_request', head_sha: sha, pull_requests: [{ number: 7 }], conclusion: 'failure' } },
    fetchImpl: async (url) => {
      const path = new URL(url).pathname;
      if (path === '/repos/TitoStauffer/CashIn/pulls/7') return response(pullRequest());
      throw new Error(`unexpected request ${path}`);
    },
  }));
  assert.equal(result.action, 'evaluate');
  assert.equal(result.pullRequestNumber, 7);
  assert.equal(result.headSha, sha);
});

test('skips CI runs that were not produced by a pull_request event', async () => {
  const result = await resolveWorkflowEvent(baseOptions({
    eventName: 'workflow_run',
    payload: { workflow: { name: 'CI' }, workflow_run: { event: 'push', head_sha: sha, pull_requests: [] } },
    fetchImpl: async () => { throw new Error('must not request GitHub'); },
  }));
  assert.equal(result.action, 'skip');
});

test('resolves the PR after a trusted review signal workflow completes', async () => {
  const result = await resolveWorkflowEvent(baseOptions({
    eventName: 'workflow_run',
    payload: { workflow: { name: 'PR Review Signal' }, workflow_run: { event: 'pull_request_review', head_sha: 'b'.repeat(40), pull_requests: [{ number: 7 }] } },
  }));
  assert.equal(result.action, 'evaluate');
  assert.equal(result.pullRequestNumber, 7);
  assert.equal(result.headSha, sha);
});

test('returns inconclusive when a workflow run has ambiguous PR associations', async () => {
  const result = await resolveWorkflowEvent(baseOptions({
    eventName: 'workflow_run',
    payload: { workflow: { name: 'CI' }, workflow_run: { event: 'pull_request', head_sha: sha, pull_requests: [{ number: 7 }, { number: 8 }] } },
    fetchImpl: async () => { throw new Error('must not request GitHub'); },
  }));
  assert.equal(result.action, 'inconclusive');
  assert.match(result.reason, /exatamente um Pull Request/);
});

test('returns INCONCLUSIVE on GitHub API permission failures and preserves a known SHA', async () => {
  const result = await resolveWorkflowEvent(baseOptions({ fetchImpl: async () => response({}, 403) }));
  assert.equal(result.action, 'inconclusive');
  assert.equal(result.pullRequestNumber, 7);
  assert.equal(result.headSha, sha);
  assert.match(result.reason, /HTTP 403/);
});

test('returns INCONCLUSIVE when no GitHub Actions token is available', async () => {
  const result = await resolveWorkflowEvent(baseOptions({ token: '', fetchImpl: async () => { throw new Error('must not request GitHub'); } }));
  assert.equal(result.action, 'inconclusive');
  assert.equal(result.pullRequestNumber, 7);
  assert.equal(result.headSha, sha);
  assert.match(result.reason, /API do GitHub/);
});

test('skips a closed pull request', async () => {
  const result = await resolveWorkflowEvent(baseOptions({ fetchImpl: async () => response(pullRequest({ state: 'closed' })) }));
  assert.equal(result.action, 'skip');
  assert.match(result.reason, /não está aberto/);
});

test('resolves a manually requested pull request number', async () => {
  const result = await resolveWorkflowEvent(baseOptions({
    eventName: 'workflow_dispatch',
    payload: { inputs: { pr_number: '7' } },
  }));
  assert.equal(result.action, 'evaluate');
  assert.equal(result.pullRequestNumber, 7);
});
