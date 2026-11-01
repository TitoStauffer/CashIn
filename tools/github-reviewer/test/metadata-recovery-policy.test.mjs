import assert from 'node:assert/strict';
import test from 'node:test';
import { requiresCiRecovery } from '../dist/metadata-recovery-policy.js';

const edit = (before, after, extra = {}) => ({ changes: { body: { from: before }, ...extra }, pull_request: { body: after } });

test('human and App checkbox-only edits do not recover CI', () => {
  assert.equal(requiresCiRecovery(edit('- [ ] QA\n* [X] Review', '- [x] QA\n* [ ] Review')), false);
});
test('title corrections and changed criteria still recover CI', () => {
  assert.equal(requiresCiRecovery(edit('- [ ] QA', '- [x] QA', { title: { from: 'invalid' } })), true);
  assert.equal(requiresCiRecovery(edit('- [ ] Original criterion', '- [x] Changed criterion')), true);
  assert.equal(requiresCiRecovery(edit('Value [x]', 'Value [ ]')), true);
});
test('missing or malformed edit data cannot suppress recovery', () => {
  for (const payload of [null, {}, { changes: { body: {} } }, edit(null, ''), edit('body', null)]) {
    assert.equal(requiresCiRecovery(payload), true);
  }
});
