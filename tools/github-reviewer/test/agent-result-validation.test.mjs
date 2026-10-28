import assert from 'node:assert/strict';
import test from 'node:test';
import { extractAcceptanceCriteria, failClosedIncompleteResult, isAgentStageResult, REVIEW_RISK_AREAS, validateAgentResultCompleteness } from '../dist/agent-result-validation.js';

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

test('normalizes incomplete Code Review evidence into a publishable INCONCLUSIVE result', () => {
  const expected = { stage: 'codeReview', commitSha: sha, changedFiles: ['src/a.ts', 'src/b.ts'], acceptanceCriteria: [] };
  const normalized = failClosedIncompleteResult(result('codeReview', {
    reviewComplete: true, changedFilesReviewed: ['src/a.ts'], riskAreas: risks.slice(0, -1), findings: [], acceptanceCriteria: [],
  }), expected);

  assert.equal(normalized.decision, 'INCONCLUSIVE');
  assert.equal(normalized.evidence.reviewComplete, false);
  assert.equal(normalized.evidence.riskAreas.find(({ area }) => area === 'tests').status, 'INCONCLUSIVE');
  assert.match(normalized.reportMarkdown, /src\/b\.ts/);
  assert.deepEqual(validateAgentResultCompleteness(normalized, expected), []);
});

test('publishes mixed QA failures and limitations as fail-closed INCONCLUSIVE evidence', () => {
  const expected = { stage: 'qa', commitSha: sha, changedFiles: [], acceptanceCriteria: ['Importar OFX', 'Evitar duplicidade'] };
  const normalized = failClosedIncompleteResult(result('qa', {
    reviewComplete: true, changedFilesReviewed: [], riskAreas: [], findings: [], acceptanceCriteria: [
      { criterion: 'Importar OFX', status: 'FAILED', evidence: 'Arquivo válido foi rejeitado.' },
    ],
  }, 'CHANGES_REQUESTED'), expected);

  assert.equal(normalized.decision, 'INCONCLUSIVE');
  assert.deepEqual(normalized.evidence.acceptanceCriteria.map(({ status }) => status), ['FAILED', 'INCONCLUSIVE']);
  assert.deepEqual(validateAgentResultCompleteness(normalized, expected), []);
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

test('rejects an agent result envelope with an unknown decision', () => {
  const valid = result('codeReview', {
    reviewComplete: true, changedFilesReviewed: ['src/a.ts'], riskAreas: risks, findings: [], acceptanceCriteria: [],
  });
  assert.equal(isAgentStageResult({ ...valid, decision: 'INVALID' }), false);
});

test('rejects an agent result envelope without a full commit SHA', () => {
  const valid = result('codeReview', {
    reviewComplete: true, changedFilesReviewed: ['src/a.ts'], riskAreas: risks, findings: [], acceptanceCriteria: [],
  });
  assert.equal(isAgentStageResult({ ...valid, commitSha: 'abc123' }), false);
});

test('rejects an otherwise valid result when it belongs to another expected HEAD SHA', () => {
  const valid = result('codeReview', {
    reviewComplete: true, changedFilesReviewed: ['src/a.ts'], riskAreas: risks, findings: [], acceptanceCriteria: [],
  });
  const reasons = validateAgentResultCompleteness(valid, {
    stage: 'codeReview', commitSha: 'b'.repeat(40), changedFiles: ['src/a.ts'], acceptanceCriteria: [],
  });
  assert.match(reasons.join(' '), /SHA do resultado não corresponde/);
});

test('rejects an agent result envelope without complete structured evidence', () => {
  assert.equal(isAgentStageResult({
    stage: 'qa', decision: 'INCONCLUSIVE', commitSha: sha, reportMarkdown: 'Limitação registrada.',
  }), false);
});
