import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { testPool } from './pilot-test-pool.mjs';
import { migrateVNext } from '../lib/vnext/migration.mjs';
import { createPilotStore } from '../lib/vnext/pilot-store.mjs';
import { runPilotOnce } from '../lib/vnext/pilot.mjs';
import { recoverDispatches } from '../lib/vnext/dispatch-recovery.mjs';
import { createCommandExecutor } from '../lib/vnext/command-executor.mjs';
import { claimWorkUnit, createExecution, failExecution, startExecution } from '../lib/vnext/kernel.mjs';

const next = objective_id => ({ objective_id, disposition: 'continue', summary: 'Checked increment.', continuation: { mode: 'immediate', next_action: 'Check again.' } });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const authorization = {
  authorizeExecution: async ({ execution }) => ({ ref: `test:${execution.execution_id}` }),
  verifyExecution: async (d, { execution }) => d.ref === `test:${execution.execution_id}` && execution.authorization_decision_ref === d.ref,
  authorizeTerminal: async () => false,
};

async function admit(store, id) {
  const work = await store.reconstruct({ work_unit_id: id });
  const executionId = `exec-${randomUUID()}`;
  const claimed = claimWorkUnit({ ...work, state: 'actionable' }, { executionId, owner: 'test-owner' });
  const execution = { ...startExecution(createExecution(claimed, { executionId, owner: 'test-owner' })), authorization_decision_ref: `test:${executionId}` };
  return store.beginExecution(claimed, execution, { ref: execution.authorization_decision_ref });
}

