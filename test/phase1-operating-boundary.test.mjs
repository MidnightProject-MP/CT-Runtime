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
      for (const change of ['input', 'revision', 'evidence', 'revoked', 'result', 'pilot-result', 'project-authority', 'reconciliation', 'truthy-verifier']) {
        const project = `stale-${randomUUID()}`;
        const { work_unit_id: id } = await submit(store(), project);
        await run(store(), project, async ({ workUnit }) => done(workUnit.objective_ref));
        const s = store(); const snapshot = await s.getAcceptanceContext(id);
        const decision = await acceptance.authorizeTerminal(snapshot);
        if (change === 'input') await submit(s, project);
        if (change === 'revision') await s.reviseWorkRequirements(id, { expectedRevision: snapshot.work_revision, requirements: { finish: 'A materially different deliverable' } });
        if (change === 'evidence') await pool.query("UPDATE vnext_evidence_refs SET evidence='[]'::jsonb WHERE work_unit_id=$1", [id]);
        if (change === 'result') await pool.query("UPDATE vnext_work_units SET last_turn=jsonb_set(last_turn,'{summary}','\"changed\"') WHERE work_unit_id=$1", [id]);
        if (change === 'pilot-result') await pool.query("UPDATE vnext_pilot_results SET turn=jsonb_set(turn,'{summary}','\"changed\"') WHERE work_unit_id=$1", [id]);
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
        if (change === 'revision') assert.equal(await store().nextEligible(project), id, 'trusted material revision is a fresh coordinator opportunity');
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
    await t.test('reconciliation records one durable outcome and exactly one recovery opportunity', async () => {
      const project = `recover-${randomUUID()}`;
      const { work_unit_id: id } = await submit(store(), project);
      assert.equal((await run(store(), project, async ({ workUnit }) => next(workUnit.objective_ref))).disposition, 'continue');
      await pause();
      await assert.rejects(
        run(store(), project, async () => { throw new Error('outcome uncertain before any effect is known'); }),
        /outcome uncertain/,
      );
      const failed = await store().reconstruct({ work_unit_id: id });
      assert.equal(failed.state, 'review');
      assert.equal(failed.claim, null);
      assert.equal((await progress(id)).next_wake_at, null, 'a settled continuation leaves no coordinator due time');
      assert.equal(await store().nextEligible(project), null);
      const failedExecution = (await pool.query("SELECT execution_id,fence,failure FROM vnext_executions WHERE work_unit_id=$1 AND state='failed'", [id])).rows[0];
      assert.equal(failedExecution.failure.reconciliation_required, true);
      const untouched = await progress(id);
      await assert.rejects(store().reconcileFailure({ projectId: project, workUnitId: id, executionId: failedExecution.execution_id, fence: Number(failedExecution.fence) + 1, resolution: 'no_effect' }), /does not match durable project block/);
      assert.deepEqual(await progress(id), untouched, 'a mismatched reconciliation changes nothing');
      await pool.end();
      pool = await testPool({ dataDir: path.join(dir, 'db') });
      const cold = store();
      assert.equal(await cold.nextEligible(project), null, 'unresolved uncertainty never spins the executor');
      const reconciled = await cold.reconcileFailure({ projectId: project, workUnitId: id, executionId: failedExecution.execution_id, fence: Number(failedExecution.fence), resolution: 'no_effect' });
      assert.equal(reconciled.state, 'actionable');
      const recorded = (await pool.query('SELECT event_type,payload FROM vnext_events WHERE event_id=$1', [`reconciliation:${failedExecution.execution_id}`])).rows[0];
      assert.equal(recorded.event_type, 'reconciliation.recorded');
      assert.equal(recorded.payload.result.state, 'actionable');
      const due = await progress(id);
      assert.ok(due.next_wake_at && due.next_wake_at.getTime() <= Date.now(), 'reconciliation creates a coordinator-owned due time');
      assert.equal(await store().nextEligible(project), id);
      const w = await cold.reconstruct({ work_unit_id: id });
      const racers = await Promise.allSettled([admit(cold, id, w), admit(store(), id, w)]);
      assert.equal(racers.filter(r => r.status === 'fulfilled').length, 1, 'overlapping wakes admit exactly one recovery attempt');
      const recovery = racers.find(r => r.status === 'fulfilled').value;
      assert.equal((await pool.query('SELECT count(*)::int AS count FROM vnext_executions WHERE work_unit_id=$1', [id])).rows[0].count, 3);
      const replay = await store().reconcileFailure({ projectId: project, workUnitId: id, executionId: failedExecution.execution_id, fence: Number(failedExecution.fence), resolution: 'no_effect' });
      assert.deepEqual(replay, reconciled, 'replaying reconciliation returns the recorded outcome');
      assert.equal((await pool.query('SELECT count(*)::int AS count FROM vnext_events WHERE event_id=$1', [`reconciliation:${failedExecution.execution_id}`])).rows[0].count, 1);
      await assert.rejects(store().reconcileFailure({ projectId: project, workUnitId: id, executionId: failedExecution.execution_id, fence: Number(failedExecution.fence), resolution: 'effect_applied' }), /content conflict/);
      assert.equal((await pool.query('SELECT count(*)::int AS count FROM vnext_executions WHERE work_unit_id=$1', [id])).rows[0].count, 3, 'replays create no second opportunity');
      await store().persistFailure(failExecution(recovery.workUnit, recovery.execution, { maxAttempts: 1, failure: { message: 'recovery attempt failed outright' } }));
      const settled = await store().reconstruct({ work_unit_id: id });
      assert.equal(settled.state, 'review');
      assert.equal(settled.attempt, 3, 'attempt history is preserved, not reset by reconciliation');
      assert.equal(await store().nextEligible(project), null);
      assert.equal(await store().nextEligible(project), null, 'no automatic retry loop after a further failure');
      await assert.rejects(store().reconcileFailure({ projectId: project, workUnitId: id, executionId: recovery.execution.execution_id, fence: 3, resolution: 'no_effect' }), /does not match durable project block/);
    });
    await t.test('input arriving during unresolved uncertainty preserves reconciliation and is seen by the recovery attempt', async () => {
      const project = `recover-input-${randomUUID()}`;
      const { work_unit_id: id } = await submit(store(), project);
      assert.equal((await run(store(), project, async ({ workUnit }) => next(workUnit.objective_ref))).disposition, 'continue');
      await pause();
      await assert.rejects(
        run(store(), project, async () => { throw new Error('outcome uncertain before any effect is known'); }),
        /outcome uncertain/,
      );
      const failedExecution = (await pool.query("SELECT execution_id,fence FROM vnext_executions WHERE work_unit_id=$1 AND state='failed'", [id])).rows[0];
      const consumedBefore = (await progress(id)).consumed_input_seq;
      const fresh = await store().submit({ projectId: project, threadId: 'thread', receiptId: `receipt-${randomUUID()}`, message: 'Recovery input' });
      assert.equal((await store().reconstruct({ work_unit_id: id })).state, 'review', 'input arrival preserves the reconciliation disposition');
      assert.equal((await progress(id)).consumed_input_seq, consumedBefore, 'input arrival does not consume the new input');
      await pool.end();
      pool = await testPool({ dataDir: path.join(dir, 'db') });
      const cold = store();
      assert.equal(await cold.nextEligible(project), null, 'uncertainty still excludes the project after restart');
      const reconciled = await cold.reconcileFailure({ projectId: project, workUnitId: id, executionId: failedExecution.execution_id, fence: Number(failedExecution.fence), resolution: 'no_effect' });
      assert.equal(reconciled.state, 'actionable');
      assert.equal(await cold.nextEligible(project), id);
      const recovery = await run(cold, project, async ({ workUnit }) => {
        assert.equal(workUnit.pilot.input_seq, fresh.input_seq, 'the recovery attempt sees the new input');
        assert.ok(workUnit.pilot.inputs.some(i => i.message === 'Recovery input'));
        return wait(workUnit.objective_ref);
      });
      assert.equal(recovery.disposition, 'waiting');
      assert.equal((await pool.query('SELECT count(*)::int AS count FROM vnext_executions WHERE work_unit_id=$1', [id])).rows[0].count, 3);
    });
    await t.test('a requirements revision during execution supersedes the stale attempt and frees the new revision', async () => {
      const project = `supersede-${randomUUID()}`;
      const { work_unit_id: id } = await submit(store(), project);
      await assert.rejects(
        run(store(), project, async ({ workUnit }) => {
          await store().reviseWorkRequirements(id, { expectedRevision: workUnit.work_revision, requirements: { finish: 'changed while executing' } });
          return wait(workUnit.objective_ref);
        }),
        /stale work revision/,
      );
      const after = await store().reconstruct({ work_unit_id: id });
      assert.equal(after.state, 'actionable');
      assert.equal(after.claim, null);
      assert.equal(after.work_revision, 2);
      assert.equal(after.attempt, 1, 'supersede preserves the attempt count');
      assert.equal(after.last_turn, null, 'the rejected completion is not installed as history');
      const superseded = (await pool.query("SELECT * FROM vnext_executions WHERE work_unit_id=$1 AND state='failed'", [id])).rows[0];
      assert.equal(superseded.failure.reason, 'requirements-revision');
      assert.equal(Number(superseded.attempt), 1);
      assert.equal((await pool.query('SELECT count(*)::int AS count FROM vnext_events WHERE event_id=$1', [`superseded:${superseded.execution_id}`])).rows[0].count, 1);
      assert.equal((await pool.query('SELECT count(*)::int AS count FROM vnext_events WHERE event_id=$1', [`handoff:${superseded.execution_id}`])).rows[0].count, 0, 'the stale result is rejected, not settled');
      assert.equal((await pool.query('SELECT count(*)::int AS count FROM vnext_project_mutation_authority WHERE project_id=$1', [project])).rows[0].count, 0);
      assert.equal(await store().nextEligible(project), id, 'the revised work is discoverable after restart');
      const second = await run(store(), project, async ({ workUnit, execution }) => {
        assert.equal(workUnit.work_revision, 2);
        const before = (await pool.query('SELECT state,claim_execution_id,last_turn,attempt FROM vnext_work_units WHERE work_unit_id=$1', [id])).rows[0];
        const held = (await pool.query('SELECT execution_id FROM vnext_project_mutation_authority WHERE project_id=$1', [project])).rows[0];
        assert.equal(held.execution_id, execution.execution_id);
        const stale = { execution_id: superseded.execution_id, work_unit_id: id, project_id: project, owner: superseded.owner, fence: Number(superseded.fence), state: 'running', claim_expires_at: superseded.claim_expires_at.toISOString(), authorization_decision_ref: superseded.authorization_decision_ref };
        await assert.rejects(store().persistTurn({ workUnit: structuredClone(workUnit), execution: stale, turn: wait(workUnit.objective_ref) }), /fencing conflict/);
        await assert.rejects(store().persistFailure({ workUnit: structuredClone(workUnit), execution: stale }), /fencing conflict/);
        const still = (await pool.query('SELECT execution_id FROM vnext_project_mutation_authority WHERE project_id=$1', [project])).rows[0];
        assert.equal(still.execution_id, execution.execution_id, 'a late old result cannot release the successor authority');
        const unchanged = (await pool.query('SELECT state,claim_execution_id,last_turn,attempt FROM vnext_work_units WHERE work_unit_id=$1', [id])).rows[0];
        assert.deepEqual(unchanged, before, 'a late old result cannot overwrite state');
        return wait(workUnit.objective_ref);
      });
      assert.equal(second.disposition, 'waiting');
      const successor = (await pool.query("SELECT admission FROM vnext_executions WHERE work_unit_id=$1 AND state='succeeded'", [id])).rows[0];
      assert.equal(Number(successor.admission.work_revision), 2);
      const final = await store().reconstruct({ work_unit_id: id });
      assert.equal(final.attempt, 2);
      assert.equal(final.last_turn.disposition, 'waiting');
      assert.equal((await pool.query('SELECT state FROM vnext_executions WHERE execution_id=$1', [superseded.execution_id])).rows[0].state, 'failed', 'the superseded attempt remains as history');
      const recorded = (await pool.query('SELECT payload FROM vnext_events WHERE event_id=$1', [`superseded:${superseded.execution_id}`])).rows[0].payload;
      const staleArgs = { execution_id: superseded.execution_id, work_unit_id: id, project_id: project, owner: superseded.owner, fence: Number(superseded.fence), state: 'running', claim_expires_at: superseded.claim_expires_at.toISOString(), authorization_decision_ref: superseded.authorization_decision_ref };
      const replayed = await store().persistSuperseded({ workUnit: { work_unit_id: id, project_id: project }, execution: staleArgs });
      assert.deepEqual(replayed, recorded.result, 'an exact supersession replay returns the recorded outcome');
      assert.equal((await pool.query('SELECT count(*)::int AS count FROM vnext_events WHERE event_id=$1', [`superseded:${superseded.execution_id}`])).rows[0].count, 1);
      const unchanged = (await pool.query('SELECT state,claim_execution_id,last_execution_id,attempt FROM vnext_work_units WHERE work_unit_id=$1', [id])).rows[0];
      await assert.rejects(store().persistSuperseded({ workUnit: { work_unit_id: id, project_id: project }, execution: { ...staleArgs, fence: Number(staleArgs.fence) + 1 } }), /supersession content conflict/);
      assert.deepEqual((await pool.query('SELECT state,claim_execution_id,last_execution_id,attempt FROM vnext_work_units WHERE work_unit_id=$1', [id])).rows[0], unchanged, 'divergent supersession content changes nothing');
      assert.equal((await pool.query('SELECT count(*)::int AS count FROM vnext_events WHERE event_id=$1', [`superseded:${superseded.execution_id}`])).rows[0].count, 1);
    });
    await t.test('uncertainty during a requirements revision preserves exclusion until reconciliation frees the new revision', async () => {
      const project = `revise-uncertain-${randomUUID()}`;
      const { work_unit_id: id } = await submit(store(), project);
      await assert.rejects(
        run(store(), project, async ({ workUnit }) => {
          await store().reviseWorkRequirements(id, { expectedRevision: workUnit.work_revision, requirements: { finish: 'moved during an uncertain attempt' } });
          throw new Error('effects uncertain during revision');
        }),
        /effects uncertain during revision/,
      );
      const blocked = await store().reconstruct({ work_unit_id: id });
      assert.equal(blocked.state, 'review');
      assert.equal(blocked.work_revision, 2);
      assert.equal(blocked.claim, null);
      assert.equal(await store().nextEligible(project), null, 'unresolved uncertainty never spins the executor');
      const failedExecution = (await pool.query('SELECT execution_id,fence FROM vnext_executions WHERE work_unit_id=$1', [id])).rows[0];
      const reconciled = await store().reconcileFailure({ projectId: project, workUnitId: id, executionId: failedExecution.execution_id, fence: Number(failedExecution.fence), resolution: 'no_effect' });
      assert.equal(reconciled.state, 'actionable');
      assert.equal(await store().nextEligible(project), id, 'resolving uncertainty makes the revised work discoverable');
      const progressed = await run(store(), project, async ({ workUnit }) => {
        assert.equal(workUnit.work_revision, 2);
        return wait(workUnit.objective_ref);
      });
      assert.equal(progressed.disposition, 'waiting');
      assert.equal(Number((await pool.query("SELECT admission FROM vnext_executions WHERE work_unit_id=$1 AND state='succeeded'", [id])).rows[0].admission.work_revision), 2);
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

test('memory reconciliation records its outcome and grants one coordinator-owned recovery opportunity', async () => {
  const work = { ...createWorkUnit({ workUnitId: 'memory-recover', objectiveRef: 'objective', projectId: 'memory-recover-project' }), pilot: { input_seq: 1, consumed_input_seq: 1, considered_proposal_id: 0, next_wake_at: new Date().toISOString() } };
  const store = createMemoryStore({ workUnits: [work], authorizationVerifier: authorization.verifyExecution });
  const active = await admit(store, 'memory-recover');
  await store.persistFailure(failExecution(active.workUnit, active.execution, { maxAttempts: 1, reconciliationRequired: true }));
  assert.equal((await store.reconstruct({ work_unit_id: 'memory-recover' })).state, 'review');
  const reconciled = await store.reconcileFailure({ projectId: 'memory-recover-project', workUnitId: 'memory-recover', executionId: active.execution.execution_id, fence: 1, resolution: 'no_effect' });
  assert.equal(reconciled.state, 'actionable');
  assert.ok(store.snapshot().work[0].pilot.next_wake_at, 'recovery is durably discoverable');
  assert.equal(store.snapshot().events.filter(e => e.event_id === `reconciliation:${active.execution.execution_id}`).length, 1);
  const replay = await store.reconcileFailure({ projectId: 'memory-recover-project', workUnitId: 'memory-recover', executionId: active.execution.execution_id, fence: 1, resolution: 'no_effect' });
  assert.deepEqual(replay, reconciled);
  assert.equal(store.snapshot().events.filter(e => e.event_id === `reconciliation:${active.execution.execution_id}`).length, 1);
});
