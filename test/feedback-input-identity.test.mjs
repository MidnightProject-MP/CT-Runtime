import assert from 'node:assert/strict';
import test from 'node:test';
import {
  UNKNOWN_AUTHOR,
  appendRevision,
  createFeedbackInput,
  createSourceIdentity,
  validateFeedbackInput,
} from '../src/feedback-input-identity.mjs';

const source = createSourceIdentity('spreadsheet:feedback-book/Feedback');
const at = (day) => `2026-09-${String(day).padStart(2, '0')}T12:00:00.000Z`;

test('source and message identity do not depend on physical row movement', () => {
  const first = createFeedbackInput({ source, messageKey: 'record-17', content: 'same', observedAt: at(1) });
  const moved = createFeedbackInput({ source, messageKey: 'record-17', content: 'same', observedAt: at(1) });
  assert.equal(first.source.id, moved.source.id);
  assert.equal(first.message.id, moved.message.id);
  assert.equal(first.revisions[0].id, moved.revisions[0].id);
});

test('distinct identical messages require distinct stable message keys', () => {
  const one = createFeedbackInput({ source, messageKey: 'record-17', content: 'same', observedAt: at(1) });
  const two = createFeedbackInput({ source, messageKey: 'record-18', content: 'same', observedAt: at(1) });
  assert.notEqual(one.message.id, two.message.id);
  assert.notEqual(one.revisions[0].id, two.revisions[0].id);
});

test('A to B to A creates three immutable revision occurrences', () => {
  const a = createFeedbackInput({ source, messageKey: 'record-19', content: 'A', observedAt: at(1) });
  const ab = appendRevision(a, { content: 'B', observedAt: at(2) });
  const aba = appendRevision(ab, { content: 'A', observedAt: at(3) });
  assert.deepEqual(aba.revisions.map((revision) => revision.content), ['A', 'B', 'A']);
  assert.equal(a.revisions.length, 1);
  assert.equal(new Set(aba.revisions.map((revision) => revision.id)).size, 3);
  assert.equal(aba.firstObservedAt, at(1));
  assert.equal(aba.revisions[0].observedAt, at(1));
  assert.equal(aba.author, UNKNOWN_AUTHOR);
  assert.doesNotThrow(() => validateFeedbackInput(aba));
});

test('validation rejects mutation of immutable identities and history', () => {
  assert.throws(() => createFeedbackInput({ source, messageKey: '5', content: 'x', observedAt: at(1) }).message.key = '6', /read only/);
  const input = createFeedbackInput({ source, messageKey: 'record-20', content: 'x', observedAt: at(1) });
  assert.throws(() => validateFeedbackInput({ ...input, firstObservedAt: at(2) }), /immutable/);
  assert.throws(() => createFeedbackInput({ source, messageKey: 'record-21', content: 'x', observedAt: at(1), author: { kind: 'named', name: 'Ada' } }), /author/);
});
