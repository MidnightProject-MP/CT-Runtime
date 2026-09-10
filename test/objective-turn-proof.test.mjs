import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { projectTurnReply, validateObjectiveTurn, verifyTurnEvidenceIntegrity } from '../lib/objective-turn.mjs';

const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const immediate = { mode: 'immediate', next_action: 'do Y' };
const condition = { mode: 'condition', condition: { kind: 'human_answer', condition: 'answer_to(q1)' } };

test('turn validation accepts each disposition and one unified continuation contract', () => {
  assert.equal(validateObjectiveTurn({ objective_id: 'o-1', disposition: 'continue', summary: 'did X', continuation: immediate }).continuation.mode, 'immediate');
  assert.equal(validateObjectiveTurn({ objective_id: 'o-1', disposition: 'waiting', summary: 'blocked', continuation: condition, question: 'Which?' }).continuation.condition.kind, 'human_answer');
  const done = validateObjectiveTurn({ objective_id: 'o-1', disposition: 'done', summary: 'fixed and verified', outcome_evidence: [{ kind: 'file', path: 'proof.json', sha256: 'a'.repeat(64) }] });
  assert.equal(done.outcome_evidence.length, 1);
  assert.throws(() => validateObjectiveTurn({ objective_id: 'o-1', disposition: 'finished', summary: 'x' }), /disposition/);
  assert.throws(() => validateObjectiveTurn({ objective_id: 'o-1', disposition: 'continue', summary: 'x' }), /continuation/);
  assert.throws(() => validateObjectiveTurn({ objective_id: 'o-1', disposition: 'continue', summary: 'x', continuation: condition }), /immediate continuation/);
  assert.throws(() => validateObjectiveTurn({ objective_id: 'o-1', disposition: 'waiting', summary: 'x' }), /continuation/);
  assert.throws(() => validateObjectiveTurn({ objective_id: 'o-1', disposition: 'waiting', summary: 'x', continuation: immediate }), /condition continuation/);
  assert.throws(() => validateObjectiveTurn({ objective_id: 'o-1', disposition: 'done', summary: 'model says done', outcome_evidence: [] }), /outcome_evidence/);
  assert.throws(() => validateObjectiveTurn({ objective_id: 'o-1', disposition: 'continue', summary: 'x', continuation: { mode: 'immediate', next_action: 'y', time: 'tomorrow' } }), /unexpected key/);
  assert.throws(() => validateObjectiveTurn({ objective_id: 'o-1', disposition: 'done', summary: 'x', outcome_evidence: [{ kind: 'model-says-so', text: 'done' }] }), /kind must be/);
  assert.throws(() => validateObjectiveTurn({ objective_id: 'o-1', disposition: 'done', summary: 'x', outcome_evidence: [{ kind: 'file', path: '../escape', sha256: 'a'.repeat(64) }] }), /workspace-relative/);
  assert.throws(() => validateObjectiveTurn({ objective_id: '', disposition: 'continue', summary: 'x', continuation: immediate }), /objective_id/);
  assert.throws(() => validateObjectiveTurn({ objective_id: 'bad/id', disposition: 'continue', summary: 'x', continuation: immediate }), /safe identifier/);
  assert.throws(() => validateObjectiveTurn({ objective_id: 'o-1', turn_id: 7, disposition: 'continue', summary: 'x', continuation: immediate }), /turn_id/);
  assert.throws(() => validateObjectiveTurn({ objective_id: 'o-1', disposition: 'waiting', summary: 'x', continuation: condition, question: 7 }), /question/);
  assert.throws(() => validateObjectiveTurn({ objective_id: 'o-1', disposition: 'waiting', summary: 'x', continuation: { mode: 'condition', condition: { kind: 'human' } } }), /continuation.condition.condition/);
  assert.throws(() => validateObjectiveTurn({ objective_id: 'o-1', disposition: 'done', summary: 'x', outcome_evidence: Array.from({ length: 33 }, () => ({ kind: 'file', path: 'proof.json', sha256: 'a'.repeat(64) })) }), /exceeds bound/);
});

test('evidence cannot escape through a symlinked workspace path', async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'ct-objective-symlink-'));
  const outside = await mkdtemp(path.join(os.tmpdir(), 'ct-objective-outside-'));
  await writeFile(path.join(outside, 'proof.json'), 'outside');
  await symlink(outside, path.join(workspace, 'linked'), 'junction');
  const turn = validateObjectiveTurn({ objective_id: 'o-symlink', disposition: 'done', summary: 'check', outcome_evidence: [{ kind: 'file', path: 'linked/proof.json', sha256: sha256('outside') }] });
  await assert.rejects(() => verifyTurnEvidenceIntegrity(turn, { workspaceRoot: workspace }), /escapes workspace/);
});

test('completion evidence must resolve against reality, not claims', async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'ct-objective-'));
  await writeFile(path.join(workspace, 'proof.json'), '{"ok":true}');
  const good = validateObjectiveTurn({ objective_id: 'o-2', disposition: 'done', summary: 'verified', outcome_evidence: [{ kind: 'file', path: 'proof.json', sha256: sha256('{"ok":true}') }] });
  assert.equal((await verifyTurnEvidenceIntegrity(good, { workspaceRoot: workspace })).length, 1);
  await writeFile(path.join(workspace, 'proof.json'), '{"ok":false}');
  await assert.rejects(() => verifyTurnEvidenceIntegrity(good, { workspaceRoot: workspace }), /hash mismatch/);
  const store = { manifest: async (id) => (id === 'run-good' ? { execution: { status: 'success' } } : { execution: { status: 'failed' } }) };
  const manifestTurn = validateObjectiveTurn({ objective_id: 'o-2', disposition: 'done', summary: 'ran green', outcome_evidence: [{ kind: 'manifest', execution_id: 'run-good' }] });
  assert.equal((await verifyTurnEvidenceIntegrity(manifestTurn, { store })).length, 1);
  const badManifest = validateObjectiveTurn({ objective_id: 'o-2', disposition: 'done', summary: 'ran', outcome_evidence: [{ kind: 'manifest', execution_id: 'run-bad' }] });
  await assert.rejects(() => verifyTurnEvidenceIntegrity(badManifest, { store }), /not successful/);
  await assert.rejects(() => verifyTurnEvidenceIntegrity({ ...manifestTurn, outcome_evidence: [{ kind: 'unknown' }] }, { store }), /kind must be/);
});

test('the unified continuation boundary distinguishes immediate work from a future condition', () => {
  const waiting = validateObjectiveTurn({ objective_id: 'o-3', disposition: 'waiting', summary: 'Two layouts satisfy the brief.', continuation: { mode: 'condition', condition: { kind: 'human_answer', condition: 'answer_to(q_layout)' } }, question: 'Compact or roomy board?' });
  const reply = projectTurnReply(waiting);
  assert.equal(reply.status, 'Waiting: human_answer');
  assert.match(reply.text, /Compact or roomy board\?/);
  assert.equal(waiting.continuation.mode, 'condition');
  assert.equal(projectTurnReply({ objective_id: 'o-3', disposition: 'continue', summary: 'progress', continuation: { mode: 'immediate', next_action: 'next step' } }).status, 'Working');
  const claimedDone = { objective_id: 'o-3', disposition: 'done', summary: 'model says complete', outcome_evidence: [{ kind: 'manifest', execution_id: 'run-good' }] };
  assert.equal(projectTurnReply(claimedDone).status, 'Needs review');
  assert.match(projectTurnReply(claimedDone).text, /independent review/);
});
