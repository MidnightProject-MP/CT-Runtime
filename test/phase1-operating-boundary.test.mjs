import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { testPool } from './pilot-test-pool.mjs';
import { testAcceptanceAuthority } from './vnext-test-acceptance.mjs';
import { migrateVNext } from '../lib/vnext/migration.mjs';
import { createPilotStore } from '../lib/vnext/pilot-store.mjs';
import { runPilotOnce } from '../lib/vnext/pilot.mjs';
import { verifyTurnEvidenceIntegrity } from '../lib/objective-turn.mjs';
import { claimWorkUnit, createExecution, startExecution, applyTurn, createWorkUnit, failExecution } from '../lib/vnext/kernel.mjs';
import { canonicalHandoff } from '../lib/vnext/operating-boundary.mjs';
import { createMemoryStore } from '../lib/vnext/memory-store.mjs';

const next = objective_id => ({ objective_id, disposition: 'continue', summary: 'First checked increment.', learned: 'Preserve this lesson.', turn_id: 'turn-one', continuation: { mode: 'immediate', next_action: 'Check second increment.' } });
const wait = objective_id => ({ objective_id, disposition: 'waiting', summary: 'Need human input.', question: 'Which option?', continuation: { mode: 'condition', condition: { kind: 'human', condition: 'A new answer arrives.' } } });
const authorization = {
  authorizeExecution: async ({ execution }) => ({ ref: `test:${execution.execution_id}` }),
  verifyExecution: async (d, { execution }) => d.ref === `test:${execution.execution_id}` && execution.authorization_decision_ref === d.ref,
  authorizeTerminal: async () => false,
};
const pause = () => new Promise(r => setTimeout(r, 1050));

