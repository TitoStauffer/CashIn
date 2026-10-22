import { appendFile, readFile } from 'node:fs/promises';
import { createGitHubInstallationSession, getRepositoryPath, requestGitHubApi, requestGitHubApiPages } from './github-api-client.js';
import { GitHubReportPublisher } from './github-report-publisher.js';
import type { AgentStageResult } from './agent-orchestrator.js';
import { computeAgentContextHash, formatFormalReviewEvidence, latestCurrentFormalReview } from './agent-evidence.js';
import { loadAgentReviewInputs } from './agent-review-inputs.js';

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : 'Agent result could not be published.';
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}

async function main(): Promise<void> {
  const mode = required('AGENT_PUBLISH_MODE');
  const resultPath = required('AGENT_RESULT_PATH');
  const result = JSON.parse(await readFile(resultPath, 'utf8')) as AgentStageResult;
  const repository = required('GITHUB_REPOSITORY');
  const [owner, name, unexpected] = repository.split('/');
  if (!owner || !name || unexpected) throw new Error('Invalid repository identity.');
  if (!['codeReview', 'qa', 'qualityGate'].includes(result.stage)
    || !['APPROVED', 'CHANGES_REQUESTED', 'INCONCLUSIVE'].includes(result.decision)
    || !/^[a-f0-9]{40}$/i.test(result.commitSha)
    || !/^[a-f0-9]{64}$/i.test(result.contextHash ?? '')
    || !result.reportMarkdown.trim()) throw new Error('Agent result artifact is invalid.');

  const credentials = {
    appId: required('CASHIN_APP_ID'),
    privateKey: (process.env.CASHIN_APP_PRIVATE_KEY ?? '').trim().replace(/\\n/g, '\n'),
    owner,
    repository: name,
    installationId: process.env.CASHIN_APP_INSTALLATION_ID?.trim() || undefined,
    contextToken: process.env.GITHUB_TOKEN?.trim() || undefined,
  };
  if (!credentials.privateKey) throw new Error('GitHub App private key is unavailable.');

  if (mode === 'formalReview') {
    if (result.stage !== 'codeReview' || !['APPROVED', 'CHANGES_REQUESTED', 'INCONCLUSIVE'].includes(result.decision)) {
      throw new Error('Formal Code Review can publish only an approved or change-requested Code Review result.');
    }
    const session = await createGitHubInstallationSession(credentials, true);
    const repositoryPath = getRepositoryPath(owner, name);
    const pr = await requestGitHubApi(fetch, `${repositoryPath}/pulls/${positivePrNumber()}`, session.installationToken);
    const headSha = asRecord(pr.head)?.sha;
    const author = asRecord(pr.user)?.login;
    if (pr.state !== 'open' || headSha !== result.commitSha) throw new Error('Pull Request HEAD changed before formal review publication.');
    const contextToken = process.env.GITHUB_TOKEN?.trim() || session.installationToken;
    const initialReviewInputs = await loadAgentReviewInputs(fetch, repository, positivePrNumber(), pr, contextToken);
    if (computeAgentContextHash(repository, positivePrNumber(), pr, initialReviewInputs) !== result.contextHash) throw new Error('Pull Request review inputs changed before formal review publication.');
    if (author === session.appSlug || author === `${session.appSlug}[bot]`) throw new Error('The review App cannot formally review its own Pull Request.');
    if (!result.reportMarkdown.includes(`Code Review — ${result.decision}`)
      && !result.reportMarkdown.includes(`Code Review - ${result.decision}`)) {
      if (result.decision !== 'INCONCLUSIVE') throw new Error('Formal review body decision does not match the agent result.');
    }
    if (result.decision === 'INCONCLUSIVE') {
      const publisher = new GitHubReportPublisher(credentials);
      await publisher.publishReport({
        agentName: 'codeReview', pullRequestNumber: positivePrNumber(), commitSha: result.commitSha,
        contextHash: result.contextHash, status: result.decision, reportMarkdown: result.reportMarkdown,
      });
      await writeOutput('decision', result.decision);
      await writeOutput('commit_sha', result.commitSha);
      process.stdout.write(`Published an inconclusive Code Review report for PR #${positivePrNumber()}; no formal review was submitted.\n`);
      return;
    }
    const reviewsPath = `${repositoryPath}/pulls/${positivePrNumber()}/reviews`;
    const reviews = await requestGitHubApiPages<Record<string, unknown>>(fetch, reviewsPath, session.installationToken);
    const appLogins = new Set([session.appSlug, `${session.appSlug}[bot]`]);
    const latestAppReview = latestCurrentFormalReview(reviews, result.commitSha, session.appSlug ?? '');
    const formattedBody = formatFormalReviewEvidence(result);
    if (latestAppReview && typeof latestAppReview.user === 'object' && latestAppReview.user !== null
      && appLogins.has(String((latestAppReview.user as Record<string, unknown>).login))
      && latestAppReview.state === result.decision
      && latestAppReview.body === formattedBody) {
      process.stdout.write(`Reused existing formal Code Review for PR #${positivePrNumber()} at the expected SHA.\n`);
    } else {
    const latestPr = await requestGitHubApi(fetch, `${repositoryPath}/pulls/${positivePrNumber()}`, session.installationToken);
    const latestReviewInputs = await loadAgentReviewInputs(fetch, repository, positivePrNumber(), latestPr, contextToken);
    if (latestPr.state !== 'open'
      || asRecord(latestPr.head)?.sha !== result.commitSha
      || computeAgentContextHash(repository, positivePrNumber(), latestPr, latestReviewInputs) !== result.contextHash) {
      throw new Error('Pull Request changed before formal review submission.');
    }
    const review = await requestGitHubApi(fetch, reviewsPath, session.installationToken, {
      method: 'POST',
      body: JSON.stringify({
        body: formattedBody,
        commit_id: result.commitSha,
        event: result.decision === 'APPROVED' ? 'APPROVE' : 'REQUEST_CHANGES',
      }),
    });
    if (review.commit_id !== result.commitSha || review.state !== result.decision) throw new Error('GitHub returned a formal review for an unexpected SHA or decision.');
    }
  } else if (mode === 'report') {
    const agentName = result.stage === 'qa' ? 'qa' : result.stage === 'qualityGate' ? 'qualityGate' : undefined;
    if (!agentName) throw new Error('Only QA and Quality Gate Coordinator publish reports through this step.');
    const publisher = new GitHubReportPublisher(credentials);
    await publisher.publishReport({
      agentName,
      pullRequestNumber: positivePrNumber(),
      commitSha: result.commitSha,
      status: result.decision,
      reportMarkdown: result.reportMarkdown,
      contextHash: result.contextHash,
    });
  } else {
    throw new Error('AGENT_PUBLISH_MODE must be formalReview or report.');
  }

  await writeOutput('decision', result.decision);
  await writeOutput('commit_sha', result.commitSha);
  process.stdout.write(`Published ${mode} for PR #${positivePrNumber()} at the expected SHA.\n`);
}

function positivePrNumber(): number {
  const number = Number(required('PR_NUMBER'));
  if (!Number.isSafeInteger(number) || number < 1) throw new Error('PR_NUMBER must be a positive integer.');
  return number;
}

async function writeOutput(name: string, value: string): Promise<void> {
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
