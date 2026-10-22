import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateMergeReadiness } from '../dist/merge-readiness.js';
import { agentReportMarker, computeAgentContextHash } from '../dist/agent-evidence.js';
import { summarizeAgentChecks } from '../dist/agent-review-inputs.js';

const sha = 'a'.repeat(40);
const oldSha = 'b'.repeat(40);
const checks = ['API', 'Web', 'SonarQube', 'SonarCloud Code Analysis', 'PR title'].map((name) => ({ name, head_sha: sha, status: 'completed', conclusion: 'success' }));
const reviewInputs = { diff: 'diff contents', checks: summarizeAgentChecks(checks), repositoryInstructions: 'trusted instructions' };
const contextHash = computeAgentContextHash('owner/repo', 7, {
  title: 'Example PR', html_url: 'https://github.com/owner/repo/pull/7', body: '',
  head: { sha }, base: { ref: 'master', sha: 'c'.repeat(40) },
}, reviewInputs);

function report(signature, section, commitSha = sha, reportContextHash = contextHash) {
  const stage = signature.includes('QA Agent') ? 'qa' : 'qualityGate';
  return {
    user: { login: 'cashin-devagents' },
    created_at: '2026-10-21T12:00:00Z',
    body: `${agentReportMarker(stage, commitSha, reportContextHash)}\n### ${signature}\n\n**Status:** APPROVED\n**Commit:** \`${commitSha}\`\n\n**${section}:**\n- Evidência validada.`,
  };
}

function fixture(overrides = {}) {
  const requests = [];
  let pullRequestReadCount = 0;
  const data = {
    checks,
    reviews: [{ user: { login: 'cashin-devagents' }, state: 'APPROVED', commit_id: sha, submitted_at: '2026-10-21T12:00:00Z', body: `${agentReportMarker('codeReview', sha, contextHash)}\n### Codex — Code Review Agent\n\n**Status:** APPROVED\n**Commit:** \`${sha}\`\n\n### Code Review — APPROVED` }],
    comments: [report('Codex — QA Agent', 'Verificações de QA'), report('Codex — Quality Gate Coordinator', 'Checks verificados')],
    title: 'Example PR',
    body: '',
    baseSha: 'c'.repeat(40),
    diff: 'diff contents',
    instructions: 'trusted instructions',
    contextChanges: false,
    prCloses: false,
    mergeabilityChanges: false,
    mergeableState: 'clean',
    protectionStatus: 200,
    requiredCheckAppId: null,
    requiredContexts: ['PR title'],
    unresolved: false,
    shaChanges: false,
    ...overrides,
  };

  const fetchImpl = async (url, options = {}) => {
    const parsed = new URL(url);
    const path = `${parsed.pathname}${parsed.search}`;
    requests.push({ path, method: options.method ?? 'GET' });
    if (parsed.pathname === '/app') return response({ slug: 'cashin-devagents' });
    if (parsed.pathname === '/repos/owner/repo/pulls/7' && options.headers?.Accept === 'application/vnd.github.v3.diff') return new Response(data.diff);
    if (parsed.pathname === '/repos/owner/repo/pulls/7') {
      pullRequestReadCount += 1;
      return response({
        state: data.prCloses && pullRequestReadCount > 1 ? 'closed' : 'open', title: data.title, html_url: 'https://github.com/owner/repo/pull/7',
        body: data.contextChanges && pullRequestReadCount > 1 ? 'PR metadata changed during evaluation.' : data.body,
        head: { sha: data.shaChanges && pullRequestReadCount > 1 ? oldSha : sha },
        base: { ref: 'master', sha: data.baseSha }, user: { login: 'author' },
        mergeable: data.mergeabilityChanges && pullRequestReadCount > 1 ? false : true,
        mergeable_state: data.mergeabilityChanges && pullRequestReadCount > 1 ? 'dirty' : data.mergeableState,
      });
    }
    if (parsed.pathname.includes('/check-runs')) {
      if (data.apiFailure) return response({ message: 'private details are not surfaced' }, 500);
      return response({ check_runs: data.checks });
    }
    if (parsed.pathname === '/repos/owner/repo/contents/AGENTS.md') return response({ encoding: 'base64', content: Buffer.from(data.instructions).toString('base64') });
    if (parsed.pathname.endsWith(`/commits/${sha}/status`)) return response({ statuses: [] });
    if (parsed.pathname === '/repos/owner/repo/pulls/7/reviews') return response(data.reviews);
    if (parsed.pathname === '/repos/owner/repo/issues/7/comments') return response(data.comments);
    if (parsed.pathname === '/graphql') {
      return response({ data: { repository: { pullRequest: { reviewThreads: {
        nodes: data.unresolved ? [{ isResolved: false }] : [],
        pageInfo: { hasNextPage: false, endCursor: null },
      } } } } });
    }
    if (parsed.pathname === '/repos/owner/repo/branches/master/protection') {
      if (data.protectionStatus !== 200) return response({}, data.protectionStatus);
      const requiredStatusChecks = data.requiredCheckAppId
        ? { checks: [{ context: 'PR title', app_id: data.requiredCheckAppId }] }
        : { contexts: data.requiredContexts };
      return response({ required_status_checks: requiredStatusChecks, required_pull_request_reviews: { required_approving_review_count: 1, dismiss_stale_reviews: true } });
    }
    if (parsed.pathname === '/repos/owner/repo/rulesets') return response([]);
    if (parsed.pathname === '/repos/owner/repo') return response({ default_branch: 'master' });
    throw new Error(`Unexpected request: ${options.method ?? 'GET'} ${path}`);
  };
  const authFactory = () => async ({ type }) => ({ token: type === 'app' ? 'simulated-app-token' : 'simulated-installation-token' });

  return {
    requests,
    data,
    evaluate: () => evaluateMergeReadiness({
      appId: '123', privateKey: 'test-key', owner: 'owner', repository: 'repo', installationId: '456',
      pullRequestNumber: 7, fetchImpl, authFactory, now: () => new Date('2026-10-21T12:30:00Z'),
    }),
  };
}

