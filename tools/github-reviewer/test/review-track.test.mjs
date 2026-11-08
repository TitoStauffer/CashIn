import assert from 'node:assert/strict';
import test from 'node:test';
import { LIGHT_TRACK_RULE, classifyReviewTrack, isReviewTrack, isRuntimeAffectingPath, runtimeAffectingPaths } from '../dist/review-track.js';

test('a documentation-only change takes the light track', () => {
  // These are the deliveries the light track exists for: DEV-115 and DEV-119 changed `AGENTS.md`
  // alone and each consumed a full round of the serialized runner.
  assert.equal(classifyReviewTrack(['AGENTS.md', 'docs/knowledge/learnings/agent-process.md']), 'light');
  assert.equal(classifyReviewTrack([
    'docs/hosted-agent-orchestration.md',
    '.github/pull_request_template.md',
    'tools/github-reviewer/README.md',
    'apps/web/README.md',
    'docs/knowledge/context-map.json',
  ]), 'light');
});

test('a change limited to test files takes the light track', () => {
  assert.equal(classifyReviewTrack([
    'apps/api/src/wallets/wallets-routes.test.ts',
    'apps/api/src/financial-imports/postgres-wallet-transfer-reconciliation.integration.test.ts',
    'apps/web/src/creditCards/CreditCardsPage.test.tsx',
    'tools/github-reviewer/test/merge-readiness.test.mjs',
  ]), 'light');
});

test('a change to API or Web runtime source takes the full track', () => {
  assert.equal(classifyReviewTrack(['docs/README.md', 'apps/api/src/wallets/wallets-service.ts']), 'full');
  assert.equal(classifyReviewTrack(['apps/web/src/creditCards/CreditCardsPage.tsx']), 'full');
});

// The privileged automation decides whether a change may merge, so a change to it is reviewed on the
// full track — including this delivery, which the first implementation classified as light.
test('a change to the privileged automation takes the full track', () => {
  assert.equal(classifyReviewTrack(['.github/workflows/agent-orchestration.yml']), 'full');
  assert.equal(classifyReviewTrack(['.github/workflows/merge-readiness.yml']), 'full');
  assert.equal(classifyReviewTrack(['tools/github-reviewer/src/merge-readiness.ts']), 'full');
  assert.equal(classifyReviewTrack(['.claude/settings.json']), 'full');
  assert.equal(classifyReviewTrack([
    '.github/workflows/agent-orchestration.yml',
    'tools/github-reviewer/src/review-track.ts',
    'tools/github-reviewer/test/review-track.test.mjs',
    'docs/hosted-agent-orchestration.md',
  ]), 'full');
});

// The Code Review of PR #91 proved the first shape of this rule unsafe: it listed the sensitive paths,
// so everything it had not thought of — migrations above all — escaped QA by omission. These are the
// paths that were wrong, and each one is a regression of its own.
test('database migrations take the full track', () => {
  assert.equal(classifyReviewTrack(['apps/api/migrations/0123_new_column.sql']), 'full');
  assert.equal(classifyReviewTrack(['apps/api/migrations/001_auth.sql', 'AGENTS.md']), 'full');
});

test('manifests, lockfiles and build configuration take the full track', () => {
  for (const path of [
    'apps/api/package.json',
    'apps/api/package-lock.json',
    'apps/web/package.json',
    'apps/web/package-lock.json',
    'apps/web/vite.config.ts',
    'apps/web/tsconfig.app.json',
    'apps/web/index.html',
    'apps/web/.oxlintrc.json',
  ]) {
    assert.equal(classifyReviewTrack([path]), 'full', path);
  }
});

test('container and environment definitions take the full track', () => {
  for (const path of ['compose.yaml', 'apps/api/Dockerfile', 'apps/web/Dockerfile', '.env.example', 'sonar-project.properties']) {
    assert.equal(classifyReviewTrack([path]), 'full', path);
  }
});

test('one runtime file among many documentation files still forces the full track', () => {
  const changed = ['AGENTS.md', 'docs/knowledge/current-state.md', 'apps/api/migrations/0124_index.sql'];

  assert.equal(classifyReviewTrack(changed), 'full');
  assert.deepEqual(runtimeAffectingPaths(changed), ['apps/api/migrations/0124_index.sql']);
});

// A Pull Request that starts as documentation and receives a runtime commit has to climb to the full
// track. The classification is a pure function of the changed-file list, so the new HEAD's list is what
// decides: there is no stored verdict that could keep the lighter track alive.
test('adding a runtime file to a previously light change flips the track up, never down', () => {
  const documentationOnly = ['AGENTS.md', 'docs/hosted-agent-orchestration.md'];
  assert.equal(classifyReviewTrack(documentationOnly), 'light');
  assert.equal(classifyReviewTrack([...documentationOnly, 'apps/api/src/app.ts']), 'full');
});

