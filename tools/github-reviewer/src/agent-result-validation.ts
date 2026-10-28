import type { AgentDecision, AgentStage, AgentStageResult } from './agent-orchestrator.js';

export const REVIEW_RISK_AREAS = [
  'business-logic',
  'security',
  'error-handling',
  'compatibility',
  'architecture',
  'tests',
] as const;

export type ReviewRiskArea = typeof REVIEW_RISK_AREAS[number];
export type ReviewCoverageStatus = 'REVIEWED' | 'NOT_APPLICABLE' | 'INCONCLUSIVE';
export type AcceptanceCriterionStatus = 'PASSED' | 'FAILED' | 'NOT_APPLICABLE' | 'INCONCLUSIVE';

export interface AgentFinding {
  severity: 'BLOCKER' | 'HIGH' | 'MEDIUM' | 'LOW';
  file: string;
  line: string;
  problem: string;
  impact: string;
  suggestedFix: string;
}

export interface AgentEvaluationEvidence {
  reviewComplete: boolean;
  changedFilesReviewed: string[];
  riskAreas: Array<{ area: ReviewRiskArea; status: ReviewCoverageStatus; evidence: string }>;
  findings: AgentFinding[];
  acceptanceCriteria: Array<{ criterion: string; status: AcceptanceCriterionStatus; evidence: string }>;
}

export interface AgentResultExpectation {
  stage: AgentStage;
  commitSha: string;
  changedFiles: string[];
  acceptanceCriteria: string[];
}

export function extractAcceptanceCriteria(pullRequestBody: string): string[] {
  const lines = pullRequestBody.split(/\r?\n/);
  const start = lines.findIndex((line) => /^##\s+8\.\s+Crit[eé]rios de aceita[cç][aã]o\s*$/i.test(line));
  if (start < 0) return [];
  const sectionLines: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^##\s+\d+\./.test(line)) break;
    sectionLines.push(line);
  }
  const section = sectionLines.join('\n');
  const criteria = [...section.matchAll(/^\s*[-*]\s+(?:\[[ xX]\]\s*)?(.+?)\s*$/gm)]
    .map((match) => match[1].trim())
    .filter((criterion) => criterion.length > 0 && !/^Crit[eé]rio\s+\d+:?$/i.test(criterion));
  return [...new Set(criteria)];
}

export function validateAgentResultCompleteness(result: AgentStageResult, expected: AgentResultExpectation): string[] {
  const reasons: string[] = [];
  if (result.stage !== expected.stage) reasons.push('A etapa do resultado não corresponde à etapa solicitada.');
  if (result.commitSha.toLowerCase() !== expected.commitSha.toLowerCase()) reasons.push('O SHA do resultado não corresponde ao SHA solicitado.');
  if (!result.evidence) return [...reasons, 'A evidência estruturada da etapa está ausente.'];

  const evidence = result.evidence;
  if (!evidence.reviewComplete && result.decision !== 'INCONCLUSIVE') {
    reasons.push('Uma análise incompleta só pode terminar como INCONCLUSIVE.');
  }
  if (expected.stage === 'codeReview') validateCodeReviewEvidence(result.decision, evidence, expected.changedFiles, reasons);
  if (expected.stage === 'qa') validateQaEvidence(result.decision, evidence, expected.acceptanceCriteria, reasons);
  if (expected.stage === 'qualityGate' && result.decision !== 'INCONCLUSIVE' && !evidence.reviewComplete) reasons.push('O Coordinator não confirmou a consolidação completa das evidências.');
  return reasons;
}

export function failClosedIncompleteResult(result: AgentStageResult, expected: AgentResultExpectation): AgentStageResult {
  const reasons = validateAgentResultCompleteness(result, expected);
  if (reasons.length === 0) return result;
  const evidence = normalizeInconclusiveEvidence(result.evidence, expected);
  return {
    ...result,
    decision: 'INCONCLUSIVE',
    evidence,
    reportMarkdown: `${result.reportMarkdown.trim().replace(/(Code Review\s+[—-]\s*)(APPROVED|CHANGES_REQUESTED|INCONCLUSIVE)/i, '$1INCONCLUSIVE')}\n\n**Limitações de completude:**\n${reasons.map((reason) => `- ${reason}`).join('\n')}`,
  };
}

