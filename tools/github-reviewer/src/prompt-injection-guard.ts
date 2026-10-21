import type { AgentStage, AgentStageResult } from './agent-orchestrator.js';

const SUSPICIOUS_INSTRUCTIONS = [
  /ignore\s+(all\s+)?(previous|prior|above)\s+(instructions|rules|prompts)/i,
  /ignore\s+(the\s+)?(system|developer)\s+(prompt|instructions)/i,
  /ignore\s+(the\s+)?agents?\.md/i,
  /disregard\s+(all\s+)?(previous|prior|system|developer)\s+(instructions|rules|prompts)/i,
  /(?:always|must|should)\s+(?:approve|accept)\s+(?:this|the)\s+(?:pull request|pr|change)/i,
  /(?:approve|accept)\s+(?:this|the)\s+(?:pull request|pr|change)\s+(?:regardless|without|even if)/i,
  /(?:this|the)\s+(?:pull request|pr|change)\s+(?:is|must be)\s+(?:approved|accepted)\s+(?:regardless|no matter)/i,
  /(?:the\s+)?(?:review|code review|qa|quality gate)\s+(?:result|decision|status)\s+(?:must|should)\s+be\s+(?:approved|accepted)\s*,?\s*(?:even when|regardless|no matter)/i,
  /(?:ignore|hide|omit|do not report)\s+(?:any\s+)?(?:bugs?|vulnerabilities|security issues|failing tests|blocking findings)/i,
  /(?:do not|don't|never)\s+(?:mention|report|list|describe)\s+(?:any\s+)?(?:issues|problems|findings|bugs|vulnerabilities)/i,
  /(?:ignore|desconsidere|ignora|desconsiderar)\s+(?:todas?\s+)?(?:as\s+)?instru(?:ções|coes|ctions)\s+(?:anteriores|acima|do sistema)/i,
  /(?:aprove|aprovar|marque como aprovado)\s+(?:este|esse|o)\s+(?:pr|pull request|código)\s+(?:independentemente|mesmo se|sem revisar)/i,
  /(?:não|nao)\s+(?:mencione|relate|informe)\s+(?:falhas?|vulnerabilidades|problemas|testes que falharam)/i,
];

export function detectPromptInjection(value: string): boolean {
  return SUSPICIOUS_INSTRUCTIONS.some((pattern) => pattern.test(value));
}

export function createInjectionBlockedResult(stage: AgentStage, commitSha: string): AgentStageResult {
  const reportMarkdown = stage === 'qa'
    ? '## Verificações de QA\n- INCONCLUSIVE: conteúdo do Pull Request contém uma instrução suspeita dirigida ao agente; revisão humana necessária.'
    : stage === 'qualityGate'
      ? '## Checks verificados\n- INCONCLUSIVE: conteúdo do Pull Request contém uma instrução suspeita dirigida ao agente; revisão humana necessária.'
      : '### Code Review — INCONCLUSIVE\nConteúdo do Pull Request contém uma instrução suspeita dirigida ao agente; revisão humana necessária.';
  return { stage, decision: 'INCONCLUSIVE', commitSha, reportMarkdown };
}