test('cancellation intent: durable receipt, check points, and cancelled settlement', { timeout: 120000 }, async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'cancellation-'));
  const pool = await testPool({ dataDir: path.join(dir, 'db') });
  await writeFile(path.join(dir, 'identity.md'), 'Cancel only through an authorized durable intent.');
  const attemptsDirectory = path.join(dir, 'attempts');
  const store = (options = {}) => createPilotStore({ pool, intervalMs: 1000, authorizationVerifier: authorization.verifyExecution, acceptanceVerifier: async () => false, cancellationVerifier: async (decision, context) => decision.ref.startsWith('cancel:') && context.workRevision > 0, ...options });
  const submit = (projectId, threadId = 'thread') => store().submit({ projectId, threadId, receiptId: `receipt-${randomUUID()}`, message: 'Cancel-safe input.' });
  const expireClaim = async id => {
    if (!/^[A-Za-z0-9._:-]+$/.test(id)) throw new Error('unsafe test identifier');
    await pool.query(`UPDATE vnext_work_units SET claim_expires_at='2000-01-01T00:00:00Z' WHERE work_unit_id='${id}';
      UPDATE vnext_executions SET claim_expires_at='2000-01-01T00:00:00Z' WHERE work_unit_id='${id}' AND state IN ('created','running');
      UPDATE vnext_project_mutation_authority SET claim_expires_at='2000-01-01T00:00:00Z' WHERE work_unit_id='${id}';`);
  };
  const cancelWithUncertainty = async (project, id, expectedRevision) => {
    const begun = await admit(store(), id);
    const decision = { ref: `cancel:${randomUUID()}` };
    const recorded = await store().recordCancellation({ projectId: project, workUnitId: id, expectedRevision, decision });
    assert.equal(recorded.state, 'pending');
    const settled = await store().persistFailure(failExecution(begun.workUnit, begun.execution, { reconciliationRequired: true }));
    assert.equal(settled.state, 'cancelled');
    return { begun, decision, settled };
  };
  try {
    await pool.query("DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF; IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anonymous') THEN CREATE ROLE anonymous; END IF; END $$");
    await migrateVNext({ pool, directory: path.join(import.meta.dirname, '../vnext-migrations') });

    await t.test('idle work settles cancelled; replay and divergence are explicit', async () => {
      const project = `cancel-idle-${randomUUID()}`;
      const { work_unit_id: id } = await submit(project);
      const decision = { ref: `cancel:${randomUUID()}` };
      const recorded = await store().recordCancellation({ projectId: project, workUnitId: id, expectedRevision: 1, decision });
      assert.equal(recorded.created, true);
      assert.equal(recorded.state, 'cancelled');
      const replay = await store().recordCancellation({ projectId: project, workUnitId: id, expectedRevision: 1, decision });
      assert.equal(replay.created, false);
      assert.equal(replay.state, 'cancelled');
      await assert.rejects(store().recordCancellation({ projectId: project, workUnitId: id, expectedRevision: 1, decision: { ...decision, note: 'divergent' } }), /content conflict/);
      await assert.rejects(store().recordCancellation({ projectId: project, workUnitId: id, expectedRevision: 1, decision: { ref: `cancel:${randomUUID()}` } }), /already cancelled/);
      await assert.rejects(store().recordCancellation({ projectId: project, workUnitId: id, expectedRevision: 2, decision: { ref: `cancel:${randomUUID()}` } }), /revision changed/);
      await assert.rejects(store({ cancellationVerifier: async () => false }).recordCancellation({ projectId: project, workUnitId: id, expectedRevision: 1, decision: { ref: `cancel:${randomUUID()}` } }), /not valid|already cancelled/);
      assert.equal((await store().getCancellationIntent(id)).pending, false);
      await assert.rejects(admit(store(), id), /cancelled|changed/);
      // A new human input does not silently reopen cancelled work.
      await submit(project);
      assert.equal((await store().reconstruct({ work_unit_id: id })).state, 'cancelled');
      // Only a new authorized material revision reactivates it.
      const revised = await store().reviseWorkRequirements(id, { expectedRevision: 1, requirements: { finish: 'A new authorized deliverable.' } });
      assert.equal(revised.work_revision, 2);
      assert.equal((await store().reconstruct({ work_unit_id: id })).state, 'actionable');
      assert.equal(await store().nextEligible(project), id);
    });

    await t.test('dispatch refuses a pending cancellation intent', async () => {
      const project = `cancel-dispatch-${randomUUID()}`;
      const { work_unit_id: id } = await submit(project);
      await pool.query("INSERT INTO vnext_cancellation_intents(work_unit_id,project_id,work_revision,decision_ref,content_digest) VALUES ($1,$2,1,$3,$4)", [id, project, `direct:${randomUUID()}`, '0'.repeat(64)]);
      await assert.rejects(admit(store(), id), /E_CANCELLED/);
      assert.equal((await store().getCancellationIntent(id)).pending, true);
    });

    await t.test('a pending intent refuses effect admission for the claimed attempt', { skip: process.platform !== 'linux' }, async () => {
      const project = `cancel-effect-${randomUUID()}`;
      const { work_unit_id: id } = await submit(project);
      const before = await store().reconstruct({ work_unit_id: id });
      const begun = await admit(store(), id);
      const executor = createCommandExecutor({ command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'], stateDirectory: attemptsDirectory });
      let captured = null;
      const running = executor({ execution: { execution_id: begun.execution.execution_id }, workspaceRoot: dir, timeoutMs: 60000 }, {
        onSpawn: async identity => { captured = identity; await store().recordLaunch(begun.workUnit, begun.execution, identity); },
      }).catch(() => null);
      for (let i = 0; i < 100 && !captured; i += 1) await pause(25);
      assert.ok(captured, 'the launch identity is durable before cancellation is recorded');
      const decision = { ref: `cancel:${randomUUID()}` };
      const intent = await store().recordCancellation({ projectId: project, workUnitId: id, expectedRevision: before.work_revision, decision });
      assert.equal(intent.state, 'pending');
      await assert.rejects(store().assertEffectAdmissible({ projectId: project, workUnitId: id, executionId: begun.execution.execution_id }), /E_CANCELLED/);
      await expireClaim(id);
      const summaries = await recoverDispatches({ store: store(), projectId: project, stateDirectory: attemptsDirectory });
      assert.equal(summaries.length, 1);
      assert.equal(summaries[0].action, 'settled-cancelled');
      await running;
      const after = await store().reconstruct({ work_unit_id: id });
      assert.equal(after.state, 'cancelled');
      assert.equal(after.claim, null);
      assert.equal((await store().getCancellationIntent(id)).pending, false);
      const execution = (await pool.query('SELECT state,failure FROM vnext_executions WHERE execution_id=$1', [begun.execution.execution_id])).rows[0];
      assert.equal(execution.state, 'failed');
      assert.equal(execution.failure.reason, 'cancelled');
      assert.equal(execution.failure.reconciliation_required, true);
      assert.equal(after.failure.reconciliation_required, true);
      assert.equal((await pool.query('SELECT count(*)::int AS c FROM vnext_project_reconciliation_blocks WHERE project_id=$1 AND execution_id=$2', [project, begun.execution.execution_id])).rows[0].c, 1);
      assert.equal((await pool.query('SELECT count(*)::int AS c FROM vnext_project_mutation_authority WHERE project_id=$1', [project])).rows[0].c, 0);
      // Effect uncertainty blocks a conflicting work unit in the same project.
      const second = await submit(project, `other-${randomUUID()}`);
      await assert.rejects(admit(store(), second.work_unit_id), /E_RECONCILIATION_REQUIRED/);
    });

    await t.test('effect admission guards the current revision and project uncertainty', async () => {
      const project = `effect-admission-${randomUUID()}`;
      const { work_unit_id: id } = await submit(project);
      const before = await store().reconstruct({ work_unit_id: id });
      const begun = await admit(store(), id);
      const guard = () => store().assertEffectAdmissible({ projectId: project, workUnitId: id, executionId: begun.execution.execution_id });
      assert.equal(await guard(), true);
      assert.equal(await guard(), true);
      assert.equal((await pool.query('SELECT count(*)::int AS c FROM vnext_project_reconciliation_blocks WHERE project_id=$1', [project])).rows[0].c, 0);
      assert.equal((await pool.query('SELECT count(*)::int AS c FROM vnext_cancellation_intents WHERE work_unit_id=$1', [id])).rows[0].c, 0);

      await store().reviseWorkRequirements(id, { expectedRevision: before.work_revision, requirements: { finish: 'A newer authorized deliverable.' } });
      await assert.rejects(guard(), /E_STALE_REVISION/);

      const blockedProject = `effect-blocked-${randomUUID()}`;
      const blocked = await submit(blockedProject);
      const blockedBegun = await admit(store(), blocked.work_unit_id);
      await pool.query("INSERT INTO vnext_project_reconciliation_blocks(project_id,work_unit_id,execution_id,fence,reason) VALUES ($1,$2,$3,$4,'external-effect-uncertain')", [blockedProject, blocked.work_unit_id, blockedBegun.execution.execution_id, blockedBegun.execution.fence]);
      await assert.rejects(store().assertEffectAdmissible({ projectId: blockedProject, workUnitId: blocked.work_unit_id, executionId: blockedBegun.execution.execution_id }), /E_RECONCILIATION_REQUIRED/);
    });

    await t.test('effect admission refuses an expired, stop-unconfirmed attempt', async () => {
      const project = `effect-expired-${randomUUID()}`;
      const { work_unit_id: id } = await submit(project);
      const begun = await admit(store(), id);
      const guard = () => store().assertEffectAdmissible({ projectId: project, workUnitId: id, executionId: begun.execution.execution_id });
      assert.equal(await guard(), true);
      await expireClaim(id);
      await assert.rejects(guard(), /E_AUTHORITY_EXPIRED/);
      assert.equal((await pool.query('SELECT state FROM vnext_executions WHERE execution_id=$1', [begun.execution.execution_id])).rows[0].state, 'running');
      assert.equal((await pool.query('SELECT claim_execution_id FROM vnext_work_units WHERE work_unit_id=$1', [id])).rows[0].claim_execution_id, begun.execution.execution_id);
      assert.equal((await pool.query('SELECT count(*)::int AS c FROM vnext_project_mutation_authority WHERE project_id=$1', [project])).rows[0].c, 1);
    });

    await t.test('effect admission refuses a missing or mismatched authority', async () => {
      const missingProject = `effect-missing-authority-${randomUUID()}`;
      const missing = await submit(missingProject);
      const missingBegun = await admit(store(), missing.work_unit_id);
      await pool.query('DELETE FROM vnext_project_mutation_authority WHERE project_id=$1', [missingProject]);
      await assert.rejects(store().assertEffectAdmissible({ projectId: missingProject, workUnitId: missing.work_unit_id, executionId: missingBegun.execution.execution_id }), /E_AUTHORITY_UNAVAILABLE/);

      const project = `effect-mismatched-authority-${randomUUID()}`;
      const first = await submit(project);
      const begun = await admit(store(), first.work_unit_id);
      const other = await submit(project, `other-${randomUUID()}`);
      const otherExecution = `exec-${randomUUID()}`;
      const expires = new Date(Date.now() + 3600000).toISOString();
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query("UPDATE vnext_work_units SET state='waiting',fence=1,claim_execution_id=$2,claim_owner='test-owner',claim_fence=1,claim_expires_at=$3 WHERE work_unit_id=$1", [other.work_unit_id, otherExecution, expires]);
        await client.query("INSERT INTO vnext_executions(execution_id,work_unit_id,project_id,owner,fence,state,started_at,claim_expires_at,authorization_decision_ref,attempt,admission) VALUES ($1,$2,$3,'test-owner',1,'running',clock_timestamp(),$4,$5,1,'{}'::jsonb)", [otherExecution, other.work_unit_id, project, expires, `test:${otherExecution}`]);
        await client.query('DELETE FROM vnext_project_mutation_authority WHERE project_id=$1', [project]);
        await client.query("INSERT INTO vnext_project_mutation_authority(project_id,work_unit_id,execution_id,fence,owner,claim_expires_at,authorization_decision_ref) VALUES ($1,$2,$3,1,'test-owner',$4,$5)", [project, other.work_unit_id, otherExecution, expires, `test:${otherExecution}`]);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
      await assert.rejects(store().assertEffectAdmissible({ projectId: project, workUnitId: first.work_unit_id, executionId: begun.execution.execution_id }), /E_AUTHORITY_UNAVAILABLE/);
      assert.equal((await pool.query('SELECT state FROM vnext_executions WHERE execution_id=$1', [begun.execution.execution_id])).rows[0].state, 'running');
      assert.equal((await pool.query('SELECT execution_id FROM vnext_project_mutation_authority WHERE project_id=$1', [project])).rows[0].execution_id, otherExecution);
    });

    await t.test('reconciliation resolves uncertainty without revoking cancellation', async () => {
      for (const resolution of ['no_effect', 'effect_applied']) {
        const project = `cancel-reconcile-${resolution}-${randomUUID()}`;
        const { work_unit_id: id } = await submit(project);
        const before = await store().reconstruct({ work_unit_id: id });
        const { begun } = await cancelWithUncertainty(project, id, before.work_revision);
        const reconciled = await store().reconcileFailure({ projectId: project, workUnitId: id, executionId: begun.execution.execution_id, fence: begun.execution.fence, resolution });
        assert.equal(reconciled.state, 'cancelled');
        assert.equal((await store().reconstruct({ work_unit_id: id })).state, 'cancelled');
        assert.equal((await pool.query('SELECT count(*)::int AS c FROM vnext_project_reconciliation_blocks WHERE project_id=$1', [project])).rows[0].c, 0);
        assert.equal(await store().nextEligible(project), null);
        await assert.rejects(admit(store(), id), /cancelled|changed/);
        // Reconciliation alone grants no new admission; an authorized revision does.
        await store().reviseWorkRequirements(id, { expectedRevision: 1, requirements: { finish: 'A new authorized deliverable.' } });
        assert.equal((await store().reconstruct({ work_unit_id: id })).state, 'actionable');
        assert.equal(await store().nextEligible(project), id);
      }
    });

    await t.test('cancellation recorded after an uncertain settlement still governs reconciliation', async () => {
      for (const resolution of ['no_effect', 'effect_applied']) {
        const project = `cancel-after-uncertain-${resolution}-${randomUUID()}`;
        const { work_unit_id: id } = await submit(project);
        const before = await store().reconstruct({ work_unit_id: id });
        const begun = await admit(store(), id);
        await store().persistFailure(failExecution(begun.workUnit, begun.execution, { reconciliationRequired: true }));
        assert.equal((await pool.query('SELECT count(*)::int AS c FROM vnext_project_reconciliation_blocks WHERE project_id=$1', [project])).rows[0].c, 1);
        // The attempt is already settled and unclaimed, so cancellation is idle:
        // it consumes its intent without naming a consuming execution.
        const recorded = await store().recordCancellation({ projectId: project, workUnitId: id, expectedRevision: before.work_revision, decision: { ref: `cancel:${randomUUID()}` } });
        assert.equal(recorded.state, 'cancelled');
        assert.equal((await pool.query('SELECT consumed_by_execution_id FROM vnext_cancellation_intents WHERE work_unit_id=$1 AND work_revision=$2', [id, before.work_revision])).rows[0].consumed_by_execution_id, null);
        const reconciled = await store().reconcileFailure({ projectId: project, workUnitId: id, executionId: begun.execution.execution_id, fence: begun.execution.fence, resolution });
        assert.equal(reconciled.state, 'cancelled');
        assert.equal((await store().reconstruct({ work_unit_id: id })).state, 'cancelled');
        assert.equal((await pool.query('SELECT count(*)::int AS c FROM vnext_project_reconciliation_blocks WHERE project_id=$1', [project])).rows[0].c, 0);
        assert.equal(await store().nextEligible(project), null);
        await assert.rejects(admit(store(), id), /cancelled|changed/);
        await store().reviseWorkRequirements(id, { expectedRevision: before.work_revision, requirements: { finish: 'A new authorized deliverable.' } });
        assert.equal((await store().reconstruct({ work_unit_id: id })).state, 'actionable');
        assert.equal(await store().nextEligible(project), id);
      }
    });

    await t.test('later revisions can be cancelled while earlier receipts remain replayable', async () => {
      const project = `cancel-revisions-${randomUUID()}`;
      const { work_unit_id: id } = await submit(project);
      const first = { ref: `cancel:${randomUUID()}` };
      const firstResult = await store().recordCancellation({ projectId: project, workUnitId: id, expectedRevision: 1, decision: first });
      assert.equal(firstResult.created, true);
      assert.equal(firstResult.state, 'cancelled');
      await store().reviseWorkRequirements(id, { expectedRevision: 1, requirements: { finish: 'Second authorized deliverable.' } });
      assert.equal((await store().reconstruct({ work_unit_id: id })).state, 'actionable');
      const second = { ref: `cancel:${randomUUID()}` };
      const secondResult = await store().recordCancellation({ projectId: project, workUnitId: id, expectedRevision: 2, decision: second });
      assert.equal(secondResult.created, true);
      assert.equal(secondResult.state, 'cancelled');
      const replay = await store().recordCancellation({ projectId: project, workUnitId: id, expectedRevision: 1, decision: first });
      assert.equal(replay.created, false);
      assert.equal(replay.work_revision, 1);
      assert.equal(replay.state, 'cancelled');
      assert.equal((await store().getCancellationIntent(id)).work_revision, 2);
      assert.equal((await pool.query('SELECT count(*)::int AS c FROM vnext_cancellation_intents WHERE work_unit_id=$1', [id])).rows[0].c, 2);
      await store().reviseWorkRequirements(id, { expectedRevision: 2, requirements: { finish: 'Third authorized deliverable.' } });
      const third = await store().recordCancellation({ projectId: project, workUnitId: id, expectedRevision: 3, decision: { ref: `cancel:${randomUUID()}` } });
      assert.equal(third.created, true);
      assert.equal((await pool.query('SELECT count(*)::int AS c FROM vnext_cancellation_intents WHERE work_unit_id=$1', [id])).rows[0].c, 3);
    });

    await t.test('a cancellation racing settlement wins and accepts no result', async () => {
      const project = `cancel-race-${randomUUID()}`;
      const { work_unit_id: id } = await submit(project);
      const before = await store().reconstruct({ work_unit_id: id });
      const result = await runPilotOnce({
        store: store(), projectId: project, workspaceRoot: dir, identityFiles: [path.join(dir, 'identity.md')], authority: authorization,
        executor: async ({ workUnit }) => {
          const recorded = await store().recordCancellation({ projectId: project, workUnitId: workUnit.work_unit_id, expectedRevision: before.work_revision, decision: { ref: `cancel:${randomUUID()}` } });
          assert.equal(recorded.state, 'pending');
          return next(workUnit.objective_ref);
        },
      });
      assert.equal(result.disposition, 'cancelled');
      assert.equal((await store().reconstruct({ work_unit_id: id })).state, 'cancelled');
      assert.equal((await store().getCancellationIntent(id)).pending, false);
      assert.equal((await pool.query('SELECT count(*)::int AS c FROM vnext_pilot_results WHERE execution_id=$1', [result.execution_id])).rows[0].c, 0);
      assert.equal((await pool.query('SELECT count(*)::int AS c FROM vnext_events WHERE event_id=$1', [`handoff:${result.execution_id}`])).rows[0].c, 0);
      assert.equal((await pool.query('SELECT count(*)::int AS c FROM vnext_evidence_refs WHERE execution_id=$1', [result.execution_id])).rows[0].c, 0);
    });
  } finally {
    await pool.end();
    await rm(dir, { recursive: true, force: true });
  }
});
