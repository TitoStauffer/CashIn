import assert from 'node:assert/strict';
import test from 'node:test';
import { GitHubReportPublisher, formatPullRequestReport, REPORT_AGENT_SIGNATURES } from '../dist/github-report-publisher.js';

const baseReport = {
  agentName: 'qa',
  pullRequestNumber: 42,
  commitSha: 'a'.repeat(40),
  status: 'APPROVED',
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

test('formats reports with the matching signature, status and commit for all agents', () => {
  for (const [agentName, signature] of Object.entries(REPORT_AGENT_SIGNATURES)) {
    const body = formatPullRequestReport({ ...baseReport, agentName });
    assert.ok(body.startsWith(`### ${signature}`));
    assert.match(body, /\*\*Status:\*\* APPROVED/);
    assert.ok(body.includes(`**Commit:** \`${baseReport.commitSha}\``));
    assert.ok(body.endsWith(baseReport.reportMarkdown));
  }
});

test('discovers the repository installation and publishes using an installation token', async () => {
  const authCalls = [];
  const requests = [];
  const responses = [
    { id: 173427336 },
    { state: 'open', head: { sha: baseReport.commitSha } },
    { id: 9876, html_url: 'https://github.com/TitoStauffer/CashIn/pull/42#issuecomment-9876' },
  ];
  const publisher = new GitHubReportPublisher({
    appId: '5397579',
    privateKey: 'test-private-key',
    owner: 'TitoStauffer',
    repository: 'CashIn',
    authFactory: fakeAuthFactory(authCalls),
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return response(responses.shift());
    },
  });

  const result = await publisher.publishReport(baseReport);

  assert.deepEqual(authCalls, [{ type: 'app' }, { type: 'installation', installationId: 173427336 }]);
  assert.equal(requests.length, 3);
  assert.equal(requests[0].url, 'https://api.github.com/repos/TitoStauffer/CashIn/installation');
  assert.equal(requests[0].options.headers.Authorization, 'Bearer simulated-app-jwt');
  assert.equal(requests[1].options.headers.Authorization, 'Bearer simulated-installation-token');
  assert.equal(requests[2].url, 'https://api.github.com/repos/TitoStauffer/CashIn/issues/42/comments');
  assert.equal(JSON.parse(requests[2].options.body).body, formatPullRequestReport(baseReport));
  assert.deepEqual(result, {
    commentId: 9876,
    htmlUrl: 'https://github.com/TitoStauffer/CashIn/pull/42#issuecomment-9876',
    repository: 'TitoStauffer/CashIn',
    pullRequestNumber: 42,
  });
});

test('uses a configured installation ID without making an app discovery request', async () => {
  const authCalls = [];
  const requests = [];
  const responses = [
    { state: 'open', head: { sha: baseReport.commitSha } },
    { id: 55, html_url: 'https://example.test/comment/55' },
  ];
  const publisher = new GitHubReportPublisher({
    appId: '5397579',
    privateKey: 'test-private-key',
    owner: 'TitoStauffer',
    repository: 'CashIn',
    installationId: '173427336',
    authFactory: fakeAuthFactory(authCalls),
    fetchImpl: async (url) => {
      requests.push(url);
      return response(responses.shift());
    },
  });

  await publisher.publishReport(baseReport);

  assert.deepEqual(authCalls, [{ type: 'installation', installationId: 173427336 }]);
  assert.equal(requests.length, 2);
  assert.ok(!requests.some((url) => url.endsWith('/installation')));
});

test('rejects a stale commit SHA without publishing a comment', async () => {
  const requests = [];
  const publisher = new GitHubReportPublisher({
    appId: '5397579',
    privateKey: 'test-private-key',
    owner: 'TitoStauffer',
    repository: 'CashIn',
    installationId: '173427336',
    authFactory: fakeAuthFactory([]),
    fetchImpl: async (url) => {
      requests.push(url);
      return response({ state: 'open', head: { sha: 'b'.repeat(40) } });
    },
  });

  await assert.rejects(publisher.publishReport(baseReport), /no longer points to the supplied commit SHA/);
  assert.equal(requests.length, 1);
});

test('handles GitHub API errors without exposing response details or tokens', async () => {
  const publisher = new GitHubReportPublisher({
    appId: '5397579',
    privateKey: 'test-private-key',
    owner: 'TitoStauffer',
    repository: 'CashIn',
    installationId: '173427336',
    authFactory: fakeAuthFactory([]),
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
    appId: '5397579',
    privateKey: 'test-private-key',
    owner: 'TitoStauffer',
    repository: 'CashIn',
    installationId: '173427336',
    authFactory: fakeAuthFactory(authCalls),
    fetchImpl: async () => response({}),
  });

  await assert.rejects(publisher.publishReport({ ...baseReport, status: ' ' }), /status must not be empty/);
  assert.equal(authCalls.length, 0);
});
