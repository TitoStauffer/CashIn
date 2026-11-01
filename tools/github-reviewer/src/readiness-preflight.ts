import { parseStoredAgentComment } from './agent-evidence.js';
import { getRepositoryPath, requestGitHubApiPages } from './github-api-client.js';

export interface ReadinessPreflightOptions {
  eventName: string;
  payload: unknown;
  owner: string;
  repository: string;
  pullRequestNumber: number;
  headSha: string;
  botLogin: string;
  token: string;
  fetchImpl?: typeof fetch;
}

export interface ReadinessPreflightResult {
  mode: 'evaluate' | 'invalidate';
  reason: string;
}

/** Only selects whether to run the full gate; it can never authorize a merge. */
export async function planReadinessEvaluation(options: ReadinessPreflightOptions): Promise<ReadinessPreflightResult> {
  // resolveWorkflowEvent has already authenticated the event and resolved the
  // open PR's current HEAD. Manual recovery must always run the full evaluator.
  if (options.eventName === 'workflow_dispatch') return evaluate();
  const payload = record(options.payload);
  if (options.eventName === 'issue_comment' && isCurrentCoordinatorReport(record(payload?.comment), options)) {
    return evaluate();
  }
  if (!options.botLogin || !options.token || !/^[a-f0-9]{40}$/i.test(options.headSha)) {
    return invalidate('Não foi possível confirmar a identidade ou o SHA para consultar o relatório do Coordinator.');
  }
  try {
    const comments = await requestGitHubApiPages<unknown>(
      options.fetchImpl ?? fetch,
      `${getRepositoryPath(options.owner, options.repository)}/issues/${options.pullRequestNumber}/comments`,
      options.token,
    );
    // A delayed CI/review/metadata event must not overwrite a final success
    // with a permanent waiting state. If a candidate already exists, the full
    // evaluator revalidates its context, decision, checks and protections.
    if (comments.some((comment) => isCurrentCoordinatorReport(record(comment), options))) return evaluate();
    return invalidate('Aguardando relatório estruturado do Quality Gate Coordinator para o HEAD atual; avaliação completa adiada.');
  } catch {
    return invalidate('Não foi possível consultar os relatórios do Coordinator; a prontidão não pode ser confirmada.');
  }
}

function isCurrentCoordinatorReport(comment: Record<string, unknown> | undefined, options: ReadinessPreflightOptions): boolean {
  if (!comment || !options.botLogin || !/^[a-f0-9]{40}$/i.test(options.headSha)) return false;
  // Extract the context only to reuse the canonical report parser. Context
  // freshness and completeness remain exclusively the full gate's decision.
  const contextHash = typeof comment.body === 'string'
    ? /^<!-- cashin-agent-report:v1 stage=qualityGate sha=[a-f0-9]{40} ctx=([a-f0-9]{64}) -->\n/.exec(comment.body)?.[1]
    : undefined;
  return Boolean(contextHash && parseStoredAgentComment(comment, 'qualityGate', options.headSha, options.botLogin, contextHash));
}

function evaluate(): ReadinessPreflightResult {
  return { mode: 'evaluate', reason: 'Avaliação completa das evidências e proteções necessária.' };
}

function invalidate(reason: string): ReadinessPreflightResult {
  return { mode: 'invalidate', reason };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
