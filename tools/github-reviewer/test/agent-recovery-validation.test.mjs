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
      name: 'Codex QA', run_id: sourceRunId, run_attempt: 1, status: 'completed',
      started_at: '2026-10-28T10:00:00Z', completed_at: '2026-10-28T10:10:00Z',
      steps: [{ name: 'Upload QA result', status: 'completed', conclusion: 'success' }],
    }],
    artifacts: overrides.artifacts ?? [{
      id: 101, name: `codex-qa-${sourceRunId}`, expired: false, size_in_bytes: 512,
      created_at: '2026-10-28T10:09:00Z', workflow_run: { id: sourceRunId },
    }],
  };
}

test('accepts only the expected artifact produced by the trusted stage job', () => {
  assert.deepEqual(validateRecoverySource({ repository, sourceRunId, stage: 'qa', evidence: evidence() }), {
    artifactName: `codex-qa-${sourceRunId}`, artifactId: 101, runAttempt: 1,
  });
});

test('selects the artifact produced by the latest successful run attempt', () => {
  const selection = validateRecoverySource({
    repository,
    sourceRunId,
    stage: 'qa',
    evidence: evidence({
      jobs: [
        {
          name: 'Codex QA', run_id: sourceRunId, run_attempt: 1, status: 'completed',
          started_at: '2026-10-28T10:00:00Z', completed_at: '2026-10-28T10:10:00Z',
          steps: [{ name: 'Upload QA result', status: 'completed', conclusion: 'success' }],
        },
        {
          name: 'Codex QA', run_id: sourceRunId, run_attempt: 2, status: 'completed',
          started_at: '2026-10-28T11:00:00Z', completed_at: '2026-10-28T11:10:00Z',
          steps: [{ name: 'Upload QA result', status: 'completed', conclusion: 'success' }],
        },
      ],
      artifacts: [
        {
          id: 101, name: `codex-qa-${sourceRunId}`, expired: false, size_in_bytes: 512,
          created_at: '2026-10-28T10:09:00Z', workflow_run: { id: sourceRunId },
        },
        {
          id: 202, name: `codex-qa-${sourceRunId}`, expired: false, size_in_bytes: 768,
          created_at: '2026-10-28T11:09:00Z', workflow_run: { id: sourceRunId },
        },
      ],
    }),
  });
  assert.deepEqual(selection, { artifactName: `codex-qa-${sourceRunId}`, artifactId: 202, runAttempt: 2 });
});

test('does not fall back to an older artifact when the latest successful attempt has no authenticated artifact', () => {
  assert.throws(() => validateRecoverySource({
    repository,
    sourceRunId,
    stage: 'qa',
    evidence: evidence({
      jobs: [
        {
          name: 'Codex QA', run_id: sourceRunId, run_attempt: 1, status: 'completed',
          started_at: '2026-10-28T10:00:00Z', completed_at: '2026-10-28T10:10:00Z',
          steps: [{ name: 'Upload QA result', status: 'completed', conclusion: 'success' }],
        },
        {
          name: 'Codex QA', run_id: sourceRunId, run_attempt: 2, status: 'completed',
          started_at: '2026-10-28T11:00:00Z', completed_at: '2026-10-28T11:10:00Z',
          steps: [{ name: 'Upload QA result', status: 'completed', conclusion: 'success' }],
        },
      ],
    }),
  }), /provenance is invalid/);
});

test('rejects an artifact from another workflow even when its name is predictable', () => {
  assert.throws(() => validateRecoverySource({
    repository, sourceRunId, stage: 'qa', evidence: evidence({ run: { path: '.github/workflows/untrusted.yml' } }),
  }), /trusted orchestration run/);
});

test('rejects a forged artifact not bound to the selected source run', () => {
  assert.throws(() => validateRecoverySource({
    repository, sourceRunId, stage: 'qa', evidence: evidence({
      artifacts: [{
        id: 101, name: `codex-qa-${sourceRunId}`, expired: false, size_in_bytes: 512,
        created_at: '2026-10-28T10:09:00Z', workflow_run: { id: sourceRunId + 1 },
      }],
    }),
  }), /provenance is invalid/);
});

test('rejects a stage whose artifact upload did not complete successfully', () => {
  assert.throws(() => validateRecoverySource({
    repository, sourceRunId, stage: 'qa', evidence: evidence({
      jobs: [{
        name: 'Codex QA', run_id: sourceRunId, run_attempt: 1, status: 'completed',
        started_at: '2026-10-28T10:00:00Z', completed_at: '2026-10-28T10:10:00Z',
        steps: [{ name: 'Upload QA result', status: 'completed', conclusion: 'failure' }],
      }],
    }),
  }), /did not produce a successful artifact upload/);
});

test('rejects an artifact whose producing attempt cannot be authenticated', () => {
  assert.throws(() => validateRecoverySource({
    repository, sourceRunId, stage: 'qa', evidence: evidence({
      artifacts: [{
        id: 101, name: `codex-qa-${sourceRunId}`, expired: false, size_in_bytes: 512,
        created_at: '2026-10-28T12:00:00Z', workflow_run: { id: sourceRunId },
      }],
    }),
  }), /invalid, ambiguous, or expired/);
});
