import assert from 'node:assert/strict';
import test from 'node:test';
import { assertPullRequestContainsBase } from '../dist/branch-freshness.js';

const base = 'a'.repeat(40);
const head = 'b'.repeat(40);
const pullRequest = { base: { sha: base }, head: { sha: head } };

function github(status, responseStatus = 200) {
  return async (url) => {
    assert.equal(url, `https://api.github.com/repos/owner/repo/compare/${base}...${head}`);
    return new Response(JSON.stringify({ status }), {
      status: responseStatus,
      headers: { 'Content-Type': 'application/json' },
    });
  };
}

test('allows a PR branch that contains the current base commit', async () => {
  await assert.doesNotReject(assertPullRequestContainsBase(github('ahead'), 'owner/repo', pullRequest, 'token'));
  await assert.doesNotReject(assertPullRequestContainsBase(github('identical'), 'owner/repo', pullRequest, 'token'));
});

test('blocks agent orchestration when the PR branch is behind or diverged', async () => {
  await assert.rejects(assertPullRequestContainsBase(github('behind'), 'owner/repo', pullRequest, 'token'), /updated with master.*behind/);
  await assert.rejects(assertPullRequestContainsBase(github('diverged'), 'owner/repo', pullRequest, 'token'), /updated with master.*diverged/);
});

test('fails closed for invalid references or an unknown comparison state', async () => {
  await assert.rejects(assertPullRequestContainsBase(github('ahead'), 'owner/repo', { base: {}, head: { sha: head } }, 'token'), /base SHA/);
  await assert.rejects(assertPullRequestContainsBase(github('unknown'), 'owner/repo', pullRequest, 'token'), /did not confirm/);
});
