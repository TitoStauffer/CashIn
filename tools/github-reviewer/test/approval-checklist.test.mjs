import assert from 'node:assert/strict';
import test from 'node:test';
import { updateApprovalCheckbox } from '../dist/approval-checklist.js';

const body = [
  '## 13. Revisão e aprovação',
  '',
  '- [ ] **Code Review aprovado** — marcado pelo Agent de Code Review somente após a aprovação.',
  '- [ ] **QA aprovado** — marcado pelo Agent de QA somente após a aprovação.',
].join('\n');

test('marks only the Code Review checkbox', () => {
  const updated = updateApprovalCheckbox(body, 'codeReview', true);
  assert.match(updated, /- \[x\] \*\*Code Review aprovado\*\*/);
  assert.match(updated, /- \[ \] \*\*QA aprovado\*\*/);
});

test('marks only the QA checkbox and is idempotent', () => {
  const updated = updateApprovalCheckbox(body, 'qa', true);
  assert.equal(updateApprovalCheckbox(updated, 'qa', true), updated);
  assert.match(updated, /- \[ \] \*\*Code Review aprovado\*\*/);
  assert.match(updated, /- \[x\] \*\*QA aprovado\*\*/);
});

test('unmarks a stale approval', () => {
  const approved = updateApprovalCheckbox(body, 'codeReview', true);
  assert.equal(updateApprovalCheckbox(approved, 'codeReview', false), body);
});

test('fails closed when the responsible checkbox is missing or duplicated', () => {
  assert.throws(() => updateApprovalCheckbox('', 'qa', true), /exactly one QA aprovado/);
  assert.throws(() => updateApprovalCheckbox(`${body}\n- [ ] **QA aprovado**`, 'qa', true), /exactly one QA aprovado/);
});
