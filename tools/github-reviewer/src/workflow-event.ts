export type WorkflowEventAction = 'evaluate' | 'skip' | 'inconclusive';

export interface WorkflowEventResolution {
  action: WorkflowEventAction;
  pullRequestNumber?: number;
  headSha?: string;
  reason: string;
}

export interface WorkflowEventOptions {
  eventName: string;
  payload: unknown;
  repository: string;
  botLogin: string;
  token: string;
  fetchImpl?: typeof fetch;
}

const API_BASE = 'https://api.github.com';
const API_VERSION = '2022-11-28';
const TARGET_BRANCH = 'master';
const REPORT_SIGNATURES = [
  '### Codex — Quality Gate Coordinator',
  '### Codex — QA Agent',
  '### Codex — PM Agent',
  '### Code Review — APPROVED',
  '### Code Review — CHANGES_REQUESTED',
  '### Code Review - APPROVED',
  '### Code Review - CHANGES_REQUESTED',
];

export async function resolveWorkflowEvent(options: WorkflowEventOptions): Promise<WorkflowEventResolution> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const payload = asRecord(options.payload);
  const repository = parseRepository(options.repository);
  if (!payload || !repository) return inconclusive('O evento ou o repositório não possui formato válido.');

  let pullRequestNumber: number | undefined;
  let fallbackSha: string | undefined;

  if (options.eventName === 'pull_request_target') {
    const pullRequest = asRecord(payload.pull_request);
    pullRequestNumber = positiveInteger(pullRequest?.number);
    fallbackSha = stringValue(asRecord(pullRequest?.head)?.sha);
    if (!pullRequestNumber) return inconclusive('O evento não contém um número de Pull Request válido.');
  } else if (options.eventName === 'issue_comment') {
    const issue = asRecord(payload.issue);
    const comment = asRecord(payload.comment);
    if (!asRecord(issue?.pull_request)) return skip('O comentário não pertence a um Pull Request.');
    if (!['created', 'edited'].includes(stringValue(payload.action) ?? '')) return skip('O evento de comentário não requer reavaliação.');
    if (!options.botLogin || stringValue(asRecord(comment?.user)?.login) !== options.botLogin) {
      return skip('O comentário não foi publicado pelo GitHub App configurado.');
    }
    const body = stringValue(comment?.body) ?? '';
    if (!REPORT_SIGNATURES.some((signature) => body.includes(signature))) {
      return skip('O comentário do App não contém uma assinatura de relatório reconhecida.');
    }
    pullRequestNumber = positiveInteger(issue?.number);
    if (!pullRequestNumber) return inconclusive('O comentário não contém um número de Pull Request válido.');
  } else if (options.eventName === 'workflow_dispatch') {
    pullRequestNumber = positiveInteger(asRecord(payload.inputs)?.pr_number);
    if (!pullRequestNumber) return inconclusive('Informe um número de Pull Request válido para a execução manual.');
  } else if (options.eventName === 'workflow_run') {
    const workflow = asRecord(payload.workflow);
    const run = asRecord(payload.workflow_run);
    const workflowName = stringValue(workflow?.name) ?? stringValue(run?.name);
    const runEvent = stringValue(run?.event);
    const isCiRun = workflowName === 'CI' && runEvent === 'pull_request';
    const isTitleRun = workflowName === 'PR title' && (runEvent === 'pull_request' || runEvent === 'pull_request_target');
    const isReviewSignalRun = workflowName === 'PR Review Signal' && runEvent === 'pull_request_review';
    if (!isCiRun && !isTitleRun && !isReviewSignalRun) return skip('A execução concluída não corresponde ao CI, à validação de título ou ao sinal de revisão de um Pull Request.');

    const associatedPullRequests = run?.pull_requests;
    if (!Array.isArray(associatedPullRequests) || associatedPullRequests.length !== 1) {
      return inconclusive('A execução concluída não está associada a exatamente um Pull Request.');
    }
    pullRequestNumber = positiveInteger(asRecord(associatedPullRequests[0])?.number);
    if (!pullRequestNumber) return inconclusive('A execução concluída não contém um número de Pull Request válido.');
  } else {
    return skip('O evento não é usado para avaliar Merge Readiness.');
  }

  try {
    const pullRequest = asRecord(await requestGitHubApi(
      fetchImpl,
      `/repos/${repository.owner}/${repository.name}/pulls/${pullRequestNumber}`,
      options.token,
    ));
    if (!pullRequest) return inconclusive('A API retornou um Pull Request em formato inválido.', pullRequestNumber, fallbackSha);
    const headSha = stringValue(asRecord(pullRequest.head)?.sha) ?? fallbackSha;
    if (pullRequest.state !== 'open') return skip('O Pull Request não está aberto.', pullRequestNumber, headSha);
    if (stringValue(asRecord(pullRequest.base)?.ref) !== TARGET_BRANCH) {
      return skip(`O Pull Request não tem ${TARGET_BRANCH} como branch de destino.`, pullRequestNumber, headSha);
    }
    if (!headSha || !/^[a-f0-9]{40}$/i.test(headSha)) {
      return inconclusive('A API não retornou um HEAD SHA completo e válido.', pullRequestNumber);
    }
    return { action: 'evaluate', pullRequestNumber, headSha, reason: 'Pull Request aberto e destinado a master.' };
  } catch (error) {
    return inconclusive(describeApiFailure(error), pullRequestNumber, fallbackSha);
  }
}

async function requestGitHubApi(fetchImpl: typeof fetch, path: string, token: string): Promise<unknown> {
  if (!token) throw new Error('GitHub Actions token ausente.');
  const response = await fetchImpl(`${API_BASE}${path}`, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': API_VERSION,
    },
  });
  if (!response.ok) throw new Error(`GitHub API HTTP ${response.status}.`);
  return response.json();
}

function parseRepository(value: string): { owner: string; name: string } | undefined {
  const match = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(value);
  return match ? { owner: match[1], name: match[2] } : undefined;
}

function positiveInteger(value: unknown): number | undefined {
  const number = typeof value === 'number' ? value : typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : NaN;
  return Number.isSafeInteger(number) && number > 0 ? number : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function skip(reason: string, pullRequestNumber?: number, headSha?: string): WorkflowEventResolution {
  return { action: 'skip', ...(pullRequestNumber ? { pullRequestNumber } : {}), ...(headSha ? { headSha } : {}), reason };
}

function inconclusive(reason: string, pullRequestNumber?: number, headSha?: string): WorkflowEventResolution {
  return { action: 'inconclusive', ...(pullRequestNumber ? { pullRequestNumber } : {}), ...(headSha ? { headSha } : {}), reason };
}

function describeApiFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  const status = message.match(/HTTP (\d{3})/)?.[1];
  return status
    ? `Não foi possível resolver o Pull Request pela API do GitHub (HTTP ${status}).`
    : 'Não foi possível resolver o Pull Request pela API do GitHub.';
}