// Renaming a runtime file out of the runtime directories used to classify as light under the previous
// shape, because the list only carries the new path. With an allowlist the new path is what is judged,
// and a `.ts` anywhere is full-track.
test('renaming a runtime file to another directory stays on the full track', () => {
  assert.equal(classifyReviewTrack(['tools/archive/legacy.ts']), 'full');
  assert.equal(classifyReviewTrack(['docs/archive/legacy.ts']), 'full');
});

test('fixtures, shared test helpers and the test setup stay on the full track', () => {
  // Deliberately strict: they change what the tests prove, so they are not treated as test files.
  assert.equal(classifyReviewTrack(['apps/api/src/financial-imports/fixtures/valid-bank.ofx']), 'full');
  assert.equal(classifyReviewTrack(['apps/api/src/wallets/wallets-test-fixture.ts']), 'full');
  assert.equal(classifyReviewTrack(['apps/web/src/test/setup.ts']), 'full');
  assert.equal(classifyReviewTrack(['tools/github-reviewer/test/fixtures/sample.json']), 'full');
});

test('an unusable changed-file list fails closed to the full track', () => {
  assert.equal(classifyReviewTrack([]), 'full');
  assert.equal(classifyReviewTrack(undefined), 'full');
  assert.equal(classifyReviewTrack(['']), 'full');
  assert.equal(classifyReviewTrack(['  ']), 'full');
  assert.equal(classifyReviewTrack([42]), 'full');
  assert.equal(classifyReviewTrack('AGENTS.md'), 'full');
});

test('a path that cannot be reasoned about is treated as runtime', () => {
  assert.equal(isRuntimeAffectingPath('../outside/AGENTS.md'), true);
  assert.equal(isRuntimeAffectingPath('docs/../AGENTS.md'), true);
  assert.equal(isRuntimeAffectingPath('/etc/passwd.md'), true);
  // A backslash-separated path still resolves to the same file.
  assert.equal(isRuntimeAffectingPath('docs\\knowledge\\README.md'), false);
  assert.equal(isRuntimeAffectingPath('apps\\api\\src\\app.ts'), true);
});

test('a file that merely looks like documentation is not documentation', () => {
  assert.equal(isRuntimeAffectingPath('apps/api/src/markdown.ts'), true);
  assert.equal(isRuntimeAffectingPath('apps/api/src/README.md.ts'), true);
  assert.equal(isRuntimeAffectingPath('docs/knowledge/context-map.json.ts'), true);
  // Only the exact context map is allowed, not any file named like it elsewhere.
  assert.equal(isRuntimeAffectingPath('apps/api/src/context-map.json'), true);
});

test('isReviewTrack accepts only the two tracks', () => {
  assert.equal(isReviewTrack('light'), true);
  assert.equal(isReviewTrack('full'), true);
  assert.equal(isReviewTrack('LIGHT'), false);
  assert.equal(isReviewTrack(''), false);
  assert.equal(isReviewTrack(undefined), false);
});

test('the published rule names every path the light track allows', () => {
  // The Coordinator's report quotes this constant as the durable, App-signed justification for skipping
  // a mandatory stage, so it cannot claim more than the classifier accepts. The rule used to say
  // `*.test.*`, which reads as any extension, while only code extensions are accepted.
  assert.match(LIGHT_TRACK_RULE, /\*\.md/);
  assert.match(LIGHT_TRACK_RULE, /docs\/knowledge\/context-map\.json/);

  // The published extension list is compared on its own, so the `context-map.json` mention cannot make
  // a `.json` test fixture look advertised.
  const published = LIGHT_TRACK_RULE.match(/\*\.test\.\{([^}]+)\}/)?.[1].split(',') ?? [];
  assert.deepEqual(published, ['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs'], LIGHT_TRACK_RULE);

  for (const extension of published) {
    assert.equal(isRuntimeAffectingPath(`apps/api/src/thing.test.${extension}`), false, extension);
  }
  // An extension the classifier refuses must not appear in the published list. `md` is left out of this
  // loop on purpose: a `.md` file is inert wherever it lives, whether or not its name says "test".
  for (const extension of ['json', 'sql', 'yaml', 'ofx']) {
    assert.equal(isRuntimeAffectingPath(`apps/api/src/fixture.test.${extension}`), true, extension);
    assert.ok(!published.includes(extension), `${extension} anunciado como inerte e recusado pelo classificador`);
  }
});
