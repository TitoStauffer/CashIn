import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, access, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { evaluateDeterministicQualityGate, mayRetryInconclusive, selectReusableStageResult } from '../dist/agent-stage-policy.js';
import { LIGHT_TRACK_RULE } from '../dist/review-track.js';
import { formatFormalReviewEvidence } from '../dist/agent-evidence.js';
import { formatPullRequestReport } from '../dist/github-report-publisher.js';
import { REVIEW_RISK_AREAS, validateAgentResultCompleteness } from '../dist/agent-result-validation.js';

// The path is a runtime file on purpose: these cases are about the full track, where QA is required.
// `src/change.ts` used to be ambiguous — it is outside `apps/*/src`, so it now classifies as the light
// track and would excuse the very QA evidence these cases prove to be mandatory.
const context = { commitSha: 'a'.repeat(40), contextHash: 'b'.repeat(64), botLogin: 'cashin-devagents', changedFiles: ['apps/api/src/change.ts'], acceptanceCriteria: ['Preservar contrato'] };
const checks = { api: 'PASSED', web: 'PASSED', githubReviewer: 'PASSED', sonarQube: 'PASSED', sonarCloud: 'PASSED' };
function result(stage, decision = 'APPROVED') {
  return {
    stage, decision, commitSha: context.commitSha, contextHash: context.contextHash,
    reportMarkdown: stage === 'qa' ? '**Verificações de QA:**\n- Contrato validado pelo teste de integração.' : `### Code Review — ${decision}\nAnálise completa.`,
    evidence: {
      reviewComplete: decision !== 'INCONCLUSIVE', changedFilesReviewed: context.changedFiles,
      riskAreas: REVIEW_RISK_AREAS.map(area => ({ area, status: 'REVIEWED', evidence: 'Contrato e casos extremos analisados no diff.' })),
      findings: [],
      acceptanceCriteria: stage === 'qa' ? [{ criterion: context.acceptanceCriteria[0], status: decision === 'INCONCLUSIVE' ? 'INCONCLUSIVE' : 'PASSED', evidence: 'Teste de integração do contrato.' }] : [],
    },
  };
}
function comment(value, time = '2026-11-01T10:00:00Z') {
  return { user: { login: 'cashin-devagents[bot]' }, updated_at: time, body: formatPullRequestReport({ agentName: value.stage, pullRequestNumber: 1, commitSha: value.commitSha, contextHash: value.contextHash, status: value.decision, reportMarkdown: value.reportMarkdown, evidence: value.evidence }) };
}
function review(value = result('codeReview'), time = '2026-11-01T09:00:00Z') {
  return { user: { login: 'cashin-devagents[bot]' }, commit_id: value.commitSha, state: value.decision, submitted_at: time, body: formatFormalReviewEvidence(value) };
}
function input() {
  const priorResults = [result('codeReview'), result('qa')];
  return { ...context, checks, priorResults, reviews: [review(priorResults[0])], comments: [comment(priorResults[1])] };
}

test('deterministic coordinator consolidates current authenticated approvals without inventing QA', () => {
  const outcome = evaluateDeterministicQualityGate(input());
  assert.equal(outcome.decision, 'APPROVED');
  assert.deepEqual(validateAgentResultCompleteness(outcome, { stage: 'qualityGate', ...context }), []);
  assert.match(outcome.reportMarkdown, /Nenhuma chamada de modelo/);
  assert.deepEqual(outcome.evidence.acceptanceCriteria, []);
});

test('coordinator fails closed for missing, stale, incomplete, and foreign evidence', () => {
  const cases = [
    { comments: [] }, { reviews: [] }, { contextHash: 'c'.repeat(64) }, { commitSha: 'd'.repeat(40) },
    { priorResults: [result('qa'), result('qa')] },
    { comments: [{ ...comment(result('qa')), user: { login: 'untrusted' } }] },
    { reviews: [review({ ...result('codeReview'), evidence: { ...result('codeReview').evidence, changedFilesReviewed: [] } })] },
    { comments: [comment({ ...result('qa'), evidence: { ...result('qa').evidence, acceptanceCriteria: [] } })] },
  ];
  for (const change of cases) assert.notEqual(evaluateDeterministicQualityGate({ ...input(), ...change }).decision, 'APPROVED', JSON.stringify(change));
});

