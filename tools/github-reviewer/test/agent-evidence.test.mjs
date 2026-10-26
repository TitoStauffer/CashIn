import assert from 'node:assert/strict';
import test from 'node:test';
import { agentReportMarker, computeAgentContextHash, formatFormalReviewEvidence, hasLaterChangeRequest, latestCurrentFormalReview, parseStoredAgentComment, parseStoredFormalReview } from '../dist/agent-evidence.js';
import { formatPullRequestReport } from '../dist/github-report-publisher.js';

const sha = 'a'.repeat(40);
const bot = 'cashin-devagents[bot]';

test('parses only structured reports authored by the App and bound to the expected SHA', () => {
  const result = { agentName: 'qa', pullRequestNumber: 26, commitSha: sha, status: 'APPROVED', reportMarkdown: '**Verificações de QA:**\n- Check CI passou.' };
  const comment = { user: { login: bot }, body: formatPullRequestReport(result) };

  assert.equal(agentReportMarker('qa', sha), `<!-- cashin-agent-report:v1 stage=qa sha=${sha} -->`);
  assert.equal(parseStoredAgentComment(comment, 'qa', sha, 'cashin-devagents').decision, 'APPROVED');
  assert.equal(parseStoredAgentComment(comment, 'qa', 'b'.repeat(40), 'cashin-devagents'), undefined);
  assert.equal(parseStoredAgentComment({ ...comment, user: { login: 'a-user' } }, 'qa', sha, 'cashin-devagents'), undefined);
  assert.equal(parseStoredAgentComment({ ...comment, body: comment.body.replace('Verificações de QA', 'QA') }, 'qa', sha, 'cashin-devagents'), undefined);
});

test('formal review result is recoverable only from latest App review on the current SHA', () => {
  const result = { stage: 'codeReview', decision: 'APPROVED', commitSha: sha, reportMarkdown: '### Code Review — APPROVED\nNenhum bloqueio identificado.' };
  const review = { user: { login: bot }, commit_id: sha, state: 'APPROVED', submitted_at: '2026-10-21T10:00:00Z', body: formatFormalReviewEvidence(result) };
  assert.equal(parseStoredFormalReview(review, sha, 'cashin-devagents').decision, 'APPROVED');
  assert.equal(parseStoredFormalReview({ ...review, commit_id: 'b'.repeat(40) }, sha, 'cashin-devagents'), undefined);
  assert.equal(latestCurrentFormalReview([review, { ...review, commit_id: 'b'.repeat(40), submitted_at: '2026-10-21T11:00:00Z' }], sha, 'cashin-devagents'), undefined);
  assert.equal(hasLaterChangeRequest([{ user: { login: 'human-reviewer' }, commit_id: sha, state: 'CHANGES_REQUESTED', submitted_at: '2026-10-21T11:01:00Z' }], review, sha, 'cashin-devagents'), true);
  assert.equal(hasLaterChangeRequest([{ user: { login: 'human-reviewer' }, commit_id: sha, state: 'COMMENTED', submitted_at: '2026-10-21T11:01:00Z' }], review, sha, 'cashin-devagents'), false);
});

test('QA and Coordinator report markers use separate stage identities', () => {
  const qa = formatPullRequestReport({ agentName: 'qa', pullRequestNumber: 26, commitSha: sha, status: 'APPROVED', reportMarkdown: '## Verificações de QA\n- Evidência' });
  const qg = formatPullRequestReport({ agentName: 'qualityGate', pullRequestNumber: 26, commitSha: sha, status: 'APPROVED', reportMarkdown: '## Checks verificados\n- Evidência' });
  assert.ok(qa.startsWith(agentReportMarker('qa', sha)));
  assert.ok(qg.startsWith(agentReportMarker('qualityGate', sha)));
  assert.equal(parseStoredAgentComment({ user: { login: bot }, body: qg }, 'qa', sha, 'cashin-devagents'), undefined);
});

test('evidence markers change when PR metadata or the review input changes without a new HEAD SHA', () => {
  const firstContext = 'c'.repeat(64);
  const editedContext = 'd'.repeat(64);
  const report = { agentName: 'qa', pullRequestNumber: 26, commitSha: sha, contextHash: firstContext, status: 'APPROVED', reportMarkdown: '## Verificações de QA\n- Evidência' };
  const comment = { user: { login: bot }, body: formatPullRequestReport(report) };
  assert.equal(parseStoredAgentComment(comment, 'qa', sha, 'cashin-devagents', firstContext).decision, 'APPROVED');
  assert.equal(parseStoredAgentComment(comment, 'qa', sha, 'cashin-devagents', editedContext), undefined);
});

test('review fingerprint changes when diff, CI/Sonar evidence, instructions, or base commit changes', () => {
  const pr = { title: 'PR', html_url: 'https://example.test/1', body: '', head: { sha }, base: { ref: 'master', sha: 'b'.repeat(40) } };
  const inputs = { diff: 'diff A', checks: { api: 'PASSED', web: 'PASSED', githubReviewer: 'PASSED', sonarQube: 'PASSED', sonarCloud: 'PASSED' }, repositoryInstructions: 'rules A', sourceFiles: [] };
  const current = computeAgentContextHash('owner/repo', 1, pr, inputs);

  assert.notEqual(computeAgentContextHash('owner/repo', 1, pr, { ...inputs, diff: 'diff B' }), current);
  assert.notEqual(computeAgentContextHash('owner/repo', 1, pr, { ...inputs, checks: { ...inputs.checks, sonarQube: 'FAILED' } }), current);
  assert.notEqual(computeAgentContextHash('owner/repo', 1, pr, { ...inputs, repositoryInstructions: 'rules B' }), current);
  assert.notEqual(computeAgentContextHash('owner/repo', 1, pr, { ...inputs, sourceFiles: [{ path: 'src/a.ts', revision: 'head', content: 'source A' }] }), current);
  assert.notEqual(computeAgentContextHash('owner/repo', 1, pr, { ...inputs, vaultContext: [{ path: 'docs/knowledge/current-state.md', revision: 'head', content: 'state A' }] }), current);
  assert.notEqual(computeAgentContextHash('owner/repo', 1, { ...pr, base: { ref: 'master', sha: 'c'.repeat(40) } }, inputs), current);
});

test('checkbox updates preserve evidence while changes to acceptance text invalidate it', () => {
  const pr = { title: 'PR', body: '- [ ] QA aprovado\n- [ ] Validar precisão', head: { sha }, base: { sha: 'b'.repeat(40) } };
  const inputs = { diff: '', checks: {}, sourceFiles: [], repositoryInstructions: '' };
  const current = computeAgentContextHash('owner/repo', 1, pr, inputs);
  assert.equal(computeAgentContextHash('owner/repo', 1, { ...pr, body: '- [x] QA aprovado\n- [x] Validar precisão' }, inputs), current);
  assert.notEqual(computeAgentContextHash('owner/repo', 1, { ...pr, body: '- [x] QA aprovado\n- [x] Remover precisão' }, inputs), current);
});
