export type AgentStage = 'codeReview' | 'qa' | 'qualityGate';
export type AgentDecision = 'APPROVED' | 'CHANGES_REQUESTED' | 'INCONCLUSIVE';
export type OrchestrationStatus = 'COMPLETED' | 'BLOCKED' | 'INCONCLUSIVE' | 'ALREADY_RUNNING';

export interface AgentStageResult {
  stage: AgentStage;
  decision: AgentDecision;
  commitSha: string;
  reportMarkdown: string;
}

export interface QualityPrerequisites {
  commitSha: string;
  ci: 'PASSED' | 'FAILED' | 'PENDING' | 'UNKNOWN';
  sonar: 'PASSED' | 'FAILED' | 'PENDING' | 'UNKNOWN';
}

export interface OrchestrationContext {
  repository: string;
  pullRequestNumber: number;
  commitSha: string;
  executionId: string;
  priorResults: AgentStageResult[];
}

export interface AgentOrchestratorDependencies {
  readHeadSha(pullRequestNumber: number): Promise<string>;
  readPrerequisites(pullRequestNumber: number): Promise<QualityPrerequisites>;
  claimExecution(context: OrchestrationContext): Promise<boolean>;
  releaseExecution(context: OrchestrationContext, status: OrchestrationStatus): Promise<void>;
  executeAgent(stage: AgentStage, context: OrchestrationContext, signal: AbortSignal): Promise<AgentStageResult>;
  agentTimeoutMs?: number;
  publishReport(result: AgentStageResult & { stage: 'qa' | 'qualityGate' }, context: OrchestrationContext): Promise<void>;
  submitFormalCodeReview(result: AgentStageResult, context: OrchestrationContext): Promise<boolean>;
}

export interface OrchestrationResult {
  status: OrchestrationStatus;
  context: OrchestrationContext;
  completedStages: AgentStage[];
  reasons: string[];
}

export interface AgentOrchestratorInput {
  repository: string;
  pullRequestNumber: number;
  expectedHeadSha?: string;
  executionId: string;
}

const FULL_SHA = /^[a-f0-9]{40}$/i;

/**
 * Coordinates agent stages using injected infrastructure adapters. This module
 * never creates an agent or makes a model call by itself.
 */
export async function orchestratePullRequestQuality(
  input: AgentOrchestratorInput,
  dependencies: AgentOrchestratorDependencies,
): Promise<OrchestrationResult> {
  validateInput(input);
  const headSha = await safely(() => dependencies.readHeadSha(input.pullRequestNumber));
  if (!headSha || !FULL_SHA.test(headSha)) {
    return result('INCONCLUSIVE', context(input, input.expectedHeadSha ?? ''), [], 'Não foi possível confirmar o HEAD atual do Pull Request.');
  }
  if (input.expectedHeadSha && headSha.toLowerCase() !== input.expectedHeadSha.toLowerCase()) {
    return result('INCONCLUSIVE', context(input, headSha), [], 'O HEAD mudou antes do início da execução.');
  }

  const runContext = context(input, headSha);
  const claimed = await safely(() => dependencies.claimExecution(runContext));
  if (claimed !== true) {
    return result(claimed === false ? 'ALREADY_RUNNING' : 'INCONCLUSIVE', runContext, [], claimed === false
      ? 'Já existe uma execução ativa para este Pull Request e SHA.'
      : 'Não foi possível reservar a execução de forma segura.');
  }

  let finalStatus: OrchestrationStatus = 'INCONCLUSIVE';
  let outcome: OrchestrationResult;
  try {
    outcome = await runClaimedExecution(runContext, dependencies);
    finalStatus = outcome.status;
  } catch {
    outcome = result('INCONCLUSIVE', runContext, [], 'Falha interna ao coordenar as etapas de qualidade.');
  }

  try {
    await dependencies.releaseExecution(runContext, finalStatus);
  } catch {
    return result('INCONCLUSIVE', runContext, outcome.completedStages, 'Não foi possível liberar a reserva da execução com segurança.');
  }
  return outcome;
}

