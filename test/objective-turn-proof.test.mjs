import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { projectTurnReply, validateObjectiveTurn, verifyTurnEvidenceIntegrity } from '../lib/objective-turn.mjs';

const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const nextWake = { time: '2030-01-01T00:00:00Z', reason: 'self_scheduled', priority: 'low', project: 'demo' };

test('turn validation accepts each disposition and rejects malformed results', () => {
  assert.equal(validateObjectiveTurn({ objective_id: 'o-1', disposition: 'continue', summary: 'did X', next_action: 'do Y', requested_next_wake: nextWake }).disposition, 'continue');
  assert.equal(validateObjectiveTurn({ objective_id: 'o-1', disposition: 'waiting', summary: 'blocked', dependency: { kind: 'human_answer', condition: 'answer_to(q1)' }, question: 'Which?' }).dependency.kind, 'human_answer');
  const done = validateObjectiveTurn({ objective_id: 'o-1', disposition: 'done', summary: 'fixed and verified', outcome_evidence: [{ kind: 'file', path: 'proof.json', sha256: 'a'.repeat(64) }] });
  assert.equal(done.outcome_evidence.length, 1);
  assert.throws(() => validateObjectiveTurn({ objective_id: 'o-1', disposition: 'finished', summary: 'x' }), /disposition/);
  assert.throws(() => validateObjectiveTurn({ objective_id: 'o-1', disposition: 'continue', summary: 'x' }), /next_action/);
  assert.throws(() => validateObjectiveTurn({ objective_id: 'o-1', disposition: 'continue', summary: 'x', next_action: 'y' }), /requested_next_wake/);
  assert.throws(() => validateObjectiveTurn({ objective_id: 'o-1', disposition: 'waiting', summary: 'x' }), /dependency/);
  assert.throws(() => validateObjectiveTurn({ objective_id: 'o-1', disposition: 'done', summary: 'model says done', outcome_evidence: [] }), /outcome_evidence/);
  assert.throws(() => validateObjectiveTurn({ objective_id: 'o-1', disposition: 'done', summary: 'model says done' }), /outcome_evidence/);
  assert.throws(() => validateObjectiveTurn({ objective_id: 'o-1', disposition: 'continue', summary: 'x', next_action: 'y', transcript: '...' }), /unexpected key/);
  assert.throws(() => validateObjectiveTurn({ objective_id: 'o-1', disposition: 'done', summary: 'x', outcome_evidence: [{ kind: 'model-says-so', text: 'done' }] }), /kind must be/);
  assert.throws(() => validateObjectiveTurn({ objective_id: 'o-1', disposition: 'done', summary: 'x', outcome_evidence: [{ kind: 'file', path: '../escape', sha256: 'a'.repeat(64) }] }), /workspace-relative/);
  assert.throws(() => validateObjectiveTurn({ objective_id: '', disposition: 'continue', summary: 'x', next_action: 'y' }), /objective_id/);
  assert.throws(() => validateObjectiveTurn({ objective_id: 'bad/id', disposition: 'continue', summary: 'x', next_action: 'y', requested_next_wake: nextWake }), /safe identifier/);
  assert.throws(() => validateObjectiveTurn({ objective_id: 'o-1', turn_id: 7, disposition: 'continue', summary: 'x', next_action: 'y', requested_next_wake: nextWake }), /turn_id/);
  assert.throws(() => validateObjectiveTurn({ objective_id: 'o-1', disposition: 'waiting', summary: 'x', dependency: { kind: 'human', condition: 'answer' }, question: 7 }), /question/);
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

test('waiting names a falsifiable dependency and projects a genuine question', () => {
  const turn = validateObjectiveTurn({ objective_id: 'o-3', disposition: 'waiting', summary: 'Two layouts satisfy the brief.', dependency: { kind: 'human_answer', condition: 'answer_to(q_layout)' }, question: 'Compact or roomy board?' });
  const reply = projectTurnReply(turn);
  assert.equal(reply.status, 'Waiting: human_answer');
  assert.match(reply.text, /Compact or roomy board\?/);
  assert.ok(!('requested_next_wake' in turn), 'waiting requests no automatic retry');
  assert.equal(projectTurnReply({ objective_id: 'o-3', disposition: 'continue', summary: 'progress', next_action: 'next step', requested_next_wake: nextWake }).status, 'Working');
  const claimedDone = { objective_id: 'o-3', disposition: 'done', summary: 'model says complete', outcome_evidence: [{ kind: 'manifest', execution_id: 'run-good' }] };
  assert.equal(projectTurnReply(claimedDone).status, 'Needs review');
  assert.match(projectTurnReply(claimedDone).text, /independent review/);
});
