import { computeAgentContextHash } from './agent-evidence.js';
import { loadAgentReviewInputs } from './agent-review-inputs.js';
import { createGitHubInstallationSession, getRepositoryPath, requestGitHubApi, type GitHubApiClientOptions } from './github-api-client.js';

export type ApprovalChecklistStage = 'codeReview' | 'qa';

const LABELS: Record<ApprovalChecklistStage, string> = {
  codeReview: 'Code Review aprovado',
  qa: 'QA aprovado',
};

export interface ApprovalChecklistUpdate {
  credentials: GitHubApiClientOptions & { contextToken?: string };
  repository: string;
  pullRequestNumber: number;
  commitSha: string;
  contextHash: string;
  stage: ApprovalChecklistStage;
  approved: boolean;
  fetchImpl?: typeof fetch;
}

export async function syncApprovalCheckbox(options: ApprovalChecklistUpdate): Promise<boolean> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const session = await createGitHubInstallationSession({ ...options.credentials, fetchImpl }, true);
  const repositoryPath = getRepositoryPath(options.credentials.owner, options.credentials.repository);
  const pullRequestPath = `${repositoryPath}/pulls/${options.pullRequestNumber}`;
  const pullRequest = await requestGitHubApi<Record<string, unknown>>(fetchImpl, pullRequestPath, session.installationToken);
  const head = record(pullRequest.head);
  if (pullRequest.state !== 'open' || head?.sha !== options.commitSha) {
    throw new Error('Pull Request HEAD changed before approval checklist synchronization.');
  }

  const contextToken = options.credentials.contextToken?.trim() || session.installationToken;
  const reviewInputs = await loadAgentReviewInputs(fetchImpl, options.repository, options.pullRequestNumber, pullRequest, contextToken);
  if (computeAgentContextHash(options.repository, options.pullRequestNumber, pullRequest, reviewInputs) !== options.contextHash) {
    throw new Error('Pull Request context changed before approval checklist synchronization.');
  }

  const currentBody = typeof pullRequest.body === 'string' ? pullRequest.body : '';
  const nextBody = updateApprovalCheckbox(currentBody, options.stage, options.approved);
  if (nextBody === currentBody) return false;

  const updated = await requestGitHubApi<Record<string, unknown>>(fetchImpl, pullRequestPath, session.installationToken, {
    method: 'PATCH',
    body: JSON.stringify({ body: nextBody }),
  });
  if (record(updated.head)?.sha !== options.commitSha || updated.body !== nextBody) {
    throw new Error('GitHub returned an unexpected Pull Request after checklist synchronization.');
  }
  return true;
}

export function updateApprovalCheckbox(body: string, stage: ApprovalChecklistStage, approved: boolean): string {
  const label = LABELS[stage];
  const escapedLabel = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`^(\\s*[-*]\\s+)\\[[ xX]\\](\\s+\\*\\*${escapedLabel}\\*\\*[^\\r\\n]*)$`, 'gm');
  const matches = [...body.matchAll(pattern)];
  if (matches.length !== 1) throw new Error(`Pull Request template must contain exactly one ${label} checkbox.`);
  return body.replace(pattern, `$1[${approved ? 'x' : ' '}]$2`);
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined;
}
