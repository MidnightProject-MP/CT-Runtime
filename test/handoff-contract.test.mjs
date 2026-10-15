import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeHandoff,
  projectHandoff,
  HANDOFF_OUTCOMES,
  HANDOFF_SOURCES
} from '../lib/handoff-contract.mjs';

const context = { objectiveRef: 'objective-alpha' };

// Real fixtures, shaped exactly as each current dialect validates them.
const OBJECTIVE_TURN = {
  continue: { objective_id: 'objective-alpha', disposition: 'continue', summary: 'did X', continuation: { mode: 'immediate', next_action: 'verify' } },
  waiting: {
    objective_id: 'objective-alpha', disposition: 'waiting', summary: 'blocked', question: 'Which layout?',
    continuation: { mode: 'condition', condition: { kind: 'human_answer', condition: 'answer_to(q_layout)' } }
  },
  done: {
    objective_id: 'objective-alpha', disposition: 'done', summary: 'fixed and verified',
    outcome_evidence: [
      { kind: 'file', path: 'proof.json', sha256: 'a'.repeat(64) },
      { kind: 'manifest', execution_id: 'run-1' }
    ]
  },
  doneNoEvidence: undefined // cannot exist: the validator requires non-empty evidence
};

const RUNTIME_LEGACY = {
  complete: { status: 'complete', summary: 'claims done', requested_next_wake: null },
  continued: { status: 'continue', summary: 'more to do', requested_next_wake: { time: '2026-11-01T00:00:00Z', reason: 'retry', priority: 'low', project: 'demo' } },
  failed: { status: 'failed', summary: 'worker exited nonzero', requested_next_wake: null }
};

const GAS_EMAIL = {
  // gas/gas_vnext_email.js contract: summary <=4000, question required for waiting,
  // artifact optional, no explicit continuation action.
  continued: { disposition: 'continue', summary: 'Drafted the next section and checked the facts.', artifact: 'Draft text.' },
  waiting: { disposition: 'waiting', summary: 'Two designs satisfy the brief.', question: 'Compact or roomy layout?' },
  done: { disposition: 'done', summary: 'Welcome message drafted.', artifact: 'Welcome to the team...' }
};

const N = (r, s) => normalizeHandoff(r, context, { source: s });

test('outcome vocabulary is fixed and covers all current dialects', () => {
  assert.deepEqual([...HANDOFF_OUTCOMES].sort(), ['completion-claim', 'continue-work', 'failure', 'wait']);
  assert.deepEqual([...HANDOFF_SOURCES].sort(), ['gas-email', 'objective-turn', 'runtime-legacy']);
});

test('every current dialect normalizes losslessly', () => {
  assert.equal(N(OBJECTIVE_TURN.continue, 'objective-turn').outcome, 'continue-work');
  assert.equal(N(OBJECTIVE_TURN.waiting, 'objective-turn').outcome, 'wait');
  assert.equal(N(OBJECTIVE_TURN.done, 'objective-turn').outcome, 'completion-claim');
  assert.equal(N(RUNTIME_LEGACY.complete, 'runtime-legacy').outcome, 'completion-claim');
  assert.equal(N(RUNTIME_LEGACY.continued, 'runtime-legacy').outcome, 'continue-work');
  assert.equal(N(RUNTIME_LEGACY.failed, 'runtime-legacy').outcome, 'failure');
  // The GAS dialect previously failed: a wait expressed as `question` only.
  assert.equal(N(GAS_EMAIL.continued, 'gas-email').outcome, 'continue-work');
  assert.equal(N(GAS_EMAIL.waiting, 'gas-email').outcome, 'wait');
  assert.equal(N(GAS_EMAIL.done, 'gas-email').outcome, 'completion-claim');
});

test('no current dialect output is rejected for exceeding the canonical bound', () => {
  // GAS permits a 4000-character summary; objective-turn and legacy cap at 2000.
  const long = 'x'.repeat(4000);
  assert.equal(N({ disposition: 'continue', summary: long }, 'gas-email').summary.length, 4000);
  assert.throws(() => N({ disposition: 'continue', summary: 'x'.repeat(4001) }, 'gas-email'), /exceeds bound/);
  // The canonical bound is the union of current dialect bounds, so a legacy
  // 2000-character summary remains valid.
  assert.equal(N({ status: 'complete', summary: 'x'.repeat(2000), requested_next_wake: null }, 'runtime-legacy').summary.length, 2000);
  assert.throws(() => N({ status: 'complete', summary: 'x'.repeat(4001), requested_next_wake: null }, 'runtime-legacy'), /exceeds bound/);
});