function response(payload, status = 200) {
  return new Response(JSON.stringify(payload), { status });
}

test('returns READY_TO_MERGE only when protections, checks, formal review and structured reports are current', async () => {
  const subject = fixture();
  const result = await subject.evaluate();

  assert.equal(result.status, 'READY_TO_MERGE');
  assert.equal(result.pullRequest.headSha, sha);
  assert.deepEqual(result.reasons, []);
  assert.ok(subject.requests.every((request) => request.method === 'GET' || request.path === '/graphql'));
});

test('does not create a circular dependency on the Merge Readiness context', async () => {
  const subject = fixture({ requiredContexts: ['PR title', 'Merge Readiness'] });
  const result = await subject.evaluate();

  assert.equal(result.status, 'READY_TO_MERGE');
  assert.deepEqual(result.evidence.requiredChecks.map((check) => check.context), ['PR title']);
});

test('does not block solely because GitHub reports UNSTABLE when mergeability and required evidence are valid', async () => {
  const result = await fixture({ mergeableState: 'unstable' }).evaluate();

  assert.equal(result.status, 'READY_TO_MERGE');
  assert.deepEqual(result.reasons, []);
});

test('still blocks an UNSTABLE pull request when a required check fails', async () => {
  const failingChecks = checks.map((check) => check.name === 'SonarQube' ? { ...check, conclusion: 'failure' } : check);
  const result = await fixture({ mergeableState: 'unstable', checks: failingChecks }).evaluate();

  assert.equal(result.status, 'BLOCKED');
  assert.match(result.reasons.join(' '), /SonarQube: FAILED/);
});

test('blocks when the caller requires a different base branch', async () => {
  const result = await evaluateMergeReadiness({
    appId: '123', privateKey: 'test-key', owner: 'owner', repository: 'repo', installationId: '456',
    pullRequestNumber: 7, requiredBaseBranch: 'master',
    fetchImpl: async (url) => {
      const parsed = new URL(url);
      if (parsed.pathname === '/app') return response({ slug: 'cashin-devagents' });
      if (parsed.pathname === '/repos/owner/repo/pulls/7') {
        return response({ state: 'open', head: { sha }, base: { ref: 'develop' }, mergeable: true, mergeable_state: 'clean' });
      }
      throw new Error(`Unexpected request: ${parsed.pathname}`);
    },
    authFactory: () => async () => ({ token: 'simulated-app-token' }),
  });

  assert.equal(result.status, 'BLOCKED');
  assert.match(result.reasons.join(' '), /destino a branch master/);
});

test('blocks when a QA report belongs to a stale SHA', async () => {
  const subject = fixture({ comments: [report('Codex — QA Agent', 'Verificações de QA', oldSha), report('Codex — Quality Gate Coordinator', 'Checks verificados')] });
  const result = await subject.evaluate();

  assert.equal(result.status, 'BLOCKED');
  assert.match(result.reasons.join(' '), /QA.*SHA/);
});

test('blocks when a required CI or Sonar check fails', async () => {
  const checks = fixture().data.checks.map((check) => check.name === 'SonarQube' ? { ...check, conclusion: 'failure' } : check);
  const subject = fixture({ checks });
  const result = await subject.evaluate();

  assert.equal(result.status, 'BLOCKED');
  assert.match(result.reasons.join(' '), /SonarQube: FAILED/);
});

