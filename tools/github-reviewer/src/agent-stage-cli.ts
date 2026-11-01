import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { AgentStageResult } from './agent-orchestrator.js';
import { requestGitHubApi } from './github-api-client.js';
import { loadAgentReviewInputs } from './agent-review-inputs.js';
import { extractAcceptanceCriteria, isAgentStageResult, validateAgentResultCompleteness } from './agent-result-validation.js';
import { computeAgentContextHash, hasLaterChangeRequest, latestCurrentFormalReview } from './agent-evidence.js';
import { executeCodexAgent, type CheckSummary, type FormalCodeReviewEvidence } from './codex-cli-agent.js';
import { evaluateDeterministicQualityGate, mayRetryInconclusive, selectReusableStageResult, type StageEvidenceContext } from './agent-stage-policy.js';
import { resolveWorkflowEvent } from './workflow-event.js';
import { createInjectionBlockedResult, detectPullRequestPromptInjection } from './prompt-injection-guard.js';

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : 'Codex stage could not complete.';
  process.stderr.write(`${message}\n`);
  process.exitCode = 2;
}

async function main(): Promise<void> {
  const repository = required('GITHUB_REPOSITORY');
  const [owner, repositoryName, unexpected] = repository.split('/');
  if (!owner || !repositoryName || unexpected) throw new Error('Invalid GITHUB_REPOSITORY.');
  const token = required('GITHUB_TOKEN');
  const payload = JSON.parse(await readFile(required('GITHUB_EVENT_PATH'), 'utf8')) as unknown;
  const resolution = await resolveWorkflowEvent({
    eventName: process.env.GITHUB_EVENT_NAME ?? '',
    payload,
    repository,
    botLogin: process.env.CASHIN_APP_BOT_LOGIN ?? '',
    token,
  });
  if (resolution.action !== 'evaluate' || !resolution.pullRequestNumber || !resolution.headSha) {
    throw new Error(`Pull Request cannot be evaluated: ${resolution.reason}`);
  }

  const stage = parseStage(required('AGENT_STAGE'));
  const prNumber = resolution.pullRequestNumber;
  const pullRequest = await readPullRequest(prNumber, repository, token);
  const head = asRecord(pullRequest.head);
  const base = asRecord(pullRequest.base);
  const sourceRepository = asRecord(head?.repo);
  if (pullRequest.state !== 'open'
    || sourceRepository?.full_name !== repository
    || stringValue(base?.ref) !== 'master'
    || stringValue(head?.sha) !== resolution.headSha) {
    throw new Error('Pull Request is not an open internal PR targeting master at the resolved SHA.');
  }

  const reviewInputs = await loadAgentReviewInputs(fetch, repository, prNumber, pullRequest, token);
  const { diff, changedFiles, checks, checkRuns, repositoryInstructions, sourceFiles, vaultContext, ciConfiguration } = reviewInputs;
  const acceptanceCriteria = extractAcceptanceCriteria(stringValue(pullRequest.body) ?? '');
  if (diff.length > 350_000) throw new Error('Pull Request diff exceeds the supported review size.');
  // A title-triggered evaluation may precede CI completion; no model runs until every required check passes.
  assertRequiredChecksPassed(checks);

  const contextHash = computeAgentContextHash(repository, prNumber, pullRequest, reviewInputs);
  if (detectPullRequestPromptInjection({
    title: stringValue(pullRequest.title) ?? '',
    body: stringValue(pullRequest.body) ?? '',
    diff,
    sourceFiles: [...vaultContext, ...sourceFiles, ...(ciConfiguration ?? []), { content: JSON.stringify(checkRuns.map(({ actions }) => actions)) }],
  })) {
    const blocked = { ...createInjectionBlockedResult(stage, resolution.headSha, changedFiles, acceptanceCriteria), contextHash };
    await writeStageResult(blocked, prNumber, 'deterministic');
    process.exitCode = 2;
    return;
  }

  const priorResults = await readPriorResults(stage, contextHash, resolution.headSha, changedFiles, acceptanceCriteria);
  const formalCodeReview = stage !== 'codeReview'
    ? await readFormalReviewEvidence(prNumber, resolution.headSha, repository, token, contextHash, changedFiles, acceptanceCriteria)
    : undefined;
  if (priorResults.some((result) => result.commitSha.toLowerCase() !== resolution.headSha?.toLowerCase())) {
    throw new Error('A previous agent result belongs to a different Pull Request SHA.');
  }
  if (stage === 'qualityGate' && priorResults.find((result) => result.stage === 'qa')?.decision !== 'APPROVED') {
    throw new Error('Quality Gate Coordinator requires an approved QA result for the current SHA.');
  }

  const evidenceContext = { commitSha: resolution.headSha, contextHash, botLogin: required('CASHIN_APP_BOT_LOGIN'), changedFiles, acceptanceCriteria };
  if (stage === 'qualityGate') {
    await verifyContextUnchanged(prNumber, repository, token, pullRequest, resolution.headSha, contextHash);
    const [reviews, comments] = await Promise.all([
      githubJsonPages<Array<Record<string, unknown>>>(`/repos/${repository}/pulls/${prNumber}/reviews`, token),
      githubJsonPages<Array<Record<string, unknown>>>(`/repos/${repository}/issues/${prNumber}/comments`, token),
    ]);
    const result = evaluateDeterministicQualityGate({ ...evidenceContext, checks, reviews, comments, priorResults });
    await writeStageResult(result, prNumber, 'deterministic');
    process.exitCode = result.decision === 'APPROVED' ? 0 : result.decision === 'CHANGES_REQUESTED' ? 1 : 2;
    return;
  }
  const cachedResult = await readReusableResult(stage, prNumber, repository, token, evidenceContext);
  const retry = mayRetryInconclusive(process.env.GITHUB_EVENT_NAME ?? '', payload, process.env.AGENT_RETRY_INCONCLUSIVE);
  if (cachedResult && !(cachedResult.decision === 'INCONCLUSIVE' && retry)) {
    await verifyContextUnchanged(prNumber, repository, token, pullRequest, resolution.headSha, contextHash);
    if (stage !== 'codeReview') await readFormalReviewEvidence(prNumber, resolution.headSha, repository, token, contextHash, changedFiles, acceptanceCriteria);
    const currentResult = await readReusableResult(stage, prNumber, repository, token, evidenceContext);
    if (JSON.stringify(currentResult) !== JSON.stringify(cachedResult)) throw new Error('Published agent evidence changed during reuse.');
    await writeStageResult(cachedResult, prNumber, 'reused');
    process.exitCode = cachedResult.decision === 'APPROVED' ? 0 : cachedResult.decision === 'CHANGES_REQUESTED' ? 1 : 2;
    return;
  }

  const context = {
    repository,
    pullRequestNumber: prNumber,
    commitSha: resolution.headSha,
    executionId: `${process.env.GITHUB_RUN_ID ?? 'manual'}-${process.env.GITHUB_RUN_ATTEMPT ?? '1'}`,
    priorResults,
  };
  await writeWorkflowOutput('execution_source', 'model');
  await writeWorkflowOutput('model_calls', '1');
  const modelResult = await executeCodexAgent(stage, context, AbortSignal.timeout(20 * 60 * 1000), {
    pullRequest: {
      state: 'open',
      number: prNumber,
      title: stringValue(pullRequest.title) ?? '(sem título)',
      url: stringValue(pullRequest.html_url) ?? `https://github.com/${repository}/pull/${prNumber}`,
      body: stringValue(pullRequest.body) ?? '',
      headSha: resolution.headSha,
      baseBranch: 'master',
      diff,
    },
    changedFiles,
    checks,
    checkRuns,
    ciConfiguration,
    formalCodeReview,
    repositoryInstructions,
    vaultContext,
    sourceFiles,
  });
  const result = { ...modelResult, contextHash };
  await verifyHeadUnchanged(prNumber, resolution.headSha, repository, token);
  await verifyContextUnchanged(prNumber, repository, token, pullRequest, resolution.headSha, contextHash);
  if (stage !== 'codeReview') await readFormalReviewEvidence(prNumber, resolution.headSha, repository, token, contextHash, changedFiles, acceptanceCriteria);
  await writeStageResult(result, prNumber, 'model');
  process.exitCode = result.decision === 'APPROVED' ? 0 : result.decision === 'CHANGES_REQUESTED' ? 1 : 2;
}