// DEV-116: the light track drops the QA requirement and nothing else. The Coordinator still runs,
// still consolidates the formal Code Review, and its report states the track and why.
//
// The published evidence has to name the same files the stage was given, so a track case builds its own
// Code Review result over that file list instead of reusing the runtime fixture above.
function trackInput(changedFiles, extraComments = []) {
  const codeReview = {
    ...result('codeReview'),
    evidence: { ...result('codeReview').evidence, changedFilesReviewed: changedFiles ?? [] },
  };
  return {
    ...context,
    changedFiles,
    checks,
    priorResults: [codeReview],
    reviews: [review(codeReview)],
    comments: extraComments,
  };
}

test('coordinator approves the light track without QA and says so in the report', () => {
  const outcome = evaluateDeterministicQualityGate(trackInput(['AGENTS.md', 'docs/knowledge/current-state.md']));

  assert.equal(outcome.decision, 'APPROVED');
  assert.equal(outcome.reviewTrack, 'light');
  assert.match(outcome.reportMarkdown, /\*\*Trilho de revisão:\*\* leve\./);
  assert.match(outcome.reportMarkdown, /QA dispensado pelo trilho leve/);
  // The report is the durable App-signed justification for skipping a mandatory stage, so it must
  // quote the rule the classifier actually applies. Its first version named only apps/*/src, which
  // was already narrower than the implementation.
  assert.ok(outcome.reportMarkdown.includes(LIGHT_TRACK_RULE), outcome.reportMarkdown);
  assert.match(outcome.reportMarkdown, /lida da API do GitHub, não pelo corpo do Pull Request/);
});

test('coordinator still requires QA on the full track and names the runtime files', () => {
  const withoutQa = evaluateDeterministicQualityGate(trackInput(['docs/readme.md', 'apps/web/src/app.tsx']));

  assert.equal(withoutQa.reviewTrack, 'full');
  assert.equal(withoutQa.decision, 'INCONCLUSIVE');
  assert.match(withoutQa.reportMarkdown, /Evidência publicada de qa ausente/);
  assert.match(withoutQa.reportMarkdown, /`apps\/web\/src\/app\.tsx`/);
});

// Skipping QA is a decision about cost, not permission to drop evidence that exists. A refusal only
// counts when it is a complete report: QA that requests changes needs a failed criterion, so a malformed
// one is neither an approval nor a refusal — on this track, where QA is not required, it is ignored.
test('coordinator on the light track still blocks a QA that ran and refused', () => {
  const changedFiles = ['AGENTS.md'];
  const base = result('qa', 'CHANGES_REQUESTED');
  const refused = {
    ...base,
    evidence: {
      ...base.evidence,
      changedFilesReviewed: changedFiles,
      acceptanceCriteria: [{ criterion: context.acceptanceCriteria[0], status: 'FAILED', evidence: 'Critério reprovado no cenário de contrato.' }],
    },
  };
  const outcome = evaluateDeterministicQualityGate(trackInput(changedFiles, [comment(refused)]));

  assert.equal(outcome.reviewTrack, 'light');
  assert.equal(outcome.decision, 'CHANGES_REQUESTED');
  assert.match(outcome.reportMarkdown, /qa: CHANGES_REQUESTED/);
});

// An unusable changed-file list is absence of evidence, not a documentation change. An empty list is
// still a list, so it classifies as the full track and then fails for the QA it cannot show; an absent
// list means the stage itself is broken, and the Coordinator refuses to produce a verdict at all.
test('coordinator falls back to the full track for an empty changed-file list', () => {
  const outcome = evaluateDeterministicQualityGate(trackInput([]));

  assert.equal(outcome.reviewTrack, 'full');
  assert.equal(outcome.decision, 'INCONCLUSIVE');
  assert.match(outcome.reportMarkdown, /Evidência publicada de qa ausente/);
});

test('coordinator refuses to decide without the changed-file list that determines the track', () => {
  assert.throws(() => evaluateDeterministicQualityGate(trackInput(undefined)), /changed-file list that determines the review track/);
});