test('blocks when a required check is reported by a different GitHub App', async () => {
  const checks = fixture().data.checks.map((check) => check.name === 'PR title' ? { ...check, app: { id: 5, slug: 'other-app' } } : check);
  const subject = fixture({ checks, requiredCheckAppId: 77 });
  const result = await subject.evaluate();

  assert.equal(result.status, 'BLOCKED');
  assert.match(result.reasons.join(' '), /PR title: WRONG_APP/);
});

test('blocks when the Code Review Agent records a later rejection', async () => {
  const subject = fixture({ reviews: [
    { user: { login: 'cashin-devagents' }, state: 'APPROVED', commit_id: sha, submitted_at: '2026-10-21T12:00:00Z', body: '### Code Review — APPROVED' },
    { user: { login: 'cashin-devagents' }, state: 'CHANGES_REQUESTED', commit_id: sha, submitted_at: '2026-10-21T12:05:00Z', body: '### Code Review — CHANGES_REQUESTED' },
  ] });
  const result = await subject.evaluate();

  assert.equal(result.status, 'BLOCKED');
  assert.match(result.reasons.join(' '), /Code Review.*não está aprovada/);
});

test('blocks Code Review and reports made for old PR metadata, even when the HEAD SHA is unchanged', async () => {
  const subject = fixture({ body: 'Acceptance criteria changed after the agents ran.' });
  const result = await subject.evaluate();

  assert.equal(result.status, 'BLOCKED');
  assert.match(result.reasons.join(' '), /metadados desatualizados/);
  assert.equal(result.evidence.codeReview.currentContext, false);
});

test('blocks evidence when the merge base or diff changes without a new PR HEAD', async () => {
  const newBase = await fixture({ baseSha: 'd'.repeat(40) }).evaluate();
  assert.equal(newBase.status, 'BLOCKED');
  assert.match(newBase.reasons.join(' '), /metadados desatualizados/);

  const newDiff = await fixture({ diff: 'changed diff from updated master' }).evaluate();
  assert.equal(newDiff.status, 'BLOCKED');
  assert.match(newDiff.reasons.join(' '), /metadados desatualizados/);
});

test('blocks when QA report is missing', async () => {
  const subject = fixture({ comments: [report('Codex — Quality Gate Coordinator', 'Checks verificados')] });
  const result = await subject.evaluate();

  assert.equal(result.status, 'BLOCKED');
  assert.match(result.reasons.join(' '), /QA.*ausente/);
});

test('returns INCONCLUSIVE when branch protection cannot be read', async () => {
  const subject = fixture({ protectionStatus: 403 });
  const result = await subject.evaluate();

  assert.equal(result.status, 'INCONCLUSIVE');
  assert.match(result.limitations.join(' '), /Branch protection indisponível \(HTTP 403\)/);
});

test('returns INCONCLUSIVE on GitHub API failures without exposing response details', async () => {
  const subject = fixture({ apiFailure: true });
  const result = await subject.evaluate();

  assert.equal(result.status, 'INCONCLUSIVE');
  assert.doesNotMatch(JSON.stringify(result), /private details|simulated-installation-token|test-key/);
});

test('blocks when a review thread is unresolved', async () => {
  const subject = fixture({ unresolved: true });
  const result = await subject.evaluate();

  assert.equal(result.status, 'BLOCKED');
  assert.match(result.reasons.join(' '), /conversas de revisão não resolvidas/i);
});

test('blocks when the PR HEAD changes while evidence is being collected', async () => {
  const subject = fixture({ shaChanges: true });
  const result = await subject.evaluate();

  assert.equal(result.status, 'BLOCKED');
  assert.match(result.reasons.join(' '), /HEAD SHA mudou/);
});

test('blocks when PR metadata changes while evidence is being collected', async () => {
  const subject = fixture({ contextChanges: true });
  const result = await subject.evaluate();

  assert.equal(result.status, 'BLOCKED');
  assert.match(result.reasons.join(' '), /metadados do Pull Request mudaram durante a avaliação/);
});

test('blocks when the PR closes or becomes unmergeable during the evaluation', async () => {
  const closed = await fixture({ prCloses: true }).evaluate();
  assert.equal(closed.status, 'BLOCKED');
  assert.match(closed.reasons.join(' '), /deixou de estar aberto/);

  const conflicted = await fixture({ mergeabilityChanges: true }).evaluate();
  assert.equal(conflicted.status, 'BLOCKED');
  assert.match(conflicted.reasons.join(' '), /deixou de estar integrável/);
});
