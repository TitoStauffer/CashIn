import { appendFile, readFile } from 'node:fs/promises';
import { evaluateMergeReadiness, type MergeReadinessResult } from './merge-readiness.js';
import { resolveWorkflowEvent } from './workflow-event.js';
import { formatReadinessSummary, publishCommitStatus } from './workflow-status.js';

const INCONCLUSIVE_STATUS: MergeReadinessResult['status'] = 'INCONCLUSIVE';

try {
  await run();
} catch {
  const result = createInconclusive(undefined, undefined, 'Falha interna ao executar o Merge Readiness Gate.');
  await appendSummary(formatReadinessSummary(result));
  process.stderr.write('Merge Readiness terminou como INCONCLUSIVE por uma falha interna.\n');
  process.exitCode = 2;
}

async function run(): Promise<void> {
  const repository = process.env.GITHUB_REPOSITORY ?? '';
  const [owner, repositoryName, unexpectedPart] = repository.split('/');
  if (!owner || !repositoryName || unexpectedPart) {
    const result = createInconclusive(undefined, undefined, 'A variável GITHUB_REPOSITORY não está configurada corretamente.');
    await appendSummary(formatReadinessSummary(result));
    process.exitCode = 2;
    return;
  }

  let payload: unknown;
  try {
    payload = JSON.parse(await readFile(required('GITHUB_EVENT_PATH'), 'utf8'));
  } catch {
    const result = createInconclusive(undefined, undefined, 'Não foi possível ler o payload do evento do GitHub Actions.');
    await appendSummary(formatReadinessSummary(result));
    process.exitCode = 2;
    return;
  }

  const resolution = await resolveWorkflowEvent({
    eventName: process.env.GITHUB_EVENT_NAME ?? '',
    payload,
    repository,
    botLogin: process.env.CASHIN_APP_BOT_LOGIN ?? '',
    token: process.env.GITHUB_TOKEN ?? '',
  });

  if (resolution.action === 'skip') {
    await appendSummary(`## Merge Readiness — não avaliado\n\n${resolution.reason}\n`);
    process.stdout.write(`Merge Readiness ignorado: ${resolution.reason}\n`);
    return;
  }

  let result: MergeReadinessResult;
  if (resolution.action === 'inconclusive' || !resolution.pullRequestNumber) {
    result = createInconclusive(resolution.pullRequestNumber, resolution.headSha, resolution.reason);
  } else {
    try {
      const privateKey = await loadPrivateKey();
      result = await evaluateMergeReadiness({
        appId: process.env.GITHUB_APP_ID ?? '',
        privateKey,
        owner,
        repository: repositoryName,
        installationId: process.env.GITHUB_APP_INSTALLATION_ID?.trim() || undefined,
        pullRequestNumber: resolution.pullRequestNumber,
        requiredBaseBranch: 'master',
      });
    } catch {
      result = createInconclusive(resolution.pullRequestNumber, resolution.headSha, 'Credenciais do GitHub App ausentes ou indisponíveis.');
    }
  }

  if (!result.pullRequest.headSha && resolution.headSha) result.pullRequest.headSha = resolution.headSha;

  let statusPublicationError: string | undefined;
  if (result.pullRequest.headSha) {
    try {
      const serverUrl = process.env.GITHUB_SERVER_URL || 'https://github.com';
      const runUrl = `${serverUrl}/${repository}/actions/runs/${required('GITHUB_RUN_ID')}`;
      await publishCommitStatus({
        owner,
        repository: repositoryName,
        headSha: result.pullRequest.headSha,
        token: process.env.GITHUB_TOKEN ?? '',
        targetUrl: runUrl,
        result,
      });
    } catch {
      statusPublicationError = 'Não foi possível publicar o estado no SHA avaliado. Verifique a permissão statuses:write do GITHUB_TOKEN.';
      result.status = INCONCLUSIVE_STATUS;
      result.limitations.push(statusPublicationError);
    }
  } else {
    statusPublicationError = 'Não foi possível associar o resultado a um SHA do Pull Request.';
    result.status = INCONCLUSIVE_STATUS;
    result.limitations.push(statusPublicationError);
  }

  await appendSummary(formatReadinessSummary(result, statusPublicationError));
  process.stdout.write(`Merge Readiness: ${result.status} para o PR #${result.pullRequest.number ?? 'desconhecido'}.\n`);
  process.exitCode = result.status === 'READY_TO_MERGE' ? 0 : result.status === 'BLOCKED' ? 1 : 2;
}

async function loadPrivateKey(): Promise<string> {
  const configuredKey = process.env.GITHUB_APP_PRIVATE_KEY?.trim();
  if (configuredKey) return configuredKey.replace(/\\n/g, '\n');
  const path = process.env.GITHUB_APP_PRIVATE_KEY_PATH?.trim();
  if (!path) return '';
  return readFile(path, 'utf8');
}

function createInconclusive(number: number | undefined, headSha: string | undefined, reason: string): MergeReadinessResult {
  return {
    status: 'INCONCLUSIVE',
    pullRequest: { number: number ?? 0, ...(headSha ? { headSha } : {}) },
    evaluatedAt: new Date().toISOString(),
    evidence: {},
    reasons: [],
    limitations: [reason],
  };
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing environment variable ${name}.`);
  return value;
}

async function appendSummary(summary: string): Promise<void> {
  const path = process.env.GITHUB_STEP_SUMMARY;
  if (path) await appendFile(path, `${summary}\n`, 'utf8');
}