test('coordinator blocks failed checks and never approves pending or missing checks', () => {
  for (const name of Object.keys(checks)) {
    assert.equal(evaluateDeterministicQualityGate({ ...input(), checks: { ...checks, [name]: 'FAILED' } }).decision, 'CHANGES_REQUESTED');
    for (const state of ['PENDING', 'UNKNOWN', undefined]) assert.equal(evaluateDeterministicQualityGate({ ...input(), checks: { ...checks, [name]: state } }).decision, 'INCONCLUSIVE');
  }
});

test('later rejection or inconclusive review invalidates old approval', () => {
  const rejection = { ...review(), user: { login: 'maintainer' }, state: 'CHANGES_REQUESTED', submitted_at: '2026-11-01T11:00:00Z' };
  assert.equal(evaluateDeterministicQualityGate({ ...input(), reviews: [review(), rejection] }).decision, 'CHANGES_REQUESTED');
  const later = comment(result('codeReview', 'INCONCLUSIVE'), '2026-11-01T12:00:00Z');
  assert.equal(evaluateDeterministicQualityGate({ ...input(), comments: [...input().comments, later] }).decision, 'INCONCLUSIVE');
});

test('same SHA/context reuses inconclusive QA and review instead of starting another model call', () => {
  for (const stage of ['qa', 'codeReview']) {
    const value = result(stage, 'INCONCLUSIVE');
    const comments = [comment(value, '2026-11-01T12:00:00Z')];
    const reused = selectReusableStageResult(stage, context, [review()], comments);
    assert.equal(reused.decision, 'INCONCLUSIVE');
    assert.equal(selectReusableStageResult(stage, { ...context, contextHash: 'c'.repeat(64) }, [review()], comments), undefined);
    assert.equal(selectReusableStageResult(stage, { ...context, commitSha: 'd'.repeat(40) }, [review()], comments), undefined);
  }
});

test('an approved comment never substitutes formal review and newer formal approval supersedes old inconclusive', () => {
  assert.equal(selectReusableStageResult('codeReview', context, [], [comment(result('codeReview'))]), undefined);
  assert.equal(selectReusableStageResult('codeReview', context, [review(result('codeReview'), '2026-11-01T13:00:00Z')], [comment(result('codeReview', 'INCONCLUSIVE'))]).decision, 'APPROVED');
});

test('retry requires explicit manual dispatch and does not activate from CI reruns', () => {
  assert.equal(mayRetryInconclusive('workflow_dispatch', { inputs: { retry_inconclusive: true } }, 'true'), true);
  assert.equal(mayRetryInconclusive('workflow_dispatch', { inputs: { retry_inconclusive: 'true' } }, 'true'), true);
  for (const args of [
    ['workflow_run', { inputs: { retry_inconclusive: true } }, 'true'],
    ['workflow_dispatch', { inputs: { retry_inconclusive: false } }, 'true'],
    ['workflow_dispatch', { inputs: { retry_inconclusive: true } }, undefined],
    ['workflow_dispatch', null, 'true'],
  ]) assert.equal(mayRetryInconclusive(...args), false);
});

test('stage CLI exits inconclusive on API failure without producing an approved artifact or invoking a model', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-stage-failure-'));
  try {
    const eventPath = join(directory, 'event.json');
    const interceptor = join(directory, 'offline.mjs');
    await writeFile(eventPath, JSON.stringify({ inputs: { pr_number: '1' } }));
    await writeFile(interceptor, 'globalThis.fetch = async () => { throw new Error("Simulated API unavailable"); };');
    await assert.rejects(promisify(execFile)(process.execPath, ['--import', pathToFileURL(interceptor).href, resolve('dist/agent-stage-cli.js')], {
      env: { ...process.env, GITHUB_REPOSITORY: 'owner/repo', GITHUB_EVENT_PATH: eventPath, GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_TOKEN: 'offline-test-token', GITHUB_WORKSPACE: directory, AGENT_STAGE: 'qualityGate', CASHIN_APP_BOT_LOGIN: context.botLogin },
    }), error => error.code === 2 && /Simulated API unavailable|cannot be evaluated/.test(error.stderr));
    await assert.rejects(access(join(directory, 'agent-result.json')));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