test('real pilot cold continuation, admission cursor, separate acceptance and stale snapshots', { timeout: 90000 }, async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'operating-boundary-'));
  let pool = await testPool({ dataDir: path.join(dir, 'db') });
  await writeFile(path.join(dir, 'identity.md'), 'Reconstruct, do one checked increment, persist.');
  await writeFile(path.join(dir, 'proof.txt'), 'checked');
  const ref = { kind: 'file', path: 'proof.txt', sha256: createHash('sha256').update('checked').digest('hex') };
  const done = objective_id => ({ objective_id, disposition: 'done', summary: 'Checked outcome.', outcome_evidence: [ref] });
  const acceptance = testAcceptanceAuthority(async c => {
    await verifyTurnEvidenceIntegrity(c.turn, { workspaceRoot: dir });
    return c.turn.summary === 'Checked outcome.' && c.evidence.length === 1;
  });
  const store = (options = {}) => createPilotStore({ pool, intervalMs: 1000, authorizationVerifier: authorization.verifyExecution, acceptanceVerifier: acceptance.verifyAcceptance, ...options });
  let seq = 0;
  const submit = (s, projectId, threadId = 'thread') => s.submit({ projectId, threadId, receiptId: `receipt-${randomUUID()}`, message: `Input ${++seq}` });
  const run = (s, projectId, executor) => runPilotOnce({ store: s, projectId, workspaceRoot: dir, identityFiles: [path.join(dir, 'identity.md')], authority: authorization, executor });
  const progress = async id => (await pool.query('SELECT * FROM vnext_pilot_progress WHERE work_unit_id=$1', [id])).rows[0];
  try {
    await pool.query("DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF; IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anonymous') THEN CREATE ROLE anonymous; END IF; END $$");
    await migrateVNext({ pool, directory: path.join(import.meta.dirname, '../vnext-migrations') });
    await t.test('timestamp-free continuation survives closed connection/dataDir; waiting remains visible but quiet', async () => {
      const project = `cold-${randomUUID()}`;
      const { work_unit_id: id } = await submit(store(), project);
      const first = await run(store(), project, async ({ workUnit }) => next(workUnit.objective_ref));
      assert.equal(first.disposition, 'continue');
      const proposal = (await pool.query('SELECT * FROM vnext_continuations WHERE work_unit_id=$1', [id])).rows[0];
      assert.equal(Number((await progress(id)).considered_proposal_id), 0);
      assert.equal((await progress(id)).next_wake_at, null);
      assert.equal(await store().nextEligible(project), null, 'coordinator cooldown, not worker timestamp');
      await pool.end();
      pool = await testPool({ dataDir: path.join(dir, 'db') });
      await pause();
      const cold = store();
      assert.equal(await cold.nextEligible(project), id);
      const reconstructed = await cold.reconstruct({ work_unit_id: id });
      assert.equal(reconstructed.last_turn.learned, 'Preserve this lesson.');
      assert.equal(reconstructed.pending_proposal, undefined);
      assert.equal(reconstructed.pilot.pending_proposal.id, Number(proposal.id));
      await assert.rejects(run(store({ authorizationVerifier: async () => false }), project, async () => { throw new Error('must not execute'); }), /not valid/);
      assert.equal(Number((await progress(id)).considered_proposal_id), 0);
      const second = await run(cold, project, async ({ workUnit }) => {
        assert.equal(Number((await progress(id)).considered_proposal_id), Number(proposal.id), 'consumed at admission, before worker settles');
        assert.equal(workUnit.last_turn.turn_id, 'turn-one');
        return wait(workUnit.objective_ref);
      });
      assert.equal(second.disposition, 'waiting');
      const after = await cold.reconstruct({ work_unit_id: id });
      assert.ok(after.pilot.pending_proposal.id > Number(proposal.id));
      assert.equal(Number((await progress(id)).considered_proposal_id), Number(proposal.id));
      await pause();
      assert.equal(await cold.nextEligible(project), null);
      assert.equal((await run(cold, project, async () => { throw new Error('waiting must not spin'); })).disposition, 'quiesced');
      await submit(cold, project);
      assert.equal(await cold.nextEligible(project), id);
      await run(cold, project, async ({ workUnit }) => { await submit(store(), project); return wait(workUnit.objective_ref); });
      assert.equal(await store().nextEligible(project), id, 'late input is not consumed by the old attempt');
      await run(store(), project, async ({ workUnit }) => wait(workUnit.objective_ref));
      assert.equal(await store().nextEligible(project), null);
    });
    await t.test('review is accepted on a fresh store without executor rerun; opaque exact decision replay', async () => {
      const project = `accept-${randomUUID()}`;
      const { work_unit_id: id } = await submit(store(), project);
      let executions = 0;
      await run(store(), project, async ({ workUnit }) => { executions++; return done(workUnit.objective_ref); });
      const cold = store();
      assert.equal((await cold.reconstruct({ work_unit_id: id })).state, 'review');
      const snapshot = await cold.getAcceptanceContext(id);
      const decision = await acceptance.authorizeTerminal(snapshot);
      await assert.rejects(cold.acceptWork(id, { ...decision, snapshotDigest: '0'.repeat(64) }), /snapshot/);
      await assert.rejects(cold.acceptWork(id, { ...decision, ref: `forged-${randomUUID()}` }), /not valid/);
      await assert.rejects(store({ acceptanceVerifier: undefined }).acceptWork(id, decision), /verifier/);
      await writeFile(path.join(dir, 'proof.txt'), 'tampered');
      await assert.rejects(cold.acceptWork(id, decision), /hash mismatch/);
      assert.equal((await cold.reconstruct({ work_unit_id: id })).state, 'review');
      await writeFile(path.join(dir, 'proof.txt'), 'checked');
      const results = await Promise.all([cold.acceptWork(id, decision), store().acceptWork(id, decision)]);
      assert.deepEqual(results[0], results[1]);
      assert.equal(results[0].state, 'terminal');
      assert.equal(executions, 1);
      await assert.rejects(cold.acceptWork(id, { ...decision, extra: 'divergent' }), /content conflict/);
      assert.equal((await pool.query('SELECT * FROM vnext_events WHERE event_id=$1', [`acceptance:${decision.ref}`])).rowCount, 1);
    });
    await t.test('new input, material revision, revoked authority and evidence mutation cannot accept', async () => {
      for (const change of ['input', 'revision', 'evidence', 'revoked', 'result', 'project-authority', 'reconciliation', 'truthy-verifier']) {
        const project = `stale-${randomUUID()}`;
        const { work_unit_id: id } = await submit(store(), project);
        await run(store(), project, async ({ workUnit }) => done(workUnit.objective_ref));
        const s = store(); const snapshot = await s.getAcceptanceContext(id);
        const decision = await acceptance.authorizeTerminal(snapshot);
        if (change === 'input') await submit(s, project);
        if (change === 'revision') await s.reviseWorkRequirements(id, { expectedRevision: snapshot.work_revision, requirements: { finish: 'A materially different deliverable' } });
        if (change === 'evidence') await pool.query("UPDATE vnext_evidence_refs SET evidence='[]'::jsonb WHERE work_unit_id=$1", [id]);
        if (change === 'result') await pool.query("UPDATE vnext_work_units SET last_turn=jsonb_set(last_turn,'{summary}','\"changed\"') WHERE work_unit_id=$1", [id]);
        if (change === 'project-authority' || change === 'reconciliation') {
          const other = await submit(s, project, 'other');
          const active = await admit(s, other.work_unit_id);
          if (change === 'reconciliation') await s.persistFailure(failExecution(active.workUnit, active.execution, { maxAttempts: 1, reconciliationRequired: true }));
        }
        const before = await pool.query('SELECT state,work_revision,last_turn FROM vnext_work_units WHERE work_unit_id=$1', [id]);
        const checking = change === 'revoked' ? store({ acceptanceVerifier: async () => false }) : change === 'truthy-verifier' ? store({ acceptanceVerifier: async () => ({ granted: true }) }) : s;
        await assert.rejects(checking.acceptWork(id, decision));
        assert.deepEqual((await pool.query('SELECT state,work_revision,last_turn FROM vnext_work_units WHERE work_unit_id=$1', [id])).rows, before.rows);
        assert.equal((await pool.query('SELECT 1 FROM vnext_events WHERE event_id=$1', [`acceptance:${decision.ref}`])).rowCount, 0);
      }
    });
    await t.test('competing admissions consume one proposal; canonical settlement replay and divergent rejection', async () => {
      const project = `race-${randomUUID()}`;
      const { work_unit_id: id } = await submit(store(), project);
      await run(store(), project, async ({ workUnit }) => next(workUnit.objective_ref));
      await pause();
      const s = store(); const w = await s.reconstruct({ work_unit_id: id });
      const candidates = await Promise.allSettled([admit(s, id, w), admit(store(), id, w)]);
      assert.equal(candidates.filter(r => r.status === 'fulfilled').length, 1);
      const begun = candidates.find(r => r.status === 'fulfilled').value;
      assert.equal(Number((await progress(id)).considered_proposal_id), w.pilot.pending_proposal.id);
      const turn = next(w.objective_ref);
      const result = { ...applyTurn(begun.workUnit, begun.execution, turn), handoff: canonicalHandoff(turn, begun.execution.admission) };
      // Caller terminal and execution-state assertions do not grant authority.
      result.workUnit.state = 'terminal'; result.execution.state = 'failed';
      const replays = await Promise.all([s.persistTurn(result), store().persistTurn(result)]);
      assert.deepEqual(replays[0], replays[1]);
      assert.equal(replays[0].workUnit.state, 'actionable');
      assert.equal(replays[0].execution.state, 'succeeded');
      assert.equal((await pool.query('SELECT 1 FROM vnext_pilot_results WHERE execution_id=$1', [begun.execution.execution_id])).rowCount, 1);
      await assert.rejects(s.persistTurn({ ...result, handoff: { ...result.handoff, summary: 'divergent' } }), /conflict/);
      await pause();
      const old = await admit(store(), id);
      await s.reviseWorkRequirements(id, { expectedRevision: 1, requirements: { finish: 'changed while executing' } });
      await assert.rejects(s.persistTurn(applyTurn(old.workUnit, old.execution, turn)), /stale work revision/);
    });
    await t.test('lost COMMIT responses are resolved from durable settlement and acceptance receipts', async () => {
      const project = `commit-${randomUUID()}`;
      const { work_unit_id: id } = await submit(store(), project);
      const begun = await admit(store(), id);
      const turn = done(begun.workUnit.objective_ref);
      const result = { ...applyTurn(begun.workUnit, begun.execution, turn), handoff: canonicalHandoff(turn, begun.execution.admission) };
      const loseCommit = () => {
        let armed = true;
        return { query: (...args) => pool.query(...args), async connect() {
          const client = await pool.connect();
          return { release: () => client.release(), async query(sql, args) {
            const value = await client.query(sql, args);
            if (sql === 'COMMIT' && armed) { armed = false; throw new Error('injected lost COMMIT response'); }
            return value;
          } };
        } };
      };
      const settled = await store({ pool: loseCommit() }).persistTurn(result);
      assert.equal(settled.workUnit.state, 'review');
      assert.deepEqual(await store().persistTurn(result), settled);
      const context = await store().getAcceptanceContext(id);
      const decision = await acceptance.authorizeTerminal(context);
      assert.equal((await store({ pool: loseCommit() }).acceptWork(id, decision)).state, 'terminal');
      assert.equal((await pool.query('SELECT 1 FROM vnext_executions WHERE work_unit_id=$1', [id])).rowCount, 1);
    });
  } finally { await pool.end(); await rm(dir, { recursive: true, force: true }); }
});

