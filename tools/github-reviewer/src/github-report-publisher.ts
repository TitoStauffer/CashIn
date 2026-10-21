import type { createAppAuth } from '@octokit/auth-app';
import { createGitHubInstallationSession, getRepositoryPath, requestGitHubApi } from './github-api-client.js';

export const REPORT_AGENT_SIGNATURES = {
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
}

export interface GitHubReportPublisherOptions {
  appId: string;
  privateKey: string;
  owner: string;
  repository: string;
  installationId?: string;
  fetchImpl?: typeof fetch;
  authFactory?: typeof createAppAuth;
}

export interface PublishedReport {
  commentId: number;
  htmlUrl: string;
  repository: string;
  pullRequestNumber: number;
}

export class GitHubReportPublisher {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: GitHubReportPublisherOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async publishReport(report: PullRequestReport): Promise<PublishedReport> {
    validateReport(report);
    const session = await createGitHubInstallationSession(this.options, false);
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

    const comment = await requestGitHubApi(
      this.fetchImpl,
      `${repositoryPath}/issues/${report.pullRequestNumber}/comments`,
      installationToken,
      {
        method: 'POST',
        body: JSON.stringify({ body: formatPullRequestReport(report) }),
      },
    );
    if (typeof comment.id !== 'number' || typeof comment.html_url !== 'string') {
      throw new Error('GitHub API returned an invalid comment response.');
    }

    return {
      commentId: comment.id,
      htmlUrl: comment.html_url,
      repository: `${this.options.owner}/${this.options.repository}`,
      pullRequestNumber: report.pullRequestNumber,
    };
  }

}

export function formatPullRequestReport(report: PullRequestReport): string {
  validateReport(report);
  return [
    `### ${REPORT_AGENT_SIGNATURES[report.agentName]}`,
    '',
    `**Status:** ${report.status.trim()}`,
    `**Commit:** \`${report.commitSha}\``,
    '',
    report.reportMarkdown.trim(),
  ].join('\n');
}

function validateReport(report: PullRequestReport): void {
  if (!Object.hasOwn(REPORT_AGENT_SIGNATURES, report.agentName)) {
    throw new Error('Agent must be qualityGate, qa, or pm.');
  }
  if (!Number.isSafeInteger(report.pullRequestNumber) || report.pullRequestNumber < 1) {
    throw new Error('Pull request number must be a positive integer.');
  }
  if (!/^[a-f0-9]{7,64}$/i.test(report.commitSha)) {
    throw new Error('Commit SHA must contain between 7 and 64 hexadecimal characters.');
  }
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
