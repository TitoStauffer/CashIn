import assert from 'node:assert/strict';
import test from 'node:test';
import { GitHubReportPublisher, formatPullRequestReport, REPORT_AGENT_SIGNATURES } from '../dist/github-report-publisher.js';
import { computeAgentContextHash } from '../dist/agent-evidence.js';
import { summarizeAgentChecks, summarizeCheckRunEvidence } from '../dist/agent-review-inputs.js';

const sha = 'a'.repeat(40);
const baseSha = 'c'.repeat(40);
const checkRuns = ['API', 'Web', 'Automation Tools', 'SonarQube', 'SonarCloud Code Analysis'].map((name) => ({ name, head_sha: sha, status: 'completed', conclusion: 'success', ...(name === 'Automation Tools' ? { app: { id: 15368 } } : {}) }));
const currentPr = {
  title: 'Example PR', html_url: 'https://github.com/TitoStauffer/CashIn/pull/42', body: '',
  head: { sha }, base: { ref: 'master', sha: baseSha },
};
const currentInputs = { diff: 'diff contents', checks: summarizeAgentChecks(checkRuns, sha), checkRuns: summarizeCheckRunEvidence(checkRuns, sha), repositoryInstructions: 'trusted instructions', sourceFiles: [] };
const contextHash = computeAgentContextHash('TitoStauffer/CashIn', 42, currentPr, currentInputs);
const baseReport = {
  agentName: 'qa', pullRequestNumber: 42, commitSha: sha, contextHash, status: 'APPROVED',
  reportMarkdown: '## Resultado\n\nCritérios validados.',
};

function fakeAuthFactory(authCalls) {
  return () => async (authOptions) => {
    authCalls.push(authOptions);
    return { token: authOptions.type === 'app' ? 'simulated-app-jwt' : 'simulated-installation-token' };
  };
}

function response(payload, status = 200) {
  return new Response(JSON.stringify(payload), { status });
}

function fakeGitHub(requests, { pr = currentPr, comments = [], apiFailure = false, changePrAfterFirstRead = false } = {}) {
  let prReads = 0;
  return async (url, options = {}) => {
    const parsed = new URL(url);
    requests.push({ url, options });
    if (parsed.pathname === '/app') return response({ slug: 'cashin-devagents' });
    if (parsed.pathname.endsWith('/installation')) return response({ id: 173427336 });
    if (parsed.pathname.endsWith('/pulls/42') && options.headers?.Accept === 'application/vnd.github.v3.diff') return new Response('diff contents');
    if (parsed.pathname.endsWith('/pulls/42/files')) return response([]);
    if (parsed.pathname.endsWith('/pulls/42')) {
      prReads += 1;
      return response({ state: 'open', user: { login: 'author' }, ...pr,
        ...(changePrAfterFirstRead && prReads > 1 ? { body: 'Changed criteria' } : {}) });
    }
    if (parsed.pathname.includes('/check-runs')) {
      if (apiFailure) return response({ message: 'private details' }, 403);
      return response({ check_runs: checkRuns });
    }
    if (parsed.pathname.endsWith('/contents/AGENTS.md')) return response({ encoding: 'base64', content: Buffer.from('trusted instructions').toString('base64') });
    if (parsed.pathname.endsWith('/contents/docs/knowledge/README.md')) return response({}, 404);
    if (parsed.pathname.endsWith('/issues/42/comments') && (options.method ?? 'GET') === 'GET') return response(comments);
    if (parsed.pathname.endsWith('/issues/42/comments') && options.method === 'POST') return response({ id: 9876, html_url: 'https://github.com/TitoStauffer/CashIn/pull/42#issuecomment-9876' });
    if (parsed.pathname.endsWith('/issues/comments/81') && options.method === 'PATCH') return response({ id: 81, html_url: 'https://example.test/comment/81' });
    throw new Error(`Unexpected request: ${options.method ?? 'GET'} ${parsed.pathname}`);
  };
}

test('formats reports with the matching signature, status and commit for all agents', () => {
  for (const [agentName, signature] of Object.entries(REPORT_AGENT_SIGNATURES)) {
    const body = formatPullRequestReport({ ...baseReport, agentName });
    assert.ok(body.includes(`### ${signature}`));
    assert.match(body, /\*\*Status:\*\* APPROVED/);
    assert.ok(body.includes(`**Commit:** \`${baseReport.commitSha}\``));
    assert.ok(body.endsWith(baseReport.reportMarkdown));
  }
});