async function admit(store, id, work = null) {
  work ??= await store.reconstruct({ work_unit_id: id });
  const executionId = `exec-${randomUUID()}`;
  const claimed = claimWorkUnit({ ...work, state: 'actionable' }, { executionId, owner: 'test-owner' });
  const execution = { ...startExecution(createExecution(claimed, { executionId, owner: 'test-owner' })), authorization_decision_ref: `test:${executionId}` };
  return store.beginExecution(claimed, execution, { ref: execution.authorization_decision_ref });
}

test('memory durable receipt reconstruction and independent acceptance match PostgreSQL semantics', async () => {
  const a = testAcceptanceAuthority(c => c.turn.outcome_evidence?.[0]?.execution_id === 'proof');
  const options = { authorizationVerifier: authorization.verifyExecution, acceptanceVerifier: a.verifyAcceptance };
  const store = createMemoryStore({ ...options, workUnits: [createWorkUnit({ workUnitId: 'memory-work', objectiveRef: 'objective', projectId: 'project' })], executions: [{ execution_id: 'proof', state: 'succeeded' }] });
  const begun = await admit(store, 'memory-work');
  const turn = { objective_id: 'objective', disposition: 'done', summary: 'Checked outcome.', outcome_evidence: [{ kind: 'manifest', execution_id: 'proof' }] };
  const request = { ...applyTurn(begun.workUnit, begun.execution, turn), handoff: canonicalHandoff(turn, begun.execution.admission) };
  request.workUnit.state = 'terminal';
  const settled = await store.persistTurn(request);
  assert.equal(settled.workUnit.state, 'review');
  const saved = store.snapshot();
  const cold = createMemoryStore({ ...options, ...saved, workUnits: saved.work });
  assert.deepEqual(await cold.persistTurn(request), settled);
  const context = await cold.getAcceptanceContext('memory-work');
  const decision = await a.authorizeTerminal(context);
  const before = cold.snapshot();
  await assert.rejects(cold.acceptWork('memory-work', { ...decision, snapshotDigest: 'stale' }), /snapshot/);
  assert.deepEqual(cold.snapshot(), before);
  const results = await Promise.all([cold.acceptWork('memory-work', decision), cold.acceptWork('memory-work', decision)]);
  assert.deepEqual(results[0], results[1]);
  assert.equal(cold.snapshot().events.filter(e => e.type === 'work.accepted').length, 1);
});

