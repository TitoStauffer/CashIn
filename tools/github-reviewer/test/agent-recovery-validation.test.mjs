import assert from 'node:assert/strict';
import test from 'node:test';
import { validateRecoverySource } from '../dist/agent-recovery-validation.js';

const sourceRunId = 12345;
const repository = 'TitoStauffer/CashIn';

function evidence(overrides = {}) {
  return {
    run: {
      id: sourceRunId,
      path: '.github/workflows/agent-orchestration.yml',
      event: 'workflow_run',
      status: 'completed',
      head_branch: 'master',
      repository: { full_name: repository },
      head_repository: { full_name: repository },
      ...overrides.run,
    },
    jobs: overrides.jobs ?? [{
      name: 'Codex QA', run_id: sourceRunId, status: 'completed',
      steps: [{ name: 'Upload QA result', status: 'completed', conclusion: 'success' }],
    }],
    artifacts: overrides.artifacts ?? [{
      name: `codex-qa-${sourceRunId}`, expired: false, size_in_bytes: 512, workflow_run: { id: sourceRunId },
    }],
  };
}

test('accepts only the expected artifact produced by the trusted stage job', () => {
  assert.equal(validateRecoverySource({ repository, sourceRunId, stage: 'qa', evidence: evidence() }), `codex-qa-${sourceRunId}`);
});

test('rejects an artifact from another workflow even when its name is predictable', () => {
  assert.throws(() => validateRecoverySource({
    repository, sourceRunId, stage: 'qa', evidence: evidence({ run: { path: '.github/workflows/untrusted.yml' } }),
  }), /trusted orchestration run/);
});

test('rejects a forged artifact not bound to the selected source run', () => {
  assert.throws(() => validateRecoverySource({
    repository, sourceRunId, stage: 'qa', evidence: evidence({
      artifacts: [{ name: `codex-qa-${sourceRunId}`, expired: false, size_in_bytes: 512, workflow_run: { id: sourceRunId + 1 } }],
    }),
  }), /provenance is invalid/);
});

test('rejects a stage whose artifact upload did not complete successfully', () => {
  assert.throws(() => validateRecoverySource({
    repository, sourceRunId, stage: 'qa', evidence: evidence({
      jobs: [{ name: 'Codex QA', run_id: sourceRunId, status: 'completed', steps: [{ name: 'Upload QA result', status: 'completed', conclusion: 'failure' }] }],
    }),
  }), /did not produce a successful artifact upload/);
});
