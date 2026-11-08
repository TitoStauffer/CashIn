import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyReviewTrack, isReviewTrack, isRuntimeAffectingPath, runtimeAffectingPaths } from '../dist/review-track.js';

test('a change outside the runtime directories takes the light track', () => {
  assert.equal(classifyReviewTrack([
    'AGENTS.md',
    'docs/knowledge/learnings/code-review-findings.md',
    '.github/pull_request_template.md',
    'tools/jira-dispatcher/README.md',
  ]), 'light');
});

test('a change to API or Web runtime source takes the full track', () => {
  assert.equal(classifyReviewTrack(['docs/README.md', 'apps/api/src/wallets/wallets-service.ts']), 'full');
  assert.equal(classifyReviewTrack(['apps/web/src/creditCards/CreditCardsPage.tsx']), 'full');
});

// The privileged automation decides whether a change may merge, so a change to it is reviewed on the
// full track — including this delivery, which would otherwise classify itself as light.
test('a change to the privileged automation takes the full track', () => {
  assert.equal(classifyReviewTrack(['.github/workflows/agent-orchestration.yml']), 'full');
  assert.equal(classifyReviewTrack(['.github/workflows/merge-readiness.yml']), 'full');
  assert.equal(classifyReviewTrack(['tools/github-reviewer/src/merge-readiness.ts']), 'full');
  assert.equal(classifyReviewTrack(['tools/github-reviewer/src/review-track.ts']), 'full');
  assert.equal(classifyReviewTrack([
    '.github/workflows/agent-orchestration.yml',
    'tools/github-reviewer/src/review-track.ts',
    'tools/github-reviewer/test/review-track.test.mjs',
    'docs/hosted-agent-orchestration.md',
  ]), 'full');
});

// Inert files beside the automation are not the automation: a README, a PR template or a dispatcher
// document changes no decision about merging.
test('documents and templates beside the automation stay on the light track', () => {
  assert.equal(classifyReviewTrack(['.github/pull_request_template.md']), 'light');
  assert.equal(classifyReviewTrack(['tools/github-reviewer/README.md']), 'light');
  assert.equal(classifyReviewTrack(['tools/jira-dispatcher/README.md']), 'light');
  assert.equal(classifyReviewTrack(['tools/github-reviewer/test/merge-readiness.test.mjs']), 'light');
});

test('a change limited to test files under the runtime directories takes the light track', () => {
  assert.equal(classifyReviewTrack([
    'apps/api/src/wallets/wallets-routes.test.ts',
    'apps/api/src/financial-imports/postgres-wallet-transfer-reconciliation.integration.test.ts',
    'apps/web/src/creditCards/CreditCardsPage.test.tsx',
  ]), 'light');
});

test('one runtime file among many test files still forces the full track', () => {
  const changed = [
    'apps/web/src/creditCards/CreditCardsPage.test.tsx',
    'apps/api/src/wallets/wallets-routes.test.ts',
    'apps/api/src/wallets/wallets-service.ts',
  ];

  assert.equal(classifyReviewTrack(changed), 'full');
  assert.deepEqual(runtimeAffectingPaths(changed), ['apps/api/src/wallets/wallets-service.ts']);
});

// A Pull Request that starts as documentation and receives a runtime commit has to climb to the full
// track. The classification is a pure function of the changed-file list, so the new HEAD's list is what
// decides: there is no stored verdict that could keep the lighter track alive.
test('adding a runtime file to a previously light change flips the track up, never down', () => {
  const documentationOnly = ['AGENTS.md', 'docs/hosted-agent-orchestration.md'];
  assert.equal(classifyReviewTrack(documentationOnly), 'light');
  assert.equal(classifyReviewTrack([...documentationOnly, 'apps/api/src/app.ts']), 'full');
});

test('fixtures, shared test helpers and the test setup stay on the full track', () => {
  // Deliberately strict: these live under the runtime directories and change what the tests prove,
  // so they are not treated as test files. Being wrong here costs a round, never a missing QA.
  assert.equal(classifyReviewTrack(['apps/api/src/financial-imports/fixtures/valid-bank.ofx']), 'full');
  assert.equal(classifyReviewTrack(['apps/api/src/wallets/wallets-test-fixture.ts']), 'full');
  assert.equal(classifyReviewTrack(['apps/web/src/test/setup.ts']), 'full');
});

test('an unusable changed-file list fails closed to the full track', () => {
  assert.equal(classifyReviewTrack([]), 'full');
  assert.equal(classifyReviewTrack(undefined), 'full');
  assert.equal(classifyReviewTrack(['']), 'full');
  assert.equal(classifyReviewTrack(['  ']), 'full');
  assert.equal(classifyReviewTrack([42]), 'full');
  assert.equal(classifyReviewTrack('AGENTS.md'), 'full');
});

test('a path that tries to escape the runtime check is treated as runtime', () => {
  assert.equal(isRuntimeAffectingPath('apps/api/src/../../../etc/passwd'), true);
  assert.equal(isRuntimeAffectingPath('apps/web/src/../api/src/app.ts'), true);
  // A backslash-separated path still resolves to the same runtime file.
  assert.equal(isRuntimeAffectingPath('apps\\api\\src\\app.ts'), true);
  assert.equal(isRuntimeAffectingPath('apps\\api\\src\\app.test.ts'), false);
});

test('a directory that merely starts with a runtime name is not runtime', () => {
  assert.equal(isRuntimeAffectingPath('apps/api/srcx/app.ts'), false);
  assert.equal(isRuntimeAffectingPath('apps/api-docs/src/app.ts'), false);
  assert.equal(isRuntimeAffectingPath('apps/api/package.json'), false);
});

test('isReviewTrack accepts only the two tracks', () => {
  assert.equal(isReviewTrack('light'), true);
  assert.equal(isReviewTrack('full'), true);
  assert.equal(isReviewTrack('LIGHT'), false);
  assert.equal(isReviewTrack(''), false);
  assert.equal(isReviewTrack(undefined), false);
});