test('memory acceptance collision after asynchronous verification leaves work unchanged', async () => {
  let release, entered;
  const gate = new Promise(r => { release = r; });
  const inspecting = new Promise(r => { entered = r; });
  const authority = testAcceptanceAuthority(c => c.evidence?.[0]?.execution_id === 'proof');
  const s = createMemoryStore({ workUnits: [createWorkUnit({ workUnitId: 'collision', objectiveRef: 'objective', projectId: 'project' })],
    authorizationVerifier: authorization.verifyExecution, acceptanceVerifier: async (d, c) => { entered(); await gate; return authority.verifyAcceptance(d, c); } });
  const begun = await admit(s, 'collision');
  await s.persistTurn(applyTurn(begun.workUnit, begun.execution, { objective_id: 'objective', disposition: 'done', summary: 'claim', outcome_evidence: [{ kind: 'manifest', execution_id: 'proof' }] }));
  const decision = await authority.authorizeTerminal(await s.getAcceptanceContext('collision'));
  const accepting = s.acceptWork('collision', decision);
  await inspecting;
  await s.appendEvent({ event_id: `acceptance:${decision.ref}`, type: 'work.accepted', payload: { divergent: true } });
  release();
  await assert.rejects(accepting, /content conflict/);
  assert.equal((await s.reconstruct({ work_unit_id: 'collision' })).state, 'review');
});

