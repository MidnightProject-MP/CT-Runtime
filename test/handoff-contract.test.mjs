import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeHandoff,
  projectHandoff,
  HANDOFF_OUTCOMES,
  HANDOFF_SOURCES
} from '../lib/handoff-contract.mjs';

const context = { objectiveRef: 'objective-alpha' };

test('every dialect normalizes onto one canonical outcome vocabulary', () => {
  assert.deepEqual([...HANDOFF_OUTCOMES].sort(), ['completion-claim', 'continue-work', 'failure', 'wait']);
  const cases = [
    ['objective-turn', 'continue', 'continue-work'],
    ['objective-turn', 'waiting', 'wait'],
    ['objective-turn', 'done', 'completion-claim'],
    ['runtime-legacy', 'continue', 'continue-work'],
    ['runtime-legacy', 'complete', 'completion-claim'],
    ['runtime-legacy', 'failed', 'failure'],
    ['gas-email', 'continue', 'continue-work'],
    ['gas-email', 'waiting', 'wait'],
    ['gas-email', 'done', 'completion-claim']
  ];
  for (const [source, disposition, expected] of cases) {
    const result = disposition === 'failed'
      ? { status: 'failed', summary: 'process failed', failure_reason: 'timeout' }
      : disposition === 'waiting'
        ? { disposition, summary: 'did the thing', wait_reason: 'awaiting human answer' }
        : { disposition, summary: 'did the thing' };
    assert.equal(normalizeHandoff(result, context, { source }).outcome, expected, `${source}/${disposition}`);
  }
});

test('a completion claim is never acceptance and missing evidence is not upgraded', () => {
  const claimed = normalizeHandoff(
    { disposition: 'done', summary: 'fixed', outcome_evidence: [{ kind: 'file', path: 'p', sha256: 'a'.repeat(64) }] },
    context,
    { source: 'objective-turn' }
  );
  assert.equal(claimed.outcome, 'completion-claim');
  assert.equal(claimed.evidence_complete, true);

  // The legacy dialect cannot express evidence. The claim stays insufficient
  // for acceptance rather than being treated as proven.
  const unevidenced = normalizeHandoff({ status: 'complete', summary: 'claims done' }, context, { source: 'runtime-legacy' });
  assert.equal(unevidenced.outcome, 'completion-claim');
  assert.equal(unevidenced.evidence_complete, false);

  const email = normalizeHandoff({ disposition: 'done', summary: 'draft ready' }, context, { source: 'gas-email' });
  assert.equal(email.evidence_complete, false);
});

test('technical failure is never represented as a semantic wait', () => {
  const failed = normalizeHandoff(
    { status: 'failed', summary: 'worker exited nonzero', failure_reason: 'exit 1' },
    context,
    { source: 'runtime-legacy' }
  );
  assert.equal(failed.outcome, 'failure');
  assert.equal(failed.failure_reason, 'exit 1');

  // A semantic dialect that reports failure is rejected outright, not coerced.
  assert.throws(() => normalizeHandoff({ disposition: 'failed', summary: 'x' }, context, { source: 'objective-turn' }), /invalid/);
  // ...and a wait without an honest reason is rejected rather than defaulted.
  assert.throws(() => normalizeHandoff({ disposition: 'waiting', summary: 'x', continuation: { mode: 'condition', condition: { kind: 'human' } } }, context, { source: 'objective-turn' }), /wait_reason|bound/);
});

test('runtime identity is bound from context and never asserted by the worker', () => {
  for (const key of ['work_unit_id', 'execution_id', 'project_id', 'fence', 'revision', 'terminal', 'accepted', 'authorization_decision_ref']) {
    assert.throws(
      () => normalizeHandoff({ disposition: 'continue', summary: 'x', continuation_action: 'y', [key]: 'forged' }, context, { source: 'objective-turn' }),
      /runtime identity/,
      key
    );
  }
  // objective_id is the one asserted field, and it is verified against context.
  assert.equal(
    normalizeHandoff({ disposition: 'continue', summary: 'x', continuation_action: 'y', objective_id: 'objective-alpha' }, context, { source: 'objective-turn' }).objective_id,
    'objective-alpha'
  );
  assert.throws(() => normalizeHandoff({ disposition: 'continue', summary: 'x', continuation_action: 'y', objective_id: 'other' }, context, { source: 'objective-turn' }), /does not match/);
  // Absent objective_id falls back to trusted context.
  assert.equal(normalizeHandoff({ status: 'complete', summary: 'x' }, context, { source: 'runtime-legacy' }).objective_id, 'objective-alpha');
});

test('a worker-proposed wake is a proposal and carries no authority', () => {
  const turn = normalizeHandoff(
    { disposition: 'continue', summary: 'x', continuation_action: 'again', proposed_wake_at: '2026-11-01T00:00:00.000Z' },
    context,
    { source: 'objective-turn' }
  );
  assert.equal(turn.outcome, 'continue-work');
  assert.equal(turn.proposed_wake_at, '2026-11-01T00:00:00.000Z');
  assert.equal(turn.proposed_wake_count, 1);
  // The handoff contains no dispatch, acceptance, or successor authority.
  assert.deepEqual(Object.keys(turn).filter(k => /dispatch|accept|successor|terminal/.test(k)), []);

  const none = normalizeHandoff({ status: 'continue', summary: 'x' }, context, { source: 'runtime-legacy' });
  assert.equal(none.proposed_wake_at, null);
  assert.equal(none.proposed_wake_count, 0);
});

test('malformed and unbounded handoffs fail closed', () => {
  const bad = [
    [null, 'objective-turn'],
    [{}, 'objective-turn'],
    [{ disposition: 'finished', summary: 'x' }, 'objective-turn'],
    [{ disposition: 'continue', summary: 'x' }, 'unknown-source'],
    [{ status: 'complete', summary: '' }, 'runtime-legacy'],
    [{ status: 'complete', summary: 'x'.repeat(2001) }, 'runtime-legacy'],
    [{ status: 'complete', summary: 'x', work_unit_id: 'w' }, 'runtime-legacy'],
    [{ disposition: 'continue', summary: 'x', proposed_wake_at: 'not-a-time' }, 'objective-turn'],
    [{ status: 'failed', summary: 'x', failure_reason: '' }, 'runtime-legacy']
  ];
  for (const [result, source] of bad) {
    assert.throws(() => normalizeHandoff(result, context, { source }), /handoff|objective_id|summary|bound|wake|failure_reason/, JSON.stringify(result));
  }
});

test('the projection is bounded and preserves evidence semantics', () => {
  const claimed = projectHandoff(normalizeHandoff({ status: 'complete', summary: 'claims done' }, context, { source: 'runtime-legacy' }));
  assert.deepEqual(claimed, {
    outcome: 'completion-claim',
    source: 'runtime-legacy',
    summary: 'claims done',
    evidence_complete: false,
    objective_id: 'objective-alpha'
  });
  const waiting = projectHandoff(normalizeHandoff(
    { disposition: 'waiting', summary: 'blocked', question: 'which?', continuation: { mode: 'condition', condition: { kind: 'human_answer', condition: 'answer' } } },
    context,
    { source: 'objective-turn' }
  ));
  assert.equal(waiting.outcome, 'wait');
  assert.ok(!('evidence_complete' in waiting));
  assert.throws(() => projectHandoff({ outcome: 'wait' }), /canonical handoff/);
});

test('sources cover exactly the three inspected dialects', () => {
  assert.deepEqual([...HANDOFF_SOURCES].sort(), ['gas-email', 'objective-turn', 'runtime-legacy']);
});
