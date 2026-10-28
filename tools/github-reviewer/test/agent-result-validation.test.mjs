import assert from 'node:assert/strict';
import test from 'node:test';
import { extractAcceptanceCriteria, REVIEW_RISK_AREAS, validateAgentResultCompleteness } from '../dist/agent-result-validation.js';

const sha = 'a'.repeat(40);
const risks = REVIEW_RISK_AREAS.map((area) => ({ area, status: 'REVIEWED', evidence: `Revisado: ${area}` }));

function result(stage, evidence, decision = 'APPROVED') {
  return { stage, decision, commitSha: sha, reportMarkdown: 'Evidência estruturada.', evidence };
}

test('rejects Code Review that omits one changed file', () => {
  const reasons = validateAgentResultCompleteness(result('codeReview', {
    reviewComplete: true, changedFilesReviewed: ['src/a.ts'], riskAreas: risks, findings: [], acceptanceCriteria: [],
  }), { stage: 'codeReview', commitSha: sha, changedFiles: ['src/a.ts', 'src/b.ts'], acceptanceCriteria: [] });
  assert.match(reasons.join(' '), /src\/b\.ts/);
});

test('rejects Code Review that omits a required risk area', () => {
  const reasons = validateAgentResultCompleteness(result('codeReview', {
    reviewComplete: true, changedFilesReviewed: ['src/a.ts'], riskAreas: risks.slice(0, -1), findings: [], acceptanceCriteria: [],
  }), { stage: 'codeReview', commitSha: sha, changedFiles: ['src/a.ts'], acceptanceCriteria: [] });
  assert.match(reasons.join(' '), /tests/);
});

test('rejects approval when a risk area remains inconclusive', () => {
  const inconclusiveRisks = risks.map((entry) => entry.area === 'security' ? { ...entry, status: 'INCONCLUSIVE' } : entry);
  const reasons = validateAgentResultCompleteness(result('codeReview', {
    reviewComplete: true, changedFilesReviewed: ['src/a.ts'], riskAreas: inconclusiveRisks, findings: [], acceptanceCriteria: [],
  }), { stage: 'codeReview', commitSha: sha, changedFiles: ['src/a.ts'], acceptanceCriteria: [] });
  assert.match(reasons.join(' '), /Área de risco inconclusiva/);
});

test('rejects QA that does not report every acceptance criterion', () => {
  const reasons = validateAgentResultCompleteness(result('qa', {
    reviewComplete: true, changedFilesReviewed: [], riskAreas: [], findings: [],
    acceptanceCriteria: [{ criterion: 'Importar OFX', status: 'PASSED', evidence: 'Teste de integração aprovado.' }],
  }), { stage: 'qa', commitSha: sha, changedFiles: [], acceptanceCriteria: ['Importar OFX', 'Evitar duplicidade'] });
  assert.match(reasons.join(' '), /Evitar duplicidade/);
});

test('rejects a result without structured evidence', () => {
  const reasons = validateAgentResultCompleteness(result('qa', undefined), {
    stage: 'qa', commitSha: sha, changedFiles: [], acceptanceCriteria: ['Importar OFX'],
  });
  assert.match(reasons.join(' '), /evidência estruturada.*ausente/i);
});

test('extracts only checklist items from the acceptance criteria section', () => {
  assert.deepEqual(extractAcceptanceCriteria([
    '## 8. Critérios de aceitação',
    '- [ ] Importar OFX',
    '- [x] Evitar duplicidade',
    '## 9. Segurança e qualidade',
    '- [ ] Não expor segredos',
  ].join('\n')), ['Importar OFX', 'Evitar duplicidade']);
});
