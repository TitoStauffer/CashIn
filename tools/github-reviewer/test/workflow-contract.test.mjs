import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const mergeReadinessWorkflow = await readFile(new URL('../../../.github/workflows/merge-readiness.yml', import.meta.url), 'utf8');
const reviewSignalWorkflow = await readFile(new URL('../../../.github/workflows/pr-review-signal.yml', import.meta.url), 'utf8');
const ciWorkflow = await readFile(new URL('../../../.github/workflows/ci.yml', import.meta.url), 'utf8');
const orchestrationWorkflow = await readFile(new URL('../../../.github/workflows/agent-orchestration.yml', import.meta.url), 'utf8');

test('supersedes obsolete merge-readiness evaluations for the same pull request', () => {
  const concurrencyGroup = mergeReadinessWorkflow.match(/^\s+group:\s*(.+)$/m)?.[1] ?? '';

  assert.match(concurrencyGroup, /github\.event\.pull_request\.number/);
  assert.match(concurrencyGroup, /github\.event\.issue\.number/);
  assert.match(concurrencyGroup, /github\.event\.workflow_run\.pull_requests\[0\]\.number/);
  assert.match(concurrencyGroup, /inputs\.pr_number/);
  assert.match(mergeReadinessWorkflow, /^\s+cancel-in-progress:\s*true\s*$/m);
});

test('sequences PR metadata, implementation checks, SonarQube and agent orchestration', () => {
  assert.match(ciWorkflow, /^  pr-title:\s*$/m);
  assert.match(ciWorkflow, /^  automation-tools:\s*\n\s+name: Automation Tools\s*\n\s+needs: pr-title/m);
  assert.match(ciWorkflow, /^  api:\s*\n\s+name: API\s*\n\s+needs: pr-title/m);
  assert.match(ciWorkflow, /^  web:\s*\n\s+name: Web\s*\n\s+needs: pr-title/m);
  assert.match(ciWorkflow, /^  sonarqube:[\s\S]*?^\s+needs: \[api, web, automation-tools\]\s*$/m);
  assert.match(orchestrationWorkflow, /^\s+workflows: \[CI\]\s*$/m);
  assert.doesNotMatch(orchestrationWorkflow, /workflows: \[[^\]]*PR title/);
  assert.match(orchestrationWorkflow, /^\s+cancel-in-progress:\s*true\s*$/m);
});

test('formal review relay listens to review changes and has no permissions or privileged steps', () => {
  assert.match(reviewSignalWorkflow, /pull_request_review:\s*\n\s+types:\s*\[submitted, edited, dismissed\]/);
  assert.match(reviewSignalWorkflow, /^permissions:\s*\{\}\s*$/m);
  assert.match(reviewSignalWorkflow, /^\s+permissions:\s*\{\}\s*$/m);
  assert.doesNotMatch(reviewSignalWorkflow, /uses:\s*actions\/checkout|secrets\./);
});
