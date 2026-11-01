import type { AgentStage, AgentStageResult } from './agent-orchestrator.js';
import { hasLaterChangeRequest, latestCurrentFormalReview, parseStoredAgentComment, parseStoredFormalReview } from './agent-evidence.js';
import { isAgentStageResult, validateAgentResultCompleteness } from './agent-result-validation.js';
import type { CheckSummary } from './codex-cli-agent.js';

export interface StageEvidenceContext {
  commitSha: string;
  contextHash: string;
  botLogin: string;
  changedFiles: string[];
  acceptanceCriteria: string[];
}

/** Only a deliberately requested manual dispatch may retry unchanged inconclusive evidence. */
export function mayRetryInconclusive(eventName: string, payload: unknown, requested: string | undefined): boolean {
  if (eventName !== 'workflow_dispatch' || requested !== 'true' || !payload || typeof payload !== 'object') return false;
  const inputs = (payload as { inputs?: Record<string, unknown> }).inputs;
  return inputs?.retry_inconclusive === true || inputs?.retry_inconclusive === 'true';
}

export function selectReusableStageResult(
  stage: AgentStage,
  context: StageEvidenceContext,
  reviews: Array<Record<string, unknown>>,
  comments: Array<Record<string, unknown>>,
): AgentStageResult | undefined {
  const latest = latestCurrentFormalReview(reviews, context.commitSha, context.botLogin);
  const formal = stage === 'codeReview' && latest
    ? parseStoredFormalReview(latest, context.commitSha, context.botLogin, context.contextHash) : undefined;
  const comment = comments
    .filter((entry) => typeof entry.updated_at === 'string' && Number.isFinite(Date.parse(entry.updated_at)))
    .sort((left, right) => Date.parse(String(right.updated_at)) - Date.parse(String(left.updated_at)))
    .map((entry) => ({ entry, result: parseStoredAgentComment(entry, stage, context.commitSha, context.botLogin, context.contextHash) }))
    .find(({ result }) => result !== undefined);
  // A comment can record an inconclusive review, but can never replace a formal approval or rejection.
  const candidate = stage !== 'codeReview' ? comment?.result
    : comment?.result?.decision === 'INCONCLUSIVE'
      && (!latest || Date.parse(String(comment.entry.updated_at)) > Date.parse(String(latest.submitted_at)))
      ? comment.result : formal;
  if (!candidate || !isAgentStageResult(candidate)
    || validateAgentResultCompleteness(candidate, { stage, ...context }).length > 0) return undefined;
  if (stage === 'codeReview' && candidate.decision === 'APPROVED'
    && latest && hasLaterChangeRequest(reviews, latest, context.commitSha, context.botLogin)) return undefined;
  return candidate;
}

/** Consolidates authenticated API evidence; performs no model call and does not perform QA itself. */
export function evaluateDeterministicQualityGate(input: StageEvidenceContext & {
  checks: CheckSummary;
  reviews: Array<Record<string, unknown>>;
  comments: Array<Record<string, unknown>>;
  priorResults: unknown[];
}): AgentStageResult {
  const reasons: string[] = [];
  let rejected = false;
  const checkNames: Array<keyof CheckSummary> = ['api', 'web', 'githubReviewer', 'sonarQube', 'sonarCloud'];
  for (const name of checkNames) {
    const state = input.checks[name];
    if (state !== 'PASSED') reasons.push(`Check ${name}: ${state ?? 'UNKNOWN'}.`);
    if (state === 'FAILED') rejected = true;
  }
  if (!/^[a-f0-9]{40}$/i.test(input.commitSha) || !/^[a-f0-9]{64}$/i.test(input.contextHash) || !input.botLogin.trim()) {
    throw new Error('Quality Gate requires a valid SHA, context hash, and App identity.');
  }
  const latest = latestCurrentFormalReview(input.reviews, input.commitSha, input.botLogin);
  const formal = selectReusableStageResult('codeReview', input, input.reviews, input.comments);
  const qa = selectReusableStageResult('qa', input, [], input.comments);
  const laterRejection = latest && hasLaterChangeRequest(input.reviews, latest, input.commitSha, input.botLogin);
  if (laterRejection) { reasons.push('Existe solicitação de alterações posterior à revisão formal.'); rejected = true; }
  for (const stage of ['codeReview', 'qa'] as const) {
    const published = stage === 'codeReview' ? formal : qa;
    const artifacts = input.priorResults.filter((result) => isAgentStageResult(result) && result.stage === stage);
    const artifact = artifacts[0];
    if (!published || !isAgentStageResult(published)
      || validateAgentResultCompleteness(published, { stage, ...input }).length > 0) {
      reasons.push(`Evidência publicada de ${stage} ausente, incompleta ou desatualizada.`);
      continue;
    }
    if (published.decision !== 'APPROVED') {
      reasons.push(`${stage}: ${published.decision}.`);
      if (published.decision === 'CHANGES_REQUESTED') rejected = true;
    }
    if (artifacts.length !== 1 || !isAgentStageResult(artifact)
      || artifact.commitSha !== input.commitSha || artifact.contextHash !== input.contextHash
      || artifact.decision !== published.decision
      || JSON.stringify(artifact.evidence) !== JSON.stringify(published.evidence)) {
      reasons.push(`Artefato de ${stage} não corresponde à evidência autenticada publicada.`);
    }
  }
  const decision = reasons.length === 0 ? 'APPROVED' : rejected ? 'CHANGES_REQUESTED' : 'INCONCLUSIVE';
  return {
    stage: 'qualityGate', decision, commitSha: input.commitSha, contextHash: input.contextHash,
    reportMarkdown: [
      '**Checks verificados:**',
      ...checkNames.map((name) => `- ${name}: ${input.checks[name] ?? 'UNKNOWN'}; SHA ${input.commitSha}.`),
      '',
      reasons.length ? '**Bloqueios e limitações:**' : '**Consolidação determinística:**',
      ...(reasons.length ? reasons.map((reason) => `- ${reason}`) : [
        '- Code Review formal e QA publicados pelo App, completos e aprovados para o mesmo SHA e contexto.',
        '- Artefatos das etapas correspondem às evidências publicadas. Nenhuma chamada de modelo realizada pelo Coordinator.',
      ]),
      '',
      'Esta consolidação não executa testes, não substitui QA e não autoriza merge; proteções e conversas pertencem ao Merge Readiness.',
    ].join('\n'),
    evidence: { reviewComplete: reasons.length === 0 || rejected, changedFilesReviewed: [], riskAreas: [], findings: [], acceptanceCriteria: [] },
  };
}