test('evidence capability, supplied references, verification, and acceptance are separate', () => {
  const withEvidence = N(OBJECTIVE_TURN.done, 'objective-turn');
  assert.equal(withEvidence.evidence_capable, true);
  assert.equal(withEvidence.evidence_supplied, true);
  assert.equal(withEvidence.evidence_complete, true);
  assert.equal(withEvidence.evidence_refs.length, 2);
  assert.deepEqual(withEvidence.evidence_refs[0], { kind: 'file', path: 'proof.json', sha256: 'a'.repeat(64) });
  assert.deepEqual(withEvidence.evidence_refs[1], { kind: 'manifest', execution_id: 'run-1' });
  // Normalization never verifies integrity; that is a separate step.
  assert.equal(withEvidence.evidence_verified, false);

  // A dialect that CAN express evidence but supplies none is not evidence-complete.
  // (objective-turn's validator requires evidence for `done`, so this is asserted
  // at the contract level rather than constructed from a live dialect output.)
  const capableButEmpty = N({ ...OBJECTIVE_TURN.done, outcome_evidence: [] }, 'objective-turn');
  assert.equal(capableButEmpty.evidence_capable, true);
  assert.equal(capableButEmpty.evidence_supplied, false);
  assert.equal(capableButEmpty.evidence_complete, false);

  // Dialects that cannot express evidence never become evidence-complete.
  for (const [result, source] of [[RUNTIME_LEGACY.complete, 'runtime-legacy'], [GAS_EMAIL.done, 'gas-email']]) {
    const claim = N(result, source);
    assert.equal(claim.evidence_capable, false, source);
    assert.equal(claim.evidence_supplied, false, source);
    assert.equal(claim.evidence_complete, false, source);
    assert.equal(claim.evidence_refs.length, 0, source);
  }

  // A bounded text deliverable is preserved but is not evidence.
  assert.equal(N(GAS_EMAIL.done, 'gas-email').artifact, 'Welcome to the team...');
});

test('evidence-free completion can never become acceptance', () => {
  const claim = N(GAS_EMAIL.done, 'gas-email');
  assert.equal(claim.outcome, 'completion-claim');
  assert.equal(claim.evidence_complete, false);
  // Nothing in the normalized handoff can be read as acceptance authority.
  assert.equal('accepted' in claim, false);
  assert.equal('terminal_authorized' in claim, false);
});

test('a GAS wait carries its question as the reason', () => {
  const wait = N(GAS_EMAIL.waiting, 'gas-email');
  assert.equal(wait.outcome, 'wait');
  assert.equal(wait.wait_reason, 'awaiting human input');
  assert.equal(wait.question, 'Compact or roomy layout?');
  // And neither a reason nor a question fails closed.
  assert.throws(() => N({ disposition: 'waiting', summary: 'x' }, 'gas-email'), /name its reason or carry a question/);
  assert.throws(() => N({ disposition: 'waiting', summary: 'x', continuation: { mode: 'condition', condition: { kind: 'human_answer' } } }, 'objective-turn'), /name its reason or carry a question/);
});

test('GAS continuation is recorded as not expressed rather than invented', () => {
  const cont = N(GAS_EMAIL.continued, 'gas-email');
  assert.equal(cont.outcome, 'continue-work');
  assert.equal(cont.continuation_action, null); // the dialect carries none
  assert.equal(cont.artifact, 'Draft text.');
  // ...while dialects that do express it preserve it.
  assert.equal(N(OBJECTIVE_TURN.continue, 'objective-turn').continuation_action, 'verify');
});

test('technical failure is never represented as a semantic wait', () => {
  const failed = N(RUNTIME_LEGACY.failed, 'runtime-legacy');
  assert.equal(failed.outcome, 'failure');
  assert.equal(failed.failure_reason, 'execution failure');
  assert.equal(failed.evidence_complete, undefined);
  assert.throws(() => N({ disposition: 'failed', summary: 'x' }, 'objective-turn'), /invalid/);
  assert.throws(() => N({ status: 'failed', summary: 'x' }, 'gas-email'), /invalid/);
});

test('runtime identity is bound from context and never asserted by a worker', () => {
  for (const key of ['work_unit_id', 'execution_id', 'project_id', 'fence', 'revision', 'terminal', 'accepted', 'terminalAuthorization', 'authorization_decision_ref']) {
    assert.throws(
      () => N({ disposition: 'continue', summary: 'x', [key]: 'forged' }, 'objective-turn'),
      /runtime identity/,
      key
    );
  }
  assert.equal(N({ ...OBJECTIVE_TURN.continue }, 'objective-turn').objective_id, 'objective-alpha');
  assert.throws(() => N({ ...OBJECTIVE_TURN.continue, objective_id: 'other' }, 'objective-turn'), /does not match/);
  assert.equal(N(RUNTIME_LEGACY.complete, 'runtime-legacy').objective_id, 'objective-alpha');
});

