import { createHash } from 'node:crypto';
import type { AgentStageResult, AgentStage } from './agent-orchestrator.js';
import { fingerprintAgentReviewInputs, type AgentReviewInputs } from './agent-review-inputs.js';

const SIGNATURES: Record<AgentStage, string> = {
  codeReview: 'Codex — Code Review Agent',
  qa: 'Codex — QA Agent',
  qualityGate: 'Codex — Quality Gate Coordinator',
};

export function computeAgentContextHash(repository: string, pullRequestNumber: number, pullRequest: Record<string, unknown>, reviewInputs: AgentReviewInputs): string {
  const head = record(pullRequest.head);
  const base = record(pullRequest.base);
  return createHash('sha256').update(JSON.stringify({
    repository,
    pullRequestNumber,
    title: typeof pullRequest.title === 'string' ? pullRequest.title : '',
    url: typeof pullRequest.html_url === 'string' ? pullRequest.html_url : '',
    body: typeof pullRequest.body === 'string' ? pullRequest.body.replace(/^(\s*[-*]\s+)\[[ xX]\](?=\s)/gm, '$1[ ]') : '',
    headSha: typeof head?.sha === 'string' ? head.sha.toLowerCase() : '',
    baseBranch: typeof base?.ref === 'string' ? base.ref : '',
    baseSha: typeof base?.sha === 'string' ? base.sha.toLowerCase() : '',
    reviewInputs: fingerprintAgentReviewInputs(reviewInputs),
  })).digest('hex');
}

export function agentReportMarker(stage: AgentStage, commitSha: string, contextHash?: string): string {
  if (!/^[a-f0-9]{40}$/i.test(commitSha)) throw new Error('Commit SHA must be a full SHA-1.');
  if (contextHash !== undefined && !/^[a-f0-9]{64}$/i.test(contextHash)) throw new Error('Context hash must be a full SHA-256.');
  return `<!-- cashin-agent-report:v1 stage=${stage} sha=${commitSha.toLowerCase()}${contextHash ? ` ctx=${contextHash.toLowerCase()}` : ''} -->`;
}

export function formatFormalReviewEvidence(result: AgentStageResult): string {
  return [
    agentReportMarker('codeReview', result.commitSha, result.contextHash),
    '### Codex — Code Review Agent',
    '',
    `**Status:** ${result.decision}`,
    `**Commit:** \`${result.commitSha}\``,
    '',
    result.reportMarkdown.trim(),
  ].join('\n');
}

export function parseStoredFormalReview(
  review: Record<string, unknown>,
  commitSha: string,
  botLogin: string,
  contextHash?: string,
): AgentStageResult | undefined {
  if (![botLogin, `${botLogin}[bot]`].includes(String(record(review.user)?.login)) || review.commit_id !== commitSha) return undefined;
  const body = typeof review.body === 'string' ? review.body : '';
  const parsed = parseStoredAgentComment({ user: { login: botLogin }, body }, 'codeReview', commitSha, botLogin, contextHash);
  if (!parsed) return undefined;
  const expectedState = parsed.decision === 'APPROVED' ? 'APPROVED'
    : parsed.decision === 'CHANGES_REQUESTED' ? 'CHANGES_REQUESTED' : undefined;
  return expectedState && review.state === expectedState ? parsed : undefined;
}

export function parseStoredAgentComment(
  comment: Record<string, unknown>,
  stage: AgentStage,
  commitSha: string,
  botLogin: string,
  contextHash?: string,
): AgentStageResult | undefined {
  const user = record(comment.user);
  const body = typeof comment.body === 'string' ? comment.body : '';
  const marker = agentReportMarker(stage, commitSha, contextHash);
  if (![botLogin, `${botLogin}[bot]`].includes(String(user?.login)) || !body.startsWith(`${marker}\n`)) return undefined;
  const signature = SIGNATURES[stage];
  const header = `### ${signature}`;
  if (!body.includes(header)) return undefined;
  const status = body.match(/^\*\*Status:\*\*\s*(APPROVED|CHANGES_REQUESTED|INCONCLUSIVE)\s*$/m)?.[1];
  const sha = body.match(/^\*\*Commit:\*\*\s*`([a-f0-9]{40})`\s*$/mi)?.[1];
  if (!status || sha?.toLowerCase() !== commitSha.toLowerCase()) return undefined;
  const reportMarkdown = body.slice(body.indexOf(header) + header.length).replace(/^\s*\*\*Status:\*\*[^\n]*\n\*\*Commit:\*\*[^\n]*\n?/i, '').trim();
  if (!reportMarkdown) return undefined;
  if (stage === 'qa' && !/^(?:#{1,3}\s+Verificações de QA|\*\*Verificações de QA:\*\*)\s*$/im.test(reportMarkdown)) return undefined;
  if (stage === 'qualityGate' && !/^(?:#{1,3}\s+Checks verificados|\*\*Checks verificados:\*\*)\s*$/im.test(reportMarkdown)) return undefined;
  return { stage, decision: status as AgentStageResult['decision'], commitSha: commitSha.toLowerCase(), reportMarkdown, contextHash };
}

export function latestCurrentFormalReview(
  reviews: Array<Record<string, unknown>>,
  commitSha: string,
  botLogin: string,
): Record<string, unknown> | undefined {
  const latest = reviews
    .filter((review) => [botLogin, `${botLogin}[bot]`].includes(String(record(review.user)?.login)) && typeof review.submitted_at === 'string')
    .sort((left, right) => String(left.submitted_at).localeCompare(String(right.submitted_at)))
    .at(-1);
  return latest?.commit_id === commitSha ? latest : undefined;
}

export function hasLaterChangeRequest(
  reviews: Array<Record<string, unknown>>,
  approval: Record<string, unknown>,
  commitSha: string,
  botLogin: string,
): boolean {
  const approvalTime = typeof approval.submitted_at === 'string' ? approval.submitted_at : '';
  return reviews.some((review) => {
    const userLogin = String(record(review.user)?.login);
    const submittedAt = typeof review.submitted_at === 'string' ? review.submitted_at : '';
    return userLogin !== botLogin
      && userLogin !== `${botLogin}[bot]`
      && review.state === 'CHANGES_REQUESTED'
      && review.commit_id === commitSha
      && submittedAt > approvalTime;
  });
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined;
}
