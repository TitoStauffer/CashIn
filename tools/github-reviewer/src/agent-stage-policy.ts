import type { AgentStage, AgentStageResult } from './agent-orchestrator.js';
import { hasLaterChangeRequest, latestCurrentFormalReview, parseStoredAgentComment, parseStoredFormalReview } from './agent-evidence.js';
import { isAgentStageResult, validateAgentResultCompleteness } from './agent-result-validation.js';
import type { CheckSummary } from './codex-cli-agent.js';
import { LIGHT_TRACK_RULE, classifyReviewTrack, runtimeAffectingPaths, type ReviewTrack } from './review-track.js';

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
}): AgentStageResult & { reviewTrack: ReviewTrack } {
  const reasons: string[] = [];
  let rejected = false;
  // The track is recomputed here from the same changed-file list the stage read from the API, never
  // taken from a previous report or from the Pull Request body.
  const reviewTrack = classifyReviewTrack(input.changedFiles);
  const requiredStages = reviewTrack === 'full' ? ['codeReview', 'qa'] as const : ['codeReview'] as const;
  const checkNames: Array<keyof CheckSummary> = ['api', 'web', 'githubReviewer', 'sonarQube', 'sonarCloud'];
  for (const name of checkNames) {
    const state = input.checks[name];
    if (state !== 'PASSED') reasons.push(`Check ${name}: ${state ?? 'UNKNOWN'}.`);
    if (state === 'FAILED') rejected = true;
  }
  if (!/^[a-f0-9]{40}$/i.test(input.commitSha) || !/^[a-f0-9]{64}$/i.test(input.contextHash) || !input.botLogin.trim()) {
    throw new Error('Quality Gate requires a valid SHA, context hash, and App identity.');
  }
  // The changed-file list decides the track, so an absent list is a broken stage, not a lighter one.
  // Throwing here fails the job closed instead of letting a TypeError surface from the evidence checks.
  if (!Array.isArray(input.changedFiles)) {
    throw new Error('Quality Gate requires the changed-file list that determines the review track.');
  }
  const latest = latestCurrentFormalReview(input.reviews, input.commitSha, input.botLogin);
  const formal = selectReusableStageResult('codeReview', input, input.reviews, input.comments);
  const qa = selectReusableStageResult('qa', input, [], input.comments);
  const laterRejection = latest && hasLaterChangeRequest(input.reviews, latest, input.commitSha, input.botLogin);
  if (laterRejection) { reasons.push('Existe solicitação de alterações posterior à revisão formal.'); rejected = true; }
  for (const stage of requiredStages) {
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
  // The light track does not require QA, but it never ignores a QA that ran and refused: skipping the
  // stage is a decision about cost, not permission to drop evidence that exists for this very context.
  if (reviewTrack === 'light' && qa && isAgentStageResult(qa) && qa.decision !== 'APPROVED') {
    reasons.push(`qa: ${qa.decision}.`);
    if (qa.decision === 'CHANGES_REQUESTED') rejected = true;
  }
  const decision = reasons.length === 0 ? 'APPROVED' : rejected ? 'CHANGES_REQUESTED' : 'INCONCLUSIVE';
  const runtimePaths = runtimeAffectingPaths(input.changedFiles);
  return {
    stage: 'qualityGate', decision, reviewTrack, commitSha: input.commitSha, contextHash: input.contextHash,
    reportMarkdown: [
      // Contract with another package: `declaresLightTrack`, in tools/jira-dispatcher/src/post-merge/service.ts,
      // reads this exact line to decide whether the post-merge may close an issue without a QA report.
      // tools/jira-dispatcher/test/review-track-contract.test.ts runs this code against that parser, so a
      // format change here that the parser does not follow fails CI instead of leaving light issues open.
      `**Trilho de revisão:** ${reviewTrack === 'light' ? 'leve' : 'completo'}.`,
      reviewTrack === 'light'
        ? `- Todos os ${input.changedFiles.length} arquivo(s) alterado(s) são ${LIGHT_TRACK_RULE}, então o QA não é exigido. Classificado pela lista de arquivos lida da API do GitHub, não pelo corpo do Pull Request.`
        // Os caminhos vêm da API e são interpolados num corpo que o pós-merge analisa com regex ancorada em
      // início de linha. Um caminho com quebra de linha poderia forjar a declaração de trilho, então as
      // quebras são removidas antes de entrar no relatório.
      : `- Exige QA porque ${runtimePaths.length} arquivo(s) alteram runtime: ${runtimePaths.slice(0, 10).map((path) => `\`${path.replace(/[\r\n]+/g, ' ')}\``).join(', ')}${runtimePaths.length > 10 ? ', …' : ''}.`,
      '',
      '**Checks verificados:**',
      ...checkNames.map((name) => `- ${name}: ${input.checks[name] ?? 'UNKNOWN'}; SHA ${input.commitSha}.`),
      '',
      reasons.length ? '**Bloqueios e limitações:**' : '**Consolidação determinística:**',
      ...(reasons.length ? reasons.map((reason) => `- ${reason}`) : [
        reviewTrack === 'full'
          ? '- Code Review formal e QA publicados pelo App, completos e aprovados para o mesmo SHA e contexto.'
          : '- Code Review formal publicado pelo App, completo e aprovado para o mesmo SHA e contexto. QA dispensado pelo trilho leve.',
        '- Artefatos das etapas correspondem às evidências publicadas. Nenhuma chamada de modelo realizada pelo Coordinator.',
      ]),
      '',
      'Esta consolidação não executa testes, não substitui QA e não autoriza merge; proteções e conversas pertencem ao Merge Readiness.',
    ].join('\n'),
    evidence: { reviewComplete: reasons.length === 0 || rejected, changedFilesReviewed: [], riskAreas: [], findings: [], acceptanceCriteria: [] },
  };
}