test('every wake and successor suggestion is a proposal, never an authority', () => {
  const legacy = N(RUNTIME_LEGACY.continued, 'runtime-legacy');
  assert.equal(legacy.proposed_wake_at, '2026-11-01T00:00:00.000Z');
  assert.equal(legacy.proposed_wake_count, 1);
  const none = N(GAS_EMAIL.continued, 'gas-email');
  assert.equal(none.proposed_wake_at, null);
  assert.equal(none.proposed_wake_count, 0);
  // No proposal field grants dispatch, acceptance or succession.
  for (const claim of [legacy, none]) {
    assert.deepEqual(Object.keys(claim).filter(k => /dispatch|accept|successor|terminal|launch/.test(k)), []);
  }
});

test('malformed and unbounded handoffs fail closed', () => {
  const bad = [
    [null, 'objective-turn'],
    [{}, 'objective-turn'],
    [{ disposition: 'finished', summary: 'x' }, 'objective-turn'],
    [{ disposition: 'continue', summary: 'x' }, 'unknown-source'],
    [{ status: 'complete', summary: '', requested_next_wake: null }, 'runtime-legacy'],
    [{ status: 'complete', summary: 'x', work_unit_id: 'w', requested_next_wake: null }, 'runtime-legacy'],
    [{ disposition: 'continue', summary: 'x', proposed_wake_at: 'not-a-time' }, 'objective-turn'],
    [{ status: 'failed', summary: 'x', failure_reason: '', requested_next_wake: null }, 'runtime-legacy'],
    [{ status: 'complete', summary: 'x', requested_next_wake: null, extra: 1 }, 'runtime-legacy'],
    [{ disposition: 'done', summary: 'x', outcome_evidence: [{ kind: 'model-says-so' }] }, 'objective-turn'],
    [{ disposition: 'done', summary: 'x', outcome_evidence: [{ kind: 'file', path: 'x'.repeat(257), sha256: 'a'.repeat(64) }] }, 'objective-turn']
  ];
  for (const [result, source] of bad) {
    assert.throws(() => N(result, source), /handoff|objective_id|summary|bound|wake|failure_reason|Disposition|kind|evidence/, JSON.stringify(result));
  }
});

test('normalization preserves references but defers integrity verification', () => {
  // A path-shaped reference is preserved for the verifier, which is the step
  // that resolves it against a workspace and would reject an escape.
  const claim = N({
    objective_id: 'objective-alpha', disposition: 'done', summary: 'x',
    outcome_evidence: [{ kind: 'file', path: '../escape', sha256: 'a'.repeat(64) }]
  }, 'objective-turn');
  assert.equal(claim.evidence_capable, true);
  assert.equal(claim.evidence_refs.length, 1);
  assert.equal(claim.evidence_refs[0].path, '../escape');
  assert.equal(claim.evidence_refs[0].sha256, 'a'.repeat(64));
  // Normalization explicitly did not verify it.
  assert.equal(claim.evidence_verified, false);
  // A reference with a malformed hash is preserved as null rather than dropped.
  const badHash = N({
    objective_id: 'objective-alpha', disposition: 'done', summary: 'x',
    outcome_evidence: [{ kind: 'file', path: 'p', sha256: 'not-a-hash' }]
  }, 'objective-turn');
  assert.equal(badHash.evidence_refs[0].sha256, null);
});

test('the projection is bounded and preserves evidence semantics', () => {
  const evidenced = projectHandoff(N(OBJECTIVE_TURN.done, 'objective-turn'));
  assert.deepEqual(evidenced, {
    outcome: 'completion-claim',
    source: 'objective-turn',
    summary: 'fixed and verified',
    objective_id: 'objective-alpha',
    evidence_capable: true,
    evidence_complete: true,
    evidence_supplied: true,
    evidence_refs: [
      { kind: 'file', path: 'proof.json', sha256: 'a'.repeat(64) },
      { kind: 'manifest', execution_id: 'run-1' }
    ]
  });
  const waiting = projectHandoff(N(OBJECTIVE_TURN.waiting, 'objective-turn'));
  assert.equal(waiting.outcome, 'wait');
  assert.ok(!('evidence_complete' in waiting));
  assert.throws(() => projectHandoff({ outcome: 'wait' }), /canonical handoff/);
});
