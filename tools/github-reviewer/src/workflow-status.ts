import type { MergeReadinessResult } from './merge-readiness.js';

const API_BASE = 'https://api.github.com';
const API_VERSION = '2022-11-28';
export const MERGE_READINESS_CONTEXT = 'Merge Readiness';

export function workflowExecutionExitCode(statusPublished: boolean): 0 | 2 {
  return statusPublished ? 0 : 2;
}

export interface CommitStatusOptions {
  owner: string;
  repository: string;
  headSha: string;
  token: string;
  targetUrl: string;
  result: MergeReadinessResult;
  fetchImpl?: typeof fetch;
}

export function mapReadinessToCommitStatus(result: MergeReadinessResult): {
  state: 'success' | 'failure' | 'error';
  description: string;
} {
  const state = result.status === 'READY_TO_MERGE' ? 'success' : result.status === 'BLOCKED' ? 'failure' : 'error';
  const reason = result.reasons[0] ?? result.limitations[0];
  const description = truncate(`Merge Readiness: ${result.status}${reason ? ` — ${reason.replace(/\s+/g, ' ').trim()}` : ''}`, 140);
  return { state, description };
}

export async function publishCommitStatus(options: CommitStatusOptions): Promise<void> {
  if (!/^[a-f0-9]{40}$/i.test(options.headSha)) throw new Error('Cannot publish Merge Readiness without a full commit SHA.');
  if (!options.token) throw new Error('GitHub Actions token is unavailable for publishing the readiness status.');

  const status = mapReadinessToCommitStatus(options.result);
  const response = await (options.fetchImpl ?? fetch)(
    `${API_BASE}/repos/${encodeURIComponent(options.owner)}/${encodeURIComponent(options.repository)}/statuses/${options.headSha}`,
    {
      method: 'POST',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${options.token}`,
        'X-GitHub-Api-Version': API_VERSION,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        state: status.state,
        context: MERGE_READINESS_CONTEXT,
        description: status.description,
        target_url: options.targetUrl,
      }),
    },
  );
  if (!response.ok) throw new Error(`GitHub could not publish the Merge Readiness status (HTTP ${response.status}).`);
}

export function formatReadinessSummary(result: MergeReadinessResult, statusPublicationError?: string): string {
  const lines = [
    `## Merge Readiness — ${result.status}`,
    '',
    `- **PR:** ${result.pullRequest.number ? `#${result.pullRequest.number}` : 'não identificado'}`,
    `- **Título:** ${escapeMarkdown(result.pullRequest.title ?? 'indisponível')}`,
    `- **Branch base:** ${escapeMarkdown(result.pullRequest.baseBranch ?? 'indisponível')}`,
    `- **SHA avaliado:** ${result.pullRequest.headSha ? `\`${escapeMarkdown(result.pullRequest.headSha)}\`` : 'indisponível'}`,
    `- **Avaliado em:** ${escapeMarkdown(result.evaluatedAt)}`,
    '',
    '### Evidências',
    '',
    ...formatEvidence(result.evidence),
    '',
    '### Motivos',
    '',
    ...(result.reasons.length ? result.reasons.map((reason) => `- ${escapeMarkdown(reason)}`) : ['- Nenhum bloqueio identificado.']),
    '',
    '### Limitações',
    '',
    ...(result.limitations.length ? result.limitations.map((limitation) => `- ${escapeMarkdown(limitation)}`) : ['- Nenhuma.']),
  ];
  if (statusPublicationError) lines.push('', `**Falha ao publicar o status no commit:** ${escapeMarkdown(statusPublicationError)}`);
  return `${lines.join('\n')}\n`;
}

function formatEvidence(evidence: Record<string, unknown>): string[] {
  const items: Array<[string, unknown]> = [
    ['Checks obrigatórios', evidence.requiredCheckResults],
    ['Revisão formal', evidence.codeReview],
    ['Aprovações no HEAD', evidence.currentHeadApprovalCount],
    ['QA', asRecord(evidence.reports)?.qa],
    ['Quality Gate Coordinator', asRecord(evidence.reports)?.qualityGate],
    ['Conversas de revisão', evidence.reviewThreads],
    ['Proteção da branch', evidence.branchProtection],
    ['Rulesets', evidence.rulesets],
  ];
  return items
    .filter(([, value]) => value !== undefined)
    .map(([label, value]) => `- **${label}:** \`${escapeMarkdown(JSON.stringify(value))}\``);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined;
}

function escapeMarkdown(value: string): string {
  return value.replace(/[\\`*_{}\[\]()#+.!|>]/g, '\\$&').replace(/[\r\n]+/g, ' ');
}

function truncate(value: string, maximumLength: number): string {
  return value.length <= maximumLength ? value : `${value.slice(0, maximumLength - 1)}…`;
}
