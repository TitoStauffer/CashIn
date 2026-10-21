import assert from 'node:assert/strict';
import test from 'node:test';
import { orchestratePullRequestQuality } from '../dist/agent-orchestrator.js';

const sha = 'a'.repeat(40);

function dependencies(overrides = {}) {
  const calls = [];
  const options = {
    readHeadSha: async () => sha,
    readPrerequisites: async () => ({ commitSha: sha, ci: 'PASSED', sonar: 'PASSED' }),
    claimExecution: async () => true,
    releaseExecution: async (_context, status) => calls.push(`release:${status}`),
    executeAgent: async (stage, context) => {
      calls.push(`execute:${stage}`);
      return { stage, decision: 'APPROVED', commitSha: context.commitSha, reportMarkdown: `Evidence for ${stage}` };
    },
    publishReport: async (report) => calls.push(`publish:${report.stage}`),
    submitFormalCodeReview: async () => { calls.push('formal-review'); return true; },
    ...overrides,
  };
  return { options, calls };
}

const input = { repository: 'TitoStauffer/CashIn', pullRequestNumber: 44, expectedHeadSha: sha, executionId: 'run-1' };

test('runs Code Review, formal approval, QA and Coordinator in order for one SHA', async () => {
  const { options, calls } = dependencies();
  const result = await orchestratePullRequestQuality(input, options);

  assert.equal(result.status, 'COMPLETED');
  assert.deepEqual(result.completedStages, ['codeReview', 'qa', 'qualityGate']);
  assert.deepEqual(calls.slice(0, 7), [
    'execute:codeReview', 'formal-review',
    'execute:qa', 'publish:qa', 'execute:qualityGate', 'publish:qualityGate', 'release:COMPLETED',
  ]);
});

test('does not start agents when CI or Sonar has failed', async () => {
  const { options, calls } = dependencies({ readPrerequisites: async () => ({ commitSha: sha, ci: 'FAILED', sonar: 'PASSED' }) });
  const result = await orchestratePullRequestQuality(input, options);

  assert.equal(result.status, 'BLOCKED');
  assert.equal(calls.some((call) => call.startsWith('execute:')), false);
});

test('fails closed when prerequisites are pending', async () => {
  const { options, calls } = dependencies({ readPrerequisites: async () => ({ commitSha: sha, ci: 'PENDING', sonar: 'PASSED' }) });
  const result = await orchestratePullRequestQuality(input, options);

  assert.equal(result.status, 'INCONCLUSIVE');
  assert.equal(calls.some((call) => call.startsWith('execute:')), false);
});

test('does not continue to QA after rejected Code Review', async () => {
  const { options, calls } = dependencies({
    executeAgent: async (stage, context) => ({ stage, decision: 'CHANGES_REQUESTED', commitSha: context.commitSha, reportMarkdown: 'Blocking findings.' }),
  });
  const result = await orchestratePullRequestQuality(input, options);

  assert.equal(result.status, 'BLOCKED');
  assert.deepEqual(result.completedStages, ['codeReview']);
  assert.equal(calls.includes('formal-review'), true);
  assert.equal(calls.includes('execute:qa'), false);
});

test('does not continue to Coordinator after QA rejection', async () => {
  const { options, calls } = dependencies({
    executeAgent: async (stage, context) => ({ stage, decision: stage === 'qa' ? 'CHANGES_REQUESTED' : 'APPROVED', commitSha: context.commitSha, reportMarkdown: 'Evidence.' }),
  });
  const result = await orchestratePullRequestQuality(input, options);

  assert.equal(result.status, 'BLOCKED');
  assert.deepEqual(result.completedStages, ['codeReview', 'qa']);
  assert.equal(calls.includes('execute:qualityGate'), false);
});

test('rejects evidence associated with a stale SHA', async () => {
  const staleSha = 'b'.repeat(40);
  const { options, calls } = dependencies({
    executeAgent: async (stage) => ({ stage, decision: 'APPROVED', commitSha: staleSha, reportMarkdown: 'Stale.' }),
  });
  const result = await orchestratePullRequestQuality(input, options);

  assert.equal(result.status, 'INCONCLUSIVE');
  assert.equal(calls.includes('formal-review'), false);
  assert.equal(calls.some((call) => call.startsWith('publish:')), false);
});

test('cancels remaining stages when HEAD changes during execution', async () => {
  let reads = 0;
  const { options, calls } = dependencies({
    readHeadSha: async () => (++reads >= 4 ? 'b'.repeat(40) : sha),
  });
  const result = await orchestratePullRequestQuality(input, options);

  assert.equal(result.status, 'INCONCLUSIVE');
  assert.equal(calls.includes('execute:qa'), false);
});

test('does not duplicate an already claimed execution', async () => {
  const { options, calls } = dependencies({ claimExecution: async () => false });
  const result = await orchestratePullRequestQuality(input, options);

  assert.equal(result.status, 'ALREADY_RUNNING');
  assert.equal(calls.some((call) => call.startsWith('execute:')), false);
  assert.equal(calls.includes('release:ALREADY_RUNNING'), false);
});

test('returns inconclusive when formal Code Review approval cannot be recorded', async () => {
  const { options, calls } = dependencies({ submitFormalCodeReview: async () => false });
  const result = await orchestratePullRequestQuality(input, options);

  assert.equal(result.status, 'INCONCLUSIVE');
  assert.equal(calls.includes('execute:qa'), false);
  assert.equal(calls.includes('publish:codeReview'), false);
});

test('releases an acquired execution after an adapter failure', async () => {
  const { options, calls } = dependencies({ readPrerequisites: async () => { throw new Error('private integration error'); } });
  const result = await orchestratePullRequestQuality(input, options);

  assert.equal(result.status, 'INCONCLUSIVE');
  assert.equal(calls.at(-1), 'release:INCONCLUSIVE');
  assert.doesNotMatch(result.reasons.join(' '), /private integration error/);
});

test('times out an agent stage, aborts its signal and does not start dependent stages', async () => {
  let receivedSignal;
  const { options, calls } = dependencies({
    agentTimeoutMs: 5,
    executeAgent: async (_stage, _context, signal) => {
      receivedSignal = signal;
      return new Promise(() => {});
    },
  });
  const result = await orchestratePullRequestQuality(input, options);

  assert.equal(result.status, 'INCONCLUSIVE');
  assert.equal(receivedSignal.aborted, true);
  assert.equal(calls.includes('execute:qa'), false);
  assert.equal(calls.at(-1), 'release:INCONCLUSIVE');
});
