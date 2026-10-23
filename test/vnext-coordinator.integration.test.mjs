import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { testPool } from './pilot-test-pool.mjs';
import { migrateVNext } from '../lib/vnext/migration.mjs';
import { createPilotStore } from '../lib/vnext/pilot-store.mjs';
import { runCoordinatorPass, runCoordinatorLoop, writePauseFile, removePauseFile } from '../lib/vnext/coordinator.mjs';
import { deriveCoordinatorStatus } from '../lib/vnext/coordinator-status.mjs';
import { testAcceptanceAuthority } from './vnext-test-acceptance.mjs';
import { verifyTurnEvidenceIntegrity } from '../lib/objective-turn.mjs';
import { claimWorkUnit, createExecution, startExecution, failExecution } from '../lib/vnext/kernel.mjs';

const next = objective_id => ({ objective_id, disposition: 'continue', summary: 'Checked one increment.', continuation: { mode: 'immediate', next_action: 'Check the next consequence.' } });
const authorization = {
  authorizeExecution: async ({ execution }) => ({ ref: `coordinator:${execution.execution_id}` }),
  verifyExecution: async (decision, { execution }) => decision?.ref === execution.authorization_decision_ref,
};

test('coordinator pass, status, restart recovery, overlap, pause, and cancellation', { timeout: 120000 }, async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'coordinator-'));
  const additionalWorkspaces = [];
  const makeWorkspace = async prefix => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), `${prefix}-`));
    additionalWorkspaces.push(workspaceRoot);
    return workspaceRoot;
  };
  const pool = await testPool({ dataDir: path.join(dir, 'db') });
  const identityFile = path.join(dir, 'identity.md');
  await writeFile(identityFile, 'Coordinator test identity.');
  await writeFile(path.join(dir, 'proof.txt'), 'verified coordinator result');
  const proofHash = createHash('sha256').update('verified coordinator result').digest('hex');
  const acceptance = testAcceptanceAuthority(async context => {
    await verifyTurnEvidenceIntegrity(context.turn, { workspaceRoot: dir });
    return context.turn.summary === 'Coordinator outcome checked.';
  });
  const authority = { ...authorization, ...acceptance };
  const store = (options = {}) => createPilotStore({ pool, intervalMs: 60000, authorizationVerifier: authorization.verifyExecution, acceptanceVerifier: acceptance.verifyAcceptance, cancellationVerifier: async () => true, ...options });
  const project = `coordinator-${randomUUID()}`;
  const run = (s, executor, extra = {}) => runCoordinatorPass({
    store: s, projectId: project, workspaceRoot: dir, identityFiles: [identityFile], executor, authority,
    timeoutMs: 5000, coordinatorId: 'test-coordinator', ...extra,
  });
  const submit = (thread = 'thread') => store().submit({ projectId: project, threadId: thread, receiptId: `receipt-${randomUUID()}`, message: 'Take one useful bounded step.' });
  const expireClaim = async id => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("UPDATE vnext_work_units SET claim_expires_at='2000-01-01T00:00:00Z' WHERE work_unit_id=$1", [id]);
      await client.query("UPDATE vnext_executions SET claim_expires_at='2000-01-01T00:00:00Z' WHERE work_unit_id=$1 AND state IN ('created','running')", [id]);
      await client.query("UPDATE vnext_project_mutation_authority SET claim_expires_at='2000-01-01T00:00:00Z' WHERE work_unit_id=$1", [id]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally { client.release(); }
  };

  try {
    await pool.query("DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF; IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anonymous') THEN CREATE ROLE anonymous; END IF; END $$");
    await migrateVNext({ pool, directory: path.join(import.meta.dirname, '../vnext-migrations') });

    await t.test('a review without a completion claim requires inspection, not acceptance', () => {
      const status = deriveCoordinatorStatus({
        project_id: 'review-only',
        works: [{
          work_unit_id: 'review-work', objective_ref: 'review-objective', work_revision: 1,
          state: 'review', claim_execution_id: null, last_execution_id: 'review-exec',
          latest_input_seq: 1, consumed_input_seq: 1, retry_after: null,
          continuation: null, last_turn: null, failure: { reason: 'attempts-exhausted' },
        }],
        executions: [{
          execution_id: 'review-exec', work_unit_id: 'review-work', state: 'succeeded',
          fence: 1, attempt: 1, started_at: '2026-01-01T00:00:00Z', finished_at: '2026-01-01T00:00:01Z',
        }],
        results: [{ execution_id: 'review-exec', recorded_at: '2026-01-01T00:00:01Z', turn: { disposition: 'failed', summary: 'Did not finish.' } }],
        accepted: [], evidence: [], cancellations: [], continuations: [],
        block: null, authority: null, eligible_id: null,
      }, { now: Date.parse('2026-01-01T00:00:02Z') });
      assert.equal(status.next_action.kind, 'wait');
      assert.equal(status.next_action.reason, 'review-required');
      assert.deepEqual(status.pending_decisions.map(decision => decision.kind), ['inspect']);
      assert.equal(status.objectives[0].completion_claim, null);
    });

    await t.test('a pass dispatches, records durable status, and a later pass records accepted completion', async () => {
      const { work_unit_id: id } = await submit();
      const first = await run(store(), async ({ workUnit }) => next(workUnit.objective_ref));
      assert.equal(first.status, 'dispatched');
      assert.equal(first.dispatch.disposition, 'continue');
      assert.equal(first.status_view.objectives[0].completed_attempts.length, 1);
      assert.equal(first.status_view.next_action.kind, 'wait');
      assert.equal(first.status_view.next_action.reason, 'continuation-not-due');
      const passEvents = await pool.query("SELECT payload FROM vnext_events WHERE event_type='coordinator.pass' AND payload->>'project_id'=$1", [project]);
      assert.equal(passEvents.rowCount, 1);
      assert.equal(passEvents.rows[0].payload.status, 'dispatched');
      assert.equal(passEvents.rows[0].payload.project_id, project);

      await pool.query('UPDATE vnext_pilot_progress SET next_wake_at=clock_timestamp() WHERE work_unit_id=$1', [id]);
      const second = await run(store(), async ({ workUnit }) => ({
        objective_id: workUnit.objective_ref,
        disposition: 'done',
        summary: 'Coordinator outcome checked.',
        outcome_evidence: [{ kind: 'file', path: 'proof.txt', sha256: proofHash }],
      }));
      assert.equal(second.status, 'accepted');
      const final = second.status_view;
      assert.equal(final.next_action.kind, 'none');
      assert.equal(final.objectives[0].state, 'terminal');
      assert.equal(final.objectives[0].accepted_completion.accepted, true);
      assert.equal(final.objectives[0].completion_claim.summary, 'Coordinator outcome checked.');
      assert.equal(final.objectives[0].latest_result.evidence.length, 1);
      assert.equal(await store().nextEligible(project), null);
    });

    await t.test('overlapping passes dispatch one attempt and expose the active claim', async () => {
      const overlap = `overlap-${randomUUID()}`;
      const overlapWorkspace = await makeWorkspace('coordinator-overlap-workspace');
      await store().submit({ projectId: overlap, threadId: 'overlap', receiptId: `receipt-${randomUUID()}`, message: 'Overlap.' });
      let entered;
      const started = new Promise(resolve => { entered = resolve; });
      let release;
      const blocked = new Promise(resolve => { release = resolve; });
      const pass = (executor, extra = {}) => runCoordinatorPass({ store: store(), projectId: overlap, workspaceRoot: overlapWorkspace, identityFiles: [identityFile], executor, authority, timeoutMs: 5000, coordinatorId: 'overlap-coordinator', ...extra });
      const firstPromise = pass(async ({ workUnit }) => { entered(); await blocked; return next(workUnit.objective_ref); });
      await started;
      const active = await store().coordinatorLedger(overlap).then(ledger => deriveCoordinatorStatus(ledger));
      assert.equal(active.next_action.kind, 'wait');
      assert.equal(active.next_action.reason, 'attempt-running');
      const second = await pass(async () => { throw new Error('overlapping pass must not execute'); });
      assert.equal(second.status, 'quiesced');
      assert.equal(second.dispatch, null);
      release();
      const first = await firstPromise;
      assert.equal(first.status, 'dispatched');
      const executions = await pool.query('SELECT count(*)::int AS count FROM vnext_executions e JOIN vnext_work_units w USING(work_unit_id) WHERE w.project_id=$1', [overlap]);
      assert.equal(executions.rows[0].count, 1);
    });

    await t.test('restart recovery surfaces uncertainty, blocks dispatch, and reconciliation reopens the ledger', async () => {
      const recoveryProject = `recovery-${randomUUID()}`;
      const recoveryWorkspace = await makeWorkspace('coordinator-recovery-workspace');
      const { work_unit_id: id } = await store().submit({ projectId: recoveryProject, threadId: 'recovery', receiptId: `receipt-${randomUUID()}`, message: 'Recovery.' });
      const work = await store().reconstruct({ work_unit_id: id });
      const executionId = `exec-${randomUUID()}`;
      const claimed = claimWorkUnit({ ...work, state: 'actionable' }, { executionId, owner: 'test-owner' });
      const execution = { ...startExecution(createExecution(claimed, { executionId, owner: 'test-owner' })), authorization_decision_ref: `coordinator:${executionId}` };
      const begun = await store().beginExecution(claimed, execution, { ref: execution.authorization_decision_ref });
      await store().recordLaunch(begun.workUnit, begun.execution, { pid: 999999, pgid: 999999, started_at: new Date().toISOString() });
      await expireClaim(id);
      let denied = false;
      const pass = await runCoordinatorPass({
        store: store(), projectId: recoveryProject, workspaceRoot: recoveryWorkspace, identityFiles: [identityFile],
        executor: async () => { denied = true; return next(work.objective_ref); }, authority, timeoutMs: 5000, coordinatorId: 'recovery-coordinator',
        recovery: { stateDirectory: path.join(dir, 'attempts'), probe: async () => 'gone', groupProbe: async () => 'gone', kill: async () => { throw new Error('kill was not expected'); } },
      });
      assert.equal(denied, false);
      assert.equal(pass.status, 'blocked');
      assert.equal(pass.recovered[0].action, 'reconciliation-required');
      assert.equal(pass.status_view.next_action.kind, 'reconcile');
      assert.equal(pass.status_view.objectives[0].uncertain_reason, 'external-effect-uncertain');
      const block = await store().coordinatorLedger(recoveryProject).then(ledger => ledger.block);
      const reconciled = await store().reconcileFailure({ projectId: recoveryProject, workUnitId: block.work_unit_id, executionId: block.execution_id, fence: Number(block.fence), resolution: 'no_effect', decisionRef: 'operator:reconcile:test' });
      assert.equal(reconciled.state, 'actionable');
      const after = await store().coordinatorLedger(recoveryProject).then(ledger => deriveCoordinatorStatus(ledger));
      assert.equal(after.next_action.kind, 'dispatch');
      assert.equal(after.objectives[0].blocked_reason, null);
      const event = await pool.query("SELECT payload FROM vnext_events WHERE event_id=$1", [`reconciliation:${block.execution_id}`]);
      assert.equal(event.rows[0].payload.decision_ref, 'operator:reconcile:test');
    });

    await t.test('pause is durable and the loop stops after the current pass', async () => {
      const pauseFile = path.join(dir, 'paused.json');
      await writePauseFile(pauseFile, { coordinatorId: 'test-coordinator' });
      const paused = await run(store(), async () => { throw new Error('paused pass must not execute'); }, { pauseFile });
      assert.equal(paused.status, 'paused');
      assert.equal(await removePauseFile(pauseFile), true);
      assert.equal(await removePauseFile(pauseFile), false);
      const controller = new AbortController();
      let passes = 0;
      const result = await runCoordinatorLoop({
        intervalMs: 100,
        signal: controller.signal,
        runPass: async () => { passes += 1; return { status: 'quiesced' }; },
        onPass: async () => { if (passes === 2) controller.abort(); },
        sleep: async () => {},
      });
      assert.equal(passes, 2);
      assert.equal(result.passes, 2);
      assert.equal(result.stopped, true);
      const finite = await runCoordinatorLoop({ intervalMs: 100, maxPasses: 3, runPass: async () => ({ status: 'quiesced' }), sleep: async () => {} });
      assert.equal(finite.passes, 3);
    });

    await t.test('a retry deadline is part of eligibility and status', async () => {
      const retryProject = `retry-${randomUUID()}`;
      const { work_unit_id: id } = await store().submit({ projectId: retryProject, threadId: 'retry', receiptId: `receipt-${randomUUID()}`, message: 'Retry deadline.' });
      const work = await store().reconstruct({ work_unit_id: id });
      const executionId = `exec-${randomUUID()}`;
      const claimed = claimWorkUnit({ ...work, state: 'actionable' }, { executionId, owner: 'test-owner' });
      const execution = { ...startExecution(createExecution(claimed, { executionId, owner: 'test-owner' })), authorization_decision_ref: `coordinator:${executionId}` };
      const begun = await store().beginExecution(claimed, execution, { ref: execution.authorization_decision_ref });
      await store().persistFailure(failExecution(begun.workUnit, begun.execution, { retryAfter: new Date(Date.now() + 60000).toISOString() }));
      assert.equal(await store().nextEligible(retryProject), null);
      const status = await store().coordinatorLedger(retryProject).then(ledger => deriveCoordinatorStatus(ledger));
      assert.equal(status.next_action.reason, 'retry-not-due');
      await pool.query("UPDATE vnext_work_units SET retry_after='2000-01-01T00:00:00Z' WHERE work_unit_id=$1", [id]);
      assert.equal(await store().nextEligible(retryProject), id);
    });

    await t.test('cancelled work is removable from the coordinator next action', async () => {
      const cancelProject = `cancel-${randomUUID()}`;
      const cancelWorkspace = await makeWorkspace('coordinator-cancel-workspace');
      const { work_unit_id: id } = await store().submit({ projectId: cancelProject, threadId: 'cancel', receiptId: `receipt-${randomUUID()}`, message: 'Cancel.' });
      const cancellation = await store().recordCancellation({ projectId: cancelProject, workUnitId: id, expectedRevision: 1, decision: { ref: `cancel:${randomUUID()}` } });
      assert.equal(cancellation.state, 'cancelled');
      let ran = false;
      const pass = await runCoordinatorPass({ store: store(), projectId: cancelProject, workspaceRoot: cancelWorkspace, identityFiles: [identityFile], executor: async () => { ran = true; }, authority, timeoutMs: 5000 });
      assert.equal(ran, false);
      assert.equal(pass.status, 'quiesced');
      assert.equal(pass.status_view.next_action.kind, 'none');
      assert.equal(pass.status_view.next_action.reason, 'cancelled');
    });
  } finally {
    await pool.end();
    await Promise.all(additionalWorkspaces.map(workspaceRoot => rm(workspaceRoot, { recursive: true, force: true })));
    await rm(dir, { recursive: true, force: true });
  }
});