function normalizeInconclusiveEvidence(
  source: AgentEvaluationEvidence | undefined,
  expected: AgentResultExpectation,
): AgentEvaluationEvidence {
  const evidence = source ?? {
    reviewComplete: false,
    changedFilesReviewed: [],
    riskAreas: [],
    findings: [],
    acceptanceCriteria: [],
  };
  const expectedFiles = normalizedSet(expected.changedFiles);
  const reviewedFiles = [...new Set(evidence.changedFilesReviewed
    .map((path) => path.trim().replace(/\\/g, '/'))
    .filter((path) => expectedFiles.has(path)))];
  const riskAreas = expected.stage === 'codeReview'
    ? REVIEW_RISK_AREAS.map((area) => evidence.riskAreas.find((entry) => entry.area === area) ?? {
      area,
      status: 'INCONCLUSIVE' as const,
      evidence: 'Área não avaliada na rodada; resultado mantido fechado para revisão posterior.',
    })
    : uniqueBy(evidence.riskAreas, ({ area }) => area);
  const acceptanceCriteria = expected.stage === 'qa'
    ? expected.acceptanceCriteria.map((criterion) => evidence.acceptanceCriteria.find((entry) => normalize(entry.criterion) === normalize(criterion)) ?? {
      criterion,
      status: 'INCONCLUSIVE' as const,
      evidence: 'Critério não avaliado na rodada; resultado mantido fechado para revisão posterior.',
    })
    : uniqueBy(evidence.acceptanceCriteria, ({ criterion }) => normalize(criterion));
  return {
    reviewComplete: false,
    changedFilesReviewed: reviewedFiles,
    riskAreas,
    findings: uniqueBy(evidence.findings, ({ file, line, problem }) => `${file.trim()}\0${line.trim()}\0${problem.trim()}`),
    acceptanceCriteria,
  };
}

export function encodeAgentEvidence(evidence: AgentEvaluationEvidence): string {
  const serialized = JSON.stringify(evidence);
  if (Buffer.byteLength(serialized, 'utf8') > 40_000) throw new Error('Agent evidence exceeds the supported size.');
  return Buffer.from(serialized, 'utf8').toString('base64');
}

