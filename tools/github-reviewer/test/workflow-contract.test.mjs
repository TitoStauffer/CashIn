import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const mergeReadinessWorkflow = await readFile(new URL('../../../.github/workflows/merge-readiness.yml', import.meta.url), 'utf8');
const reviewSignalWorkflow = await readFile(new URL('../../../.github/workflows/pr-review-signal.yml', import.meta.url), 'utf8');

test('serializes every merge-readiness trigger by pull request without canceling active evaluation', () => {
  const concurrencyGroup = mergeReadinessWorkflow.match(/^\s+group:\s*(.+)$/m)?.[1] ?? '';

  assert.match(concurrencyGroup, /github\.event\.pull_request\.number/);
  assert.match(concurrencyGroup, /github\.event\.issue\.number/);
  assert.match(concurrencyGroup, /github\.event\.workflow_run\.pull_requests\[0\]\.number/);
  assert.match(concurrencyGroup, /inputs\.pr_number/);
  assert.match(mergeReadinessWorkflow, /^\s+cancel-in-progress:\s*false\s*$/m);
});

test('formal review relay listens to review changes and has no permissions or privileged steps', () => {
  assert.match(reviewSignalWorkflow, /pull_request_review:\s*\n\s+types:\s*\[submitted, edited, dismissed\]/);
  assert.match(reviewSignalWorkflow, /^permissions:\s*\{\}\s*$/m);
  assert.match(reviewSignalWorkflow, /^\s+permissions:\s*\{\}\s*$/m);
  assert.doesNotMatch(reviewSignalWorkflow, /uses:\s*actions\/checkout|secrets\./);
});