async function runClaimedExecution(
  runContext: OrchestrationContext,
  dependencies: AgentOrchestratorDependencies,
): Promise<OrchestrationResult> {
  const { commitSha, pullRequestNumber } = runContext;
  const completedStages: AgentStage[] = [];
  const prerequisites = await safely(() => dependencies.readPrerequisites(pullRequestNumber));
  if (!isQualityPrerequisites(prerequisites) || prerequisites.commitSha.toLowerCase() !== commitSha.toLowerCase()) {
    return result('INCONCLUSIVE', runContext, completedStages, 'As evidências de CI e Sonar não puderam ser associadas ao HEAD atual.');
  }
  if (prerequisites.ci === 'FAILED' || prerequisites.sonar === 'FAILED') {
    return result('BLOCKED', runContext, completedStages, 'CI ou SonarQube falhou para o HEAD atual.');
  }
  if (prerequisites.ci !== 'PASSED' || prerequisites.sonar !== 'PASSED') {
    return result('INCONCLUSIVE', runContext, completedStages, 'CI e SonarQube precisam estar aprovados antes do Code Review.');
  }

  const review = await runStage('codeReview', runContext, dependencies, completedStages);
  if (!review.ok) return result(review.status, runContext, completedStages, review.reason);
  if (review.stageResult.decision !== 'APPROVED') {
    if (review.stageResult.decision === 'CHANGES_REQUESTED') {
      const formalRejection = await safely(() => dependencies.submitFormalCodeReview(review.stageResult, runContext));
      if (formalRejection !== true) {
        return result('INCONCLUSIVE', runContext, completedStages, 'Não foi possível registrar a decisão formal do Code Review.');
      }
      completedStages.push('codeReview');
    }
    return result(review.stageResult.decision === 'CHANGES_REQUESTED' ? 'BLOCKED' : 'INCONCLUSIVE', runContext, completedStages,
      `Code Review terminou como ${review.stageResult.decision}. QA e Coordinator não foram executados.`);
  }

  const formalReviewSubmitted = await safely(() => dependencies.submitFormalCodeReview(review.stageResult, runContext));
  if (formalReviewSubmitted !== true) {
    return result('INCONCLUSIVE', runContext, completedStages, 'Não foi possível registrar a aprovação formal do Code Review.');
  }
  const headAfterFormalReview = await safely(() => dependencies.readHeadSha(pullRequestNumber));
  if (headAfterFormalReview?.toLowerCase() !== commitSha.toLowerCase()) {
    return result('INCONCLUSIVE', runContext, completedStages, 'O HEAD mudou após a aprovação formal; QA e Coordinator não foram executados.');
  }
  completedStages.push('codeReview');
  runContext.priorResults.push(review.stageResult);

  const qa = await runStage('qa', runContext, dependencies, completedStages);
  if (!qa.ok) return result(qa.status, runContext, completedStages, qa.reason);
  if (qa.stageResult.decision !== 'APPROVED') {
    return result(qa.stageResult.decision === 'CHANGES_REQUESTED' ? 'BLOCKED' : 'INCONCLUSIVE', runContext, completedStages,
      `QA terminou como ${qa.stageResult.decision}. O Coordinator não foi executado.`);
  }
  runContext.priorResults.push(qa.stageResult);

  const qualityGate = await runStage('qualityGate', runContext, dependencies, completedStages);
  if (!qualityGate.ok) return result(qualityGate.status, runContext, completedStages, qualityGate.reason);
  if (qualityGate.stageResult.decision !== 'APPROVED') {
    return result(qualityGate.stageResult.decision === 'CHANGES_REQUESTED' ? 'BLOCKED' : 'INCONCLUSIVE', runContext, completedStages,
      `Quality Gate Coordinator terminou como ${qualityGate.stageResult.decision}.`);
  }

  return result('COMPLETED', runContext, completedStages, 'Code Review formal, QA e Quality Gate Coordinator concluídos para o mesmo SHA.');
}

