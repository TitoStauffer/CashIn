import type { createAppAuth } from '@octokit/auth-app';
import { createGitHubInstallationSession, getRepositoryPath, requestGitHubApi, requestGitHubApiPages } from './github-api-client.js';
import { computeAgentContextHash } from './agent-evidence.js';
import { loadAgentReviewInputs } from './agent-review-inputs.js';

export const REPORT_AGENT_SIGNATURES = {
  codeReview: 'Codex — Code Review Agent',
  qualityGate: 'Codex — Quality Gate Coordinator',
  qa: 'Codex — QA Agent',
  pm: 'Codex — PM Agent',
} as const;

export type ReportAgentName = keyof typeof REPORT_AGENT_SIGNATURES;

export interface PullRequestReport {
  agentName: ReportAgentName;
  pullRequestNumber: number;
  commitSha: string;
  status: string;
  reportMarkdown: string;
  contextHash?: string;
}

export interface GitHubReportPublisherOptions {
  appId: string;
  privateKey: string;
  owner: string;
  repository: string;
  installationId?: string;
  contextToken?: string;
  fetchImpl?: typeof fetch;
  authFactory?: typeof createAppAuth;
}

export interface PublishedReport {
  commentId: number;
  htmlUrl: string;
  repository: string;
  pullRequestNumber: number;
  reusedComment: boolean;
}

export class GitHubReportPublisher {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: GitHubReportPublisherOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async publishReport(report: PullRequestReport): Promise<PublishedReport> {
    validateReport(report);
    const session = await createGitHubInstallationSession(this.options, true);
    const installationToken = session.installationToken;
    const repositoryPath = getRepositoryPath(this.options.owner, this.options.repository);
    const pullRequestPath = `${repositoryPath}/pulls/${report.pullRequestNumber}`;
    const pullRequest = await requestGitHubApi(this.fetchImpl, pullRequestPath, installationToken);

    if (pullRequest.state !== 'open') {
      throw new Error(`Pull request #${report.pullRequestNumber} is not open.`);
    }
    if (!isRecord(pullRequest.head) || pullRequest.head.sha !== report.commitSha) {
      throw new Error(`Pull request #${report.pullRequestNumber} no longer points to the supplied commit SHA.`);
    }
    const contextToken = this.options.contextToken || installationToken;
    const reviewInputs = await loadAgentReviewInputs(this.fetchImpl, `${this.options.owner}/${this.options.repository}`, report.pullRequestNumber, pullRequest, contextToken);
    const currentContextHash = computeAgentContextHash(`${this.options.owner}/${this.options.repository}`, report.pullRequestNumber, pullRequest, reviewInputs);
    if (report.agentName !== 'pm' && (!report.contextHash || currentContextHash !== report.contextHash)) {
      throw new Error(`Pull request #${report.pullRequestNumber} metadata changed before the agent report could be published.`);
    }

    const commentsPath = `${repositoryPath}/issues/${report.pullRequestNumber}/comments`;
    const comments = await requestGitHubApiPages<Record<string, unknown>>(this.fetchImpl, commentsPath, installationToken);
    const marker = reportMarker(report);
    const appLogins = new Set([session.appSlug, session.appSlug ? `${session.appSlug}[bot]` : undefined].filter(Boolean));
    const existing = comments
      .filter((comment) => isRecord(comment.user)
        && appLogins.has(String(comment.user.login))
        && typeof comment.body === 'string'
        && comment.body.startsWith(`${marker}\n`))
      .sort((left, right) => String(left.updated_at ?? '').localeCompare(String(right.updated_at ?? '')))
      .at(-1);
    const latestPullRequest = await requestGitHubApi(this.fetchImpl, pullRequestPath, installationToken);
    const latestReviewInputs = await loadAgentReviewInputs(this.fetchImpl, `${this.options.owner}/${this.options.repository}`, report.pullRequestNumber, latestPullRequest, contextToken);
    const latestContextHash = computeAgentContextHash(`${this.options.owner}/${this.options.repository}`, report.pullRequestNumber, latestPullRequest, latestReviewInputs);
    if (latestPullRequest.state !== 'open'
      || !isRecord(latestPullRequest.head)
      || latestPullRequest.head.sha !== report.commitSha
      || (report.agentName !== 'pm' && latestContextHash !== report.contextHash)) {
      throw new Error(`Pull request #${report.pullRequestNumber} changed before the agent report could be published.`);
    }
    const comment = existing
      ? await requestGitHubApi(this.fetchImpl, `${repositoryPath}/issues/comments/${existing.id}`, installationToken, {
        method: 'PATCH', body: JSON.stringify({ body: formatPullRequestReport(report) }),
      })
      : await requestGitHubApi(this.fetchImpl, commentsPath, installationToken, {
        method: 'POST', body: JSON.stringify({ body: formatPullRequestReport(report) }),
      });
    if (typeof comment.id !== 'number' || typeof comment.html_url !== 'string') {
      throw new Error('GitHub API returned an invalid comment response.');
    }

