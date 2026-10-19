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
import { claimWorkUnit, createExecution, startExecution } from '../lib/vnext/kernel.mjs';

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
  const submit = projectId => store().submit({ projectId, threadId: 'thread', receiptId: `receipt-${randomUUID()}`, message: 'Cancel-safe input.' });
  const expireClaim = async id => {
    if (!/^[A-Za-z0-9._:-]+$/.test(id)) throw new Error('unsafe test identifier');
    await pool.query(`UPDATE vnext_work_units SET claim_expires_at='2000-01-01T00:00:00Z' WHERE work_unit_id='${id}';
      UPDATE vnext_executions SET claim_expires_at='2000-01-01T00:00:00Z' WHERE work_unit_id='${id}' AND state IN ('created','running');
      UPDATE vnext_project_mutation_authority SET claim_expires_at='2000-01-01T00:00:00Z' WHERE work_unit_id='${id}';`);
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

    await t.test('a pending intent refuses effect admission for the observed revision only', { skip: process.platform !== 'linux' }, async () => {
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
      await assert.rejects(store().assertEffectAdmissible({ projectId: project, workUnitId: id, workRevision: before.work_revision }), /E_CANCELLED/);
      assert.equal(await store().assertEffectAdmissible({ projectId: project, workUnitId: id, workRevision: before.work_revision + 1 }), true);
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
      assert.equal((await pool.query('SELECT count(*)::int AS c FROM vnext_project_mutation_authority WHERE project_id=$1', [project])).rows[0].c, 0);
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