test('discovers the repository installation and publishes using an installation token', async () => {
  const authCalls = [];
  const requests = [];
  const publisher = new GitHubReportPublisher({
    appId: '5397579', privateKey: 'test-private-key', owner: 'TitoStauffer', repository: 'CashIn',
    authFactory: fakeAuthFactory(authCalls), fetchImpl: fakeGitHub(requests),
  });

  const result = await publisher.publishReport(baseReport);

  assert.deepEqual(authCalls, [{ type: 'app' }, { type: 'installation', installationId: 173427336 }]);
  assert.ok(requests.some(({ url }) => url === 'https://api.github.com/repos/TitoStauffer/CashIn/installation'));
  assert.ok(requests.some(({ url, options }) => url.endsWith('/issues/42/comments') && options.method === 'POST'));
  assert.ok(requests.some(({ url, options }) => url.endsWith('/issues/42/comments') && options.method === 'POST'
    && JSON.parse(options.body).body === formatPullRequestReport(baseReport)));
  assert.ok(requests.some(({ options }) => options.headers.Authorization === 'Bearer simulated-installation-token'));
  assert.deepEqual(result, {
    commentId: 9876,
    htmlUrl: 'https://github.com/TitoStauffer/CashIn/pull/42#issuecomment-9876',
    repository: 'TitoStauffer/CashIn', pullRequestNumber: 42, reusedComment: false,
  });
});

test('uses a configured installation ID without making an app discovery request', async () => {
  const authCalls = [];
  const requests = [];
  const publisher = new GitHubReportPublisher({
    appId: '5397579', privateKey: 'test-private-key', owner: 'TitoStauffer', repository: 'CashIn',
    installationId: '173427336', authFactory: fakeAuthFactory(authCalls), fetchImpl: fakeGitHub(requests),
  });

  await publisher.publishReport(baseReport);

  assert.deepEqual(authCalls, [{ type: 'app' }, { type: 'installation', installationId: 173427336 }]);
  assert.ok(!requests.some(({ url }) => url.endsWith('/installation')));
});

test('rejects a stale commit SHA without publishing a comment', async () => {
  const requests = [];
  const stalePr = { ...currentPr, head: { sha: 'b'.repeat(40) } };
  const publisher = new GitHubReportPublisher({
    appId: '5397579', privateKey: 'test-private-key', owner: 'TitoStauffer', repository: 'CashIn',
    installationId: '173427336', authFactory: fakeAuthFactory([]), fetchImpl: fakeGitHub(requests, { pr: stalePr }),
  });

  await assert.rejects(publisher.publishReport(baseReport), /no longer points to the supplied commit SHA/);
  assert.ok(!requests.some(({ options }) => options.method === 'POST'));
});

test('updates an existing App-authored report marker for the same stage and SHA', async () => {
  const requests = [];
  const existingBody = formatPullRequestReport(baseReport);
  const comments = [{ id: 81, body: existingBody, updated_at: '2026-10-21T10:00:00Z', user: { login: 'cashin-devagents[bot]' } }];
  const publisher = new GitHubReportPublisher({
    appId: '5397579', privateKey: 'test-private-key', owner: 'TitoStauffer', repository: 'CashIn',
    installationId: '173427336', authFactory: fakeAuthFactory([]), fetchImpl: fakeGitHub(requests, { comments }),
  });

  const result = await publisher.publishReport(baseReport);

  assert.ok(requests.some(({ url, options }) => url.endsWith('/issues/comments/81') && options.method === 'PATCH'
    && JSON.parse(options.body).body === formatPullRequestReport(baseReport)));
  assert.equal(requests.filter(({ options }) => options.method === 'POST').length, 0);
  assert.equal(result.reusedComment, true);
});

test('refuses to publish an agent report when review inputs changed after analysis', async () => {
  const requests = [];
  const publisher = new GitHubReportPublisher({
    appId: '5397579', privateKey: 'test-private-key', owner: 'TitoStauffer', repository: 'CashIn',
    installationId: '173427336', authFactory: fakeAuthFactory([]), fetchImpl: fakeGitHub(requests, { changePrAfterFirstRead: true }),
  });

  await assert.rejects(publisher.publishReport(baseReport), /changed before the agent report could be published/);
  assert.ok(!requests.some(({ options }) => options.method === 'POST'));
});

test('handles GitHub API errors without exposing response details or tokens', async () => {
  const publisher = new GitHubReportPublisher({
    appId: '5397579', privateKey: 'test-private-key', owner: 'TitoStauffer', repository: 'CashIn',
    installationId: '173427336', authFactory: fakeAuthFactory([]),
    fetchImpl: async () => response({ message: 'Resource not accessible by integration' }, 403),
  });

  await assert.rejects(publisher.publishReport(baseReport), (error) => {
    assert.match(error.message, /403/);
    assert.ok(!error.message.includes('Resource not accessible by integration'));
    assert.ok(!error.message.includes('simulated-installation-token'));
    return true;
  });
});

test('rejects invalid report inputs before authenticating', async () => {
  const authCalls = [];
  const publisher = new GitHubReportPublisher({
    appId: '5397579', privateKey: 'test-private-key', owner: 'TitoStauffer', repository: 'CashIn',
    installationId: '173427336', authFactory: fakeAuthFactory(authCalls), fetchImpl: async () => response({}),
  });

  await assert.rejects(publisher.publishReport({ ...baseReport, status: ' ' }), /status must not be empty/);
  assert.equal(authCalls.length, 0);
});
