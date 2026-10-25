import assert from 'node:assert/strict';
import test from 'node:test';
import { syncApprovalCheckbox, updateApprovalCheckbox } from '../dist/approval-checklist.js';
import { computeAgentContextHash } from '../dist/agent-evidence.js';

const body = [
  '## 13. Revisão e aprovação',
  '',
  '- [ ] **Code Review aprovado** — marcado pelo Agent de Code Review somente após a aprovação.',
  '- [ ] **QA aprovado** — marcado pelo Agent de QA somente após a aprovação.',
].join('\n');

test('marks only the Code Review checkbox', () => {
  const updated = updateApprovalCheckbox(body, 'codeReview', true);
  assert.match(updated, /- \[x\] \*\*Code Review aprovado\*\*/);
  assert.match(updated, /- \[ \] \*\*QA aprovado\*\*/);
});

test('marks only the QA checkbox and is idempotent', () => {
  const updated = updateApprovalCheckbox(body, 'qa', true);
  assert.equal(updateApprovalCheckbox(updated, 'qa', true), updated);
  assert.match(updated, /- \[ \] \*\*Code Review aprovado\*\*/);
  assert.match(updated, /- \[x\] \*\*QA aprovado\*\*/);
});

test('unmarks a stale approval', () => {
  const approved = updateApprovalCheckbox(body, 'codeReview', true);
  assert.equal(updateApprovalCheckbox(approved, 'codeReview', false), body);
});

test('fails closed when the responsible checkbox is missing or duplicated', () => {
  assert.throws(() => updateApprovalCheckbox('', 'qa', true), /exactly one QA aprovado/);
  assert.throws(() => updateApprovalCheckbox(`${body}\n- [ ] **QA aprovado**`, 'qa', true), /exactly one QA aprovado/);
});

const sha = 'a'.repeat(40);
const repository = 'owner/repo';
const reviewInputs = {
  diff: 'diff contents',
  checks: { api: 'PASSED', web: 'PASSED', githubReviewer: 'PASSED', sonarQube: 'PASSED', sonarCloud: 'PASSED' },
  checkRuns: [],
  repositoryInstructions: 'trusted instructions',
  sourceFiles: [],
};

function pullRequest(overrides = {}) {
  return {
    number: 7,
    state: 'open',
    title: 'Example PR',
    html_url: 'https://github.com/owner/repo/pull/7',
    body,
    head: { sha },
    base: { ref: 'master', sha: 'b'.repeat(40) },
    ...overrides,
  };
}

function synchronizationFixture(prReads, patchStatus = 200) {
  const requests = [];
  let readIndex = 0;
  const authFactory = () => async ({ type }) => ({ token: type === 'app' ? 'app-token' : 'installation-token' });
  const fetchImpl = async (url, options = {}) => {
    const path = new URL(url).pathname;
    requests.push({ path, method: options.method ?? 'GET', body: options.body });
    if (path === '/app') return new Response(JSON.stringify({ slug: 'cashin-devagents' }), { status: 200 });
    if (path !== '/repos/owner/repo/pulls/7') throw new Error(`Unexpected request: ${path}`);
    if ((options.method ?? 'GET') === 'GET') {
      const value = prReads[Math.min(readIndex, prReads.length - 1)];
      readIndex += 1;
      return new Response(JSON.stringify(value), { status: 200 });
    }
    const nextBody = JSON.parse(options.body).body;
    return new Response(JSON.stringify({ ...prReads.at(-1), body: nextBody }), { status: patchStatus });
  };
  const initial = prReads[0];
  return {
    requests,
    options: {
      credentials: { appId: '123', privateKey: 'key', installationId: '456', owner: 'owner', repository: 'repo', authFactory },
      repository,
      pullRequestNumber: 7,
      commitSha: sha,
      contextHash: computeAgentContextHash(repository, 7, initial, reviewInputs),
      stage: 'codeReview',
      approved: true,
      fetchImpl,
    },
    dependencies: { loadReviewInputs: async () => reviewInputs },
  };
}

test('reloads the PR immediately before patching and preserves the latest body', async () => {
  const fixture = synchronizationFixture([pullRequest(), pullRequest(), pullRequest()]);

  assert.equal(await syncApprovalCheckbox(fixture.options, fixture.dependencies), true);
  const patch = fixture.requests.find(({ method }) => method === 'PATCH');
  assert.match(JSON.parse(patch.body).body, /- \[x\] \*\*Code Review aprovado\*\*/);
  assert.equal(fixture.requests.filter(({ method, path }) => method === 'GET' && /pulls\/7$/.test(path)).length, 3);
});

test('fails closed when the PR body changes before the final write', async () => {
  const changed = pullRequest({ body: `${body}\n\nCritério novo.` });
  const fixture = synchronizationFixture([pullRequest(), pullRequest(), changed]);

  await assert.rejects(() => syncApprovalCheckbox(fixture.options, fixture.dependencies), /changed immediately before/);
  assert.equal(fixture.requests.some(({ method }) => method === 'PATCH'), false);
});

test('fails closed when the PR HEAD changes before the final write', async () => {
  const changed = pullRequest({ head: { sha: 'c'.repeat(40) } });
  const fixture = synchronizationFixture([pullRequest(), pullRequest(), changed]);

  await assert.rejects(() => syncApprovalCheckbox(fixture.options, fixture.dependencies), /HEAD changed/);
  assert.equal(fixture.requests.some(({ method }) => method === 'PATCH'), false);
});

test('surfaces a failed PATCH without claiming the checkbox was synchronized', async () => {
  const fixture = synchronizationFixture([pullRequest(), pullRequest(), pullRequest()], 422);

  await assert.rejects(() => syncApprovalCheckbox(fixture.options, fixture.dependencies), /GitHub API request failed \(422\)/);
});