test('memory continuation cursor survives full snapshot reconstruction and is consumed only by the winning admission', async () => {
  const work = { ...createWorkUnit({ workUnitId: 'memory-pilot', objectiveRef: 'objective', projectId: 'project' }), pilot: { input_seq: 1, consumed_input_seq: 0, considered_proposal_id: 0, next_wake_at: null } };
  const options = { authorizationVerifier: authorization.verifyExecution, pilotIntervalMs: 1000 };
  const s = createMemoryStore({ ...options, workUnits: [work], continuations: [{ id: 900, work_unit_id: 'other-work', execution_id: 'other-exec', continuation: { mode: 'immediate', next_action: 'unrelated' } }] });
  const first = await admit(s, work.work_unit_id);
  await s.persistTurn(applyTurn(first.workUnit, first.execution, next('objective')));
  const saved = s.snapshot();
  assert.equal(saved.work[0].pilot.considered_proposal_id, 0, 'settlement must not consume any proposal, including another Work Unit');
  const cold = createMemoryStore({ ...options, ...saved, workUnits: saved.work });
  const pending = (await cold.reconstruct({ work_unit_id: work.work_unit_id })).pilot.pending_proposal;
  assert.equal(pending.work_unit_id, work.work_unit_id);
  await assert.rejects(admit(cold, work.work_unit_id), /not justified/);
  await pause();
  const current = await cold.reconstruct({ work_unit_id: work.work_unit_id });
  const denied = createMemoryStore({ ...options, ...saved, workUnits: saved.work, authorizationVerifier: async () => false });
  await assert.rejects(admit(denied, work.work_unit_id), /not valid/);
  assert.deepEqual(denied.snapshot(), saved);
  const competitors = await Promise.allSettled([admit(cold, work.work_unit_id, current), admit(cold, work.work_unit_id, current)]);
  assert.equal(competitors.filter(c => c.status === 'fulfilled').length, 1);
  const second = competitors.find(c => c.status === 'fulfilled').value;
  assert.equal(cold.snapshot().work[0].pilot.considered_proposal_id, pending.id);
  await cold.persistTurn(applyTurn(second.workUnit, second.execution, wait('objective')));
  const waiting = await cold.reconstruct({ work_unit_id: work.work_unit_id });
  assert.ok(waiting.pilot.pending_proposal.id > pending.id);
  assert.equal(waiting.pilot.considered_proposal_id, pending.id);
  await assert.rejects(admit(cold, work.work_unit_id), /not justified/);
});