export function decodeAgentEvidence(value: string): AgentEvaluationEvidence | undefined {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, 'base64').toString('utf8'));
    return isAgentEvaluationEvidence(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export function isAgentEvaluationEvidence(value: unknown): value is AgentEvaluationEvidence {
  if (!isRecord(value)
    || typeof value.reviewComplete !== 'boolean'
    || !isStringArray(value.changedFilesReviewed)
    || !Array.isArray(value.riskAreas)
    || !Array.isArray(value.findings)
    || !Array.isArray(value.acceptanceCriteria)
    || value.changedFilesReviewed.length > 200
    || value.riskAreas.length > REVIEW_RISK_AREAS.length
    || value.findings.length > 100
    || value.acceptanceCriteria.length > 100) return false;
  return value.riskAreas.every((entry) => isRecord(entry)
      && REVIEW_RISK_AREAS.includes(entry.area as ReviewRiskArea)
      && ['REVIEWED', 'NOT_APPLICABLE', 'INCONCLUSIVE'].includes(String(entry.status))
      && nonEmpty(entry.evidence))
    && value.findings.every((entry) => isRecord(entry)
      && ['BLOCKER', 'HIGH', 'MEDIUM', 'LOW'].includes(String(entry.severity))
      && nonEmpty(entry.file) && nonEmpty(entry.line) && nonEmpty(entry.problem)
      && nonEmpty(entry.impact) && nonEmpty(entry.suggestedFix))
    && value.acceptanceCriteria.every((entry) => isRecord(entry)
      && nonEmpty(entry.criterion)
      && ['PASSED', 'FAILED', 'NOT_APPLICABLE', 'INCONCLUSIVE'].includes(String(entry.status))
      && nonEmpty(entry.evidence));
}

function validateCodeReviewEvidence(
  decision: AgentDecision,
  evidence: AgentEvaluationEvidence,
  expectedFiles: string[],
  reasons: string[],
): void {
  const expected = normalizedSet(expectedFiles);
  const reviewed = normalizedSet(evidence.changedFilesReviewed);
  const missing = [...expected].filter((path) => !reviewed.has(path));
  const unexpected = [...reviewed].filter((path) => !expected.has(path));
  if (decision !== 'INCONCLUSIVE' && missing.length) reasons.push(`Arquivos alterados não revisados: ${missing.join(', ')}.`);
  if (unexpected.length) reasons.push(`Arquivos declarados como revisados não pertencem ao diff: ${unexpected.join(', ')}.`);
  if (reviewed.size !== evidence.changedFilesReviewed.length) reasons.push('Há arquivos duplicados na cobertura do Code Review.');

  const riskAreas = new Map(evidence.riskAreas.map((entry) => [entry.area, entry]));
  if (riskAreas.size !== evidence.riskAreas.length) reasons.push('Há áreas de risco duplicadas no Code Review.');
  for (const area of REVIEW_RISK_AREAS) {
    if (!riskAreas.has(area)) reasons.push(`Área de risco não avaliada: ${area}.`);
  }
  if ([...riskAreas.values()].some(({ status }) => status === 'INCONCLUSIVE') && decision !== 'INCONCLUSIVE') {
    reasons.push('Área de risco inconclusiva exige decisão INCONCLUSIVE.');
  }
  if (decision === 'APPROVED' && evidence.findings.some(({ severity }) => severity === 'BLOCKER' || severity === 'HIGH')) {
    reasons.push('Code Review aprovado contém achado BLOCKER ou HIGH.');
  }
  if (decision === 'CHANGES_REQUESTED' && evidence.findings.length === 0) reasons.push('Code Review solicitou alterações sem registrar achados estruturados.');
  const findingKeys = new Set(evidence.findings.map(({ file, line, problem }) => `${file.trim()}\0${line.trim()}\0${problem.trim()}`));
  if (findingKeys.size !== evidence.findings.length) reasons.push('Há achados duplicados no Code Review.');
}

function validateQaEvidence(
  decision: AgentDecision,
  evidence: AgentEvaluationEvidence,
  expectedCriteria: string[],
  reasons: string[],
): void {
  if (expectedCriteria.length === 0 && decision !== 'INCONCLUSIVE') reasons.push('O Pull Request não contém critérios de aceitação verificáveis.');
  const expected = normalizedSet(expectedCriteria);
  const evaluated = normalizedSet(evidence.acceptanceCriteria.map(({ criterion }) => criterion));
  const missing = [...expected].filter((criterion) => !evaluated.has(criterion));
  const unexpected = [...evaluated].filter((criterion) => !expected.has(criterion));
  if (missing.length) reasons.push(`Critérios de aceitação sem resultado e evidência: ${missing.join(' | ')}.`);
  if (unexpected.length) reasons.push(`Critérios avaliados não correspondem ao PR: ${unexpected.join(' | ')}.`);
  if (evaluated.size !== evidence.acceptanceCriteria.length) reasons.push('Há critérios de aceitação duplicados no resultado de QA.');
  const statuses = evidence.acceptanceCriteria.map(({ status }) => status);
  if (statuses.includes('INCONCLUSIVE') && decision !== 'INCONCLUSIVE') reasons.push('Critério inconclusivo exige decisão INCONCLUSIVE.');
  if (statuses.includes('FAILED') && decision !== 'CHANGES_REQUESTED' && decision !== 'INCONCLUSIVE') reasons.push('Critério reprovado exige CHANGES_REQUESTED ou INCONCLUSIVE quando a rodada também tiver limitações.');
  if (decision === 'INCONCLUSIVE' && evidence.reviewComplete && !statuses.includes('INCONCLUSIVE')) reasons.push('QA inconclusivo deve registrar ao menos uma limitação ou marcar a rodada como incompleta.');
  if (decision === 'CHANGES_REQUESTED' && !statuses.includes('FAILED')) reasons.push('QA solicitou alterações sem critério reprovado.');
  if (decision === 'APPROVED' && statuses.some((status) => status !== 'PASSED' && status !== 'NOT_APPLICABLE')) {
    reasons.push('QA aprovado contém critério não aprovado.');
  }
  if (decision !== 'INCONCLUSIVE' && !evidence.reviewComplete) reasons.push('O QA não confirmou a execução de todos os critérios seguros e independentes.');
}

function normalizedSet(values: string[]): Set<string> {
  return new Set(values.map(normalize).filter(Boolean));
}

function normalize(value: string): string {
  return value.trim().replace(/\\/g, '/');
}

function uniqueBy<T>(values: T[], key: (value: T) => string): T[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const current = key(value);
    if (seen.has(current)) return false;
    seen.add(current);
    return true;
  });
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string' && item.trim().length > 0);
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
