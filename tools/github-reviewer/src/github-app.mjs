import { createSign } from 'node:crypto';

const API_BASE = 'https://api.github.com';
const API_VERSION = '2022-11-28';
const OWNER = 'TitoStauffer';
const REPOSITORY = 'CashIn';

export function createAppJwt(appId, privateKey, now = Math.floor(Date.now() / 1000)) {
  const header = encodeJson({ alg: 'RS256', typ: 'JWT' });
  const payload = encodeJson({ iat: now - 60, exp: now + 540, iss: appId });
  const unsigned = `${header}.${payload}`;
  const signer = createSign('RSA-SHA256');
  signer.update(unsigned);
  signer.end();
  return `${unsigned}.${signer.sign(privateKey, 'base64url')}`;
}

export function validateReview(decision, body) {
  if (!['APPROVED', 'CHANGES_REQUESTED'].includes(decision)) {
    throw new Error('Formal review decision must be APPROVED or CHANGES_REQUESTED.');
  }
  if (typeof body !== 'string' || body.trim().length === 0) {
    throw new Error('Formal review body must not be empty.');
  }
  if (!body.includes(`Code Review — ${decision}`) && !body.includes(`Code Review - ${decision}`)) {
    throw new Error(`Review body must declare the same decision: ${decision}.`);
  }
}

export async function verifyAccess({ appId, installationId, privateKey, pullRequestNumber, fetchImpl = fetch }) {
  if (!Number.isSafeInteger(Number(pullRequestNumber)) || Number(pullRequestNumber) < 1) {
    throw new Error('Pull request number must be a positive integer.');
  }

  const appJwt = createAppJwt(appId, privateKey);
  const app = await request(fetchImpl, '/app', appJwt);
  const installationTokenResponse = await request(
    fetchImpl,
    `/app/installations/${encodeURIComponent(installationId)}/access_tokens`,
    appJwt,
    { method: 'POST', body: '{}' },
  );
  const installationToken = installationTokenResponse.token;
  if (typeof installationToken !== 'string' || installationToken.length === 0) {
    throw new Error('GitHub did not return an installation token.');
  }

  const pr = await request(
    fetchImpl,
    `/repos/${OWNER}/${REPOSITORY}/pulls/${Number(pullRequestNumber)}`,
    installationToken,
  );
  if (pr.state !== 'open') {
    throw new Error(`Pull request #${pullRequestNumber} is not open.`);
  }
  if ([app.slug, `${app.slug}[bot]`].includes(pr.user?.login)) {
    throw new Error('The GitHub App cannot approve a pull request authored by itself.');
  }
  if (typeof pr.head?.sha !== 'string' || pr.head.sha.length === 0) {
    throw new Error('GitHub did not return the pull request head commit.');
  }

  return { app, installationToken, pullRequest: pr };
}

export async function submitReview({ appId, installationId, privateKey, pullRequestNumber, decision, body, fetchImpl = fetch }) {
  validateReview(decision, body);
  const { app, installationToken, pullRequest } = await verifyAccess({
    appId,
    installationId,
    privateKey,
    pullRequestNumber,
    fetchImpl,
  });

  const review = await request(
    fetchImpl,
    `/repos/${OWNER}/${REPOSITORY}/pulls/${Number(pullRequestNumber)}/reviews`,
    installationToken,
    {
      method: 'POST',
      body: JSON.stringify({
        body: body.trim(),
        commit_id: pullRequest.head.sha,
        event: decision === 'APPROVED' ? 'APPROVE' : 'REQUEST_CHANGES',
      }),
    },
  );

  return {
    reviewId: review.id,
    state: review.state,
    htmlUrl: review.html_url,
    commitId: review.commit_id,
    reviewer: review.user?.login ?? `${app.slug}[bot]`,
  };
}

async function request(fetchImpl, path, token, options = {}) {
  const response = await fetchImpl(`${API_BASE}${path}`, {
    method: options.method ?? 'GET',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': API_VERSION,
      ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(options.body === undefined ? {} : { body: options.body }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = typeof payload.message === 'string' ? payload.message : `HTTP ${response.status}`;
    throw new Error(`GitHub API request failed (${response.status}): ${message}`);
  }
  return payload;
}

function encodeJson(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}