async function runStage(
  stage: AgentStage,
  context: OrchestrationContext,
  dependencies: AgentOrchestratorDependencies,
  completedStages: AgentStage[],
): Promise<{ ok: true; stageResult: AgentStageResult } | { ok: false; status: OrchestrationStatus; reason: string }> {
  const currentHead = await safely(() => dependencies.readHeadSha(context.pullRequestNumber));
  if (currentHead?.toLowerCase() !== context.commitSha.toLowerCase()) {
    return { ok: false, status: 'INCONCLUSIVE', reason: 'O HEAD mudou durante a execução; etapas restantes foram canceladas.' };
  }

  const stageResult = await executeAgentWithTimeout(stage, context, dependencies);
  if (!stageResult) {
    return { ok: false, status: 'INCONCLUSIVE', reason: `A execução de ${stage} falhou ou expirou.` };
  }
  if (!isAgentStageResult(stageResult) || stageResult.stage !== stage || stageResult.commitSha.toLowerCase() !== context.commitSha.toLowerCase()) {
    return { ok: false, status: 'INCONCLUSIVE', reason: `A evidência de ${stage} está incompleta ou associada a outro SHA.` };
  }

  const headAfterExecution = await safely(() => dependencies.readHeadSha(context.pullRequestNumber));
  if (headAfterExecution?.toLowerCase() !== context.commitSha.toLowerCase()) {
    return { ok: false, status: 'INCONCLUSIVE', reason: 'O HEAD mudou durante a análise; evidência obsoleta não foi publicada.' };
  }

  if (stage === 'codeReview') return { ok: true, stageResult };

  const reportResult = stageResult as AgentStageResult & { stage: 'qa' | 'qualityGate' };
  const published = await safely(() => dependencies.publishReport(reportResult, context));
  if (!published) return { ok: false, status: 'INCONCLUSIVE', reason: `Não foi possível publicar o relatório de ${stage}.` };
  completedStages.push(stage);
  return { ok: true, stageResult };
}

async function executeAgentWithTimeout(
  stage: AgentStage,
  context: OrchestrationContext,
  dependencies: AgentOrchestratorDependencies,
): Promise<AgentStageResult | undefined> {
  const timeoutMs = dependencies.agentTimeoutMs ?? 15 * 60 * 1000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) return undefined;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      dependencies.executeAgent(stage, context, controller.signal),
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => {
          controller.abort();
          resolve(undefined);
        }, timeoutMs);
      }),
    ]);
  } catch {
    return undefined;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function validateInput(input: AgentOrchestratorInput): void {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(input.repository)) throw new Error('Repository must use owner/name format.');
  if (!Number.isSafeInteger(input.pullRequestNumber) || input.pullRequestNumber < 1) throw new Error('Pull request number must be a positive integer.');
  if (!input.executionId.trim()) throw new Error('Execution ID must not be empty.');
  if (input.expectedHeadSha && !FULL_SHA.test(input.expectedHeadSha)) throw new Error('Expected head SHA must be a full commit SHA.');
}

function isQualityPrerequisites(value: QualityPrerequisites | undefined): value is QualityPrerequisites {
  return typeof value?.commitSha === 'string'
    && FULL_SHA.test(value.commitSha)
    && ['PASSED', 'FAILED', 'PENDING', 'UNKNOWN'].includes(value.ci)
    && ['PASSED', 'FAILED', 'PENDING', 'UNKNOWN'].includes(value.sonar);
}

function isAgentStageResult(value: AgentStageResult | undefined): value is AgentStageResult {
  return typeof value?.stage === 'string'
    && ['codeReview', 'qa', 'qualityGate'].includes(value.stage)
    && ['APPROVED', 'CHANGES_REQUESTED', 'INCONCLUSIVE'].includes(value.decision)
    && typeof value.commitSha === 'string'
    && FULL_SHA.test(value.commitSha)
    && typeof value.reportMarkdown === 'string'
    && value.reportMarkdown.trim().length > 0;
}

function context(input: AgentOrchestratorInput, commitSha: string): OrchestrationContext {
  return { repository: input.repository, pullRequestNumber: input.pullRequestNumber, commitSha, executionId: input.executionId, priorResults: [] };
}

function result(status: OrchestrationStatus, context: OrchestrationContext, completedStages: AgentStage[], reason: string): OrchestrationResult {
  return { status, context, completedStages, reasons: [reason] };
}

async function safely<T>(operation: () => Promise<T>): Promise<T | undefined> {
  try {
    return await operation();
  } catch {
    return undefined;
  }
}