    return {
      commentId: comment.id,
      htmlUrl: comment.html_url,
      repository: `${this.options.owner}/${this.options.repository}`,
      pullRequestNumber: report.pullRequestNumber,
      reusedComment: Boolean(existing),
    };
  }

}

export function formatPullRequestReport(report: PullRequestReport): string {
  validateReport(report);
  const reportBody = removeRepeatedMetadata(report.reportMarkdown, report.status, report.commitSha);
  return [
    reportMarker(report),
    `### ${REPORT_AGENT_SIGNATURES[report.agentName]}`,
    '',
    `**Status:** ${report.status.trim()}`,
    `**Commit:** \`${report.commitSha}\``,
    '',
    reportBody,
  ].join('\n');
}

function reportMarker(report: PullRequestReport): string {
  const stage = report.agentName === 'qualityGate' ? 'qualityGate' : report.agentName;
  return `<!-- cashin-agent-report:v1 stage=${stage} sha=${report.commitSha.toLowerCase()}${report.contextHash ? ` ctx=${report.contextHash.toLowerCase()}` : ''} -->`;
}

function removeRepeatedMetadata(markdown: string, status: string, commitSha: string): string {
  const lines = markdown.trim().split(/\r?\n/);
  while (lines.length > 0 && !lines[0].trim()) lines.shift();

  const statusMatch = lines[0]?.match(/^\*\*Status:\*\*\s*(.+?)\s*$/i);
  const commitMatch = lines[1]?.match(/^\*\*Commit:\*\*\s*`?([a-f0-9]{7,64})`?\s*$/i);
  if (!statusMatch && !commitMatch) return lines.join('\n').trim();

  if (statusMatch?.[1].trim() !== status.trim() || commitMatch?.[1].toLowerCase() !== commitSha.toLowerCase()) {
    throw new Error('Report Markdown metadata must match the supplied status and commit SHA.');
  }

  lines.splice(0, 2);
  while (lines.length > 0 && !lines[0].trim()) lines.shift();
  return lines.join('\n').trim();
}

function validateReport(report: PullRequestReport): void {
  if (!Object.hasOwn(REPORT_AGENT_SIGNATURES, report.agentName)) {
    throw new Error('Agent must be codeReview, qualityGate, qa, or pm.');
  }
  if (!Number.isSafeInteger(report.pullRequestNumber) || report.pullRequestNumber < 1) {
    throw new Error('Pull request number must be a positive integer.');
  }
  if (!/^[a-f0-9]{7,64}$/i.test(report.commitSha)) {
    throw new Error('Commit SHA must contain between 7 and 64 hexadecimal characters.');
  }
  if (report.contextHash !== undefined && !/^[a-f0-9]{64}$/i.test(report.contextHash)) throw new Error('Context hash must be a full SHA-256.');
  if (!report.status.trim()) {
    throw new Error('Report status must not be empty.');
  }
  if (!report.reportMarkdown.trim()) {
    throw new Error('Report Markdown must not be empty.');
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