async function writeStageResult(result: AgentStageResult, prNumber: number, source: 'model' | 'reused' | 'deterministic'): Promise<void> {
  await writeFile(resolve(required('GITHUB_WORKSPACE'), 'agent-result.json'), `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  await writeWorkflowOutput('decision', result.decision);
  await writeWorkflowOutput('commit_sha', result.commitSha);
  await writeWorkflowOutput('pr_number', String(prNumber));
  await writeWorkflowOutput('execution_source', source);
  await writeWorkflowOutput('model_calls', source === 'model' ? '1' : '0');
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `### Agent execution\n- Stage: ${result.stage}\n- Result: ${result.decision}\n- Source: ${source}\n- Model calls: ${source === 'model' ? 1 : 0}\n`);
  process.stdout.write(`Prepared ${result.stage} ${result.decision} result for PR #${prNumber} at the expected SHA.\n`);
}

async function readReusableResult(stage: 'codeReview' | 'qa', prNumber: number, repository: string, token: string, context: StageEvidenceContext): Promise<AgentStageResult | undefined> {
  const reviews = stage === 'codeReview'
    ? await githubJsonPages<Array<Record<string, unknown>>>(`/repos/${repository}/pulls/${prNumber}/reviews`, token) : [];
  const comments = await githubJsonPages<Array<Record<string, unknown>>>(`/repos/${repository}/issues/${prNumber}/comments`, token);
  return selectReusableStageResult(stage, context, reviews, comments);
}

async function readPriorResults(
  stage: 'codeReview' | 'qa' | 'qualityGate',
  expectedContextHash: string,
  commitSha: string,
  changedFiles: string[],
  acceptanceCriteria: string[],
): Promise<AgentStageResult[]> {
  const paths = stage === 'qa'
    ? [required('CODE_REVIEW_RESULT_PATH')]
    : stage === 'qualityGate'
      ? [required('CODE_REVIEW_RESULT_PATH'), required('QA_RESULT_PATH')]
      : [];
  const results: AgentStageResult[] = [];
  for (const [index, path] of paths.entries()) {
    const result: unknown = JSON.parse(await readFile(path, 'utf8'));
    if (!isAgentStageResult(result)
      || result.stage !== (index === 0 ? 'codeReview' : 'qa')
      || result.contextHash !== expectedContextHash
      || typeof result.reportMarkdown !== 'string'
      || validateAgentResultCompleteness(result, {
        stage: result.stage,
        commitSha,
        changedFiles,
        acceptanceCriteria,
      }).length > 0) throw new Error('A previous agent artifact is invalid or incomplete.');
    results.push(result);
  }
  if (results.some((result) => result.decision !== 'APPROVED')) throw new Error('A previous agent stage did not approve the current change.');
  return results;
}

async function readPullRequest(number: number, repository: string, token: string): Promise<Record<string, unknown>> {
  return githubJson(`/repos/${repository}/pulls/${number}`, token);
}

function assertRequiredChecksPassed(checks: CheckSummary): void {
  const missingOrFailed = Object.entries(checks).filter(([, state]) => state !== 'PASSED');
  if (missingOrFailed.length) throw new Error(`Required CI/Sonar evidence is not approved: ${missingOrFailed.map(([name, state]) => `${name}=${state}`).join(', ')}.`);
}

async function verifyContextUnchanged(
  prNumber: number, repository: string, token: string, initialPr: Record<string, unknown>, sha: string, expectedContextHash: string,
): Promise<void> {
  const currentPr = await readPullRequest(prNumber, repository, token);
  if (currentPr.state !== 'open'
    || stringValue(asRecord(currentPr.head)?.sha) !== sha
    || stringValue(currentPr.title) !== stringValue(initialPr.title)
    || stringValue(currentPr.html_url) !== stringValue(initialPr.html_url)
    || stringValue(asRecord(currentPr.base)?.ref) !== stringValue(asRecord(initialPr.base)?.ref)
    || stringValue(asRecord(currentPr.base)?.sha) !== stringValue(asRecord(initialPr.base)?.sha)) {
    throw new Error('Pull Request metadata changed during agent evaluation.');
  }
  const currentInputs = await loadAgentReviewInputs(fetch, repository, prNumber, currentPr, token);
  if (computeAgentContextHash(repository, prNumber, currentPr, currentInputs) !== expectedContextHash) {
    throw new Error('Pull Request review inputs changed during agent evaluation.');
  }
}

async function readFormalReviewEvidence(number: number, sha: string, repository: string, token: string, contextHash: string, changedFiles: string[], acceptanceCriteria: string[]): Promise<FormalCodeReviewEvidence> {
  const reviews = await githubJsonPages<Array<Record<string, unknown>>>(`/repos/${repository}/pulls/${number}/reviews`, token);
  const botLogin = process.env.CASHIN_APP_BOT_LOGIN?.trim();
  const latest = botLogin ? latestCurrentFormalReview(reviews, sha, botLogin) : undefined;
  if (!latest || latest.state !== 'APPROVED' || latest.commit_id !== sha || typeof latest.submitted_at !== 'string') {
    throw new Error('Code Review formal approval is missing, stale, or not approved for the current SHA.');
  }
  if (botLogin && hasLaterChangeRequest(reviews, latest, sha, botLogin)) {
    throw new Error('A later reviewer requested changes for the current SHA after Code Review approval.');
  }
  const comments = await githubJsonPages<Array<Record<string, unknown>>>(`/repos/${repository}/issues/${number}/comments`, token);
  const published = selectReusableStageResult('codeReview', { commitSha: sha, contextHash, changedFiles, acceptanceCriteria, botLogin: botLogin ?? '' }, reviews, comments);
  if (published?.decision !== 'APPROVED') throw new Error('Code Review structured approval is missing, superseded, or invalid for the current context.');
  return {
    state: 'APPROVED',
    reviewer: stringValue(asRecord(latest.user)?.login) ?? `${botLogin}[bot]`,
    commitSha: sha,
    submittedAt: latest.submitted_at,
    laterChangeRequest: false,
  };
}

async function githubJsonPages<T>(path: string, token: string): Promise<T> {
  const separator = path.includes('?') ? '&' : '?';
  const items: unknown[] = [];
  for (let page = 1; page <= 100; page += 1) {
    const current = await githubJson<unknown>(`${path}${separator}per_page=100&page=${page}`, token);
    if (!Array.isArray(current)) throw new Error('GitHub API returned an invalid paginated response.');
    items.push(...current);
    if (current.length < 100) return items as T;
  }
  throw new Error('GitHub API pagination exceeded the supported page limit.');
}

async function verifyHeadUnchanged(number: number, expected: string, repository: string, token: string): Promise<void> {
  const pr = await readPullRequest(number, repository, token);
  if (stringValue(asRecord(pr.head)?.sha)?.toLowerCase() !== expected.toLowerCase()) throw new Error('Pull Request HEAD changed during the Codex stage.');
}

async function githubJson<T>(path: string, token: string): Promise<T> {
  return requestGitHubApi<T>(fetch, path, token);
}

function parseStage(value: string): 'codeReview' | 'qa' | 'qualityGate' {
  if (['codeReview', 'qa', 'qualityGate'].includes(value)) return value as 'codeReview' | 'qa' | 'qualityGate';
  throw new Error('AGENT_STAGE is invalid.');
}

async function writeWorkflowOutput(name: string, value: string): Promise<void> {
  const output = process.env.GITHUB_OUTPUT;
  if (output) await appendFile(output, `${name}=${value}\n`, 'utf8');
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing ${name}.`);
  return value;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
