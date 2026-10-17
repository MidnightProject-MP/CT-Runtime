import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { testPool } from './pilot-test-pool.mjs';
import { migrateVNext } from '../lib/vnext/migration.mjs';
import { createPilotStore } from '../lib/vnext/pilot-store.mjs';
import { createMemoryStore } from '../lib/vnext/memory-store.mjs';
import { runPilotOnce } from '../lib/vnext/pilot.mjs';
import { classifyAttempt } from '../lib/vnext/dispatch-recovery.mjs';
import { createCommandExecutor } from '../lib/vnext/command-executor.mjs';
import { probeRunIdentity } from '../lib/vnext/process-identity.mjs';
import { claimWorkUnit, createExecution, startExecution, createWorkUnit } from '../lib/vnext/kernel.mjs';

const next = objective_id => ({ objective_id, disposition: 'continue', summary: 'Checked increment.', continuation: { mode: 'immediate', next_action: 'Check again.' } });
const done = (objective_id, evidence) => ({ objective_id, disposition: 'done', summary: 'Checked outcome.', outcome_evidence: evidence });
const authorization = {
  authorizeExecution: async ({ execution }) => ({ ref: `test:${execution.execution_id}` }),
  verifyExecution: async (d, { execution }) => d.ref === `test:${execution.execution_id}` && execution.authorization_decision_ref === d.ref,
  authorizeTerminal: async () => false,
};
const identityFor = executionId => ({ pid: 999999999, pgid: 999999999, start_ticks: '1', boot_id: 'test-boot', started_at: new Date().toISOString() });
const pause = ms => new Promise(r => setTimeout(r, ms));

async function admit(store, id) {
  const work = await store.reconstruct({ work_unit_id: id });
  const executionId = `exec-${randomUUID()}`;
  const claimed = claimWorkUnit({ ...work, state: 'actionable' }, { executionId, owner: 'test-owner' });
  const execution = { ...startExecution(createExecution(claimed, { executionId, owner: 'test-owner' })), authorization_decision_ref: `test:${executionId}` };
  return store.beginExecution(claimed, execution, { ref: execution.authorization_decision_ref });
}

test('classification is a durable-records decision, never a timing guess', async () => {
  const launch = { pid: 10, pgid: 10, boot_id: 'boot', start_ticks: '77' };
  const none = { request: false, identity: false, result: false };
  assert.equal(await classifyAttempt({ execution: { launch: null }, artifacts: none, probe: async () => 'gone' }), 'not-launched');
  assert.equal(await classifyAttempt({ execution: { launch: null }, artifacts: { ...none, request: true }, probe: async () => 'gone' }), 'launch-unconfirmed');
  assert.equal(await classifyAttempt({ execution: { launch: null }, artifacts: { ...none, result: true }, probe: async () => 'gone' }), 'launch-unconfirmed');
  assert.equal(await classifyAttempt({ execution: { launch }, artifacts: none, probe: async () => 'live' }), 'running');
  assert.equal(await classifyAttempt({ execution: { launch }, artifacts: none, probe: async () => 'unavailable' }), 'unknown');
  assert.equal(await classifyAttempt({ execution: { launch }, artifacts: none, probe: async () => 'gone' }), 'exited-without-result');
  assert.equal(await classifyAttempt({ execution: { launch }, artifacts: { ...none, result: true }, probe: async () => 'gone' }), 'completed');
});

test('memory store: a never-launched attempt recovers exactly once and replays exactly', async () => {
  const work = { ...createWorkUnit({ workUnitId: 'rec-memory', objectiveRef: 'objective', projectId: 'rec-memory-project' }), pilot: { input_seq: 1, consumed_input_seq: 1, considered_proposal_id: 0, next_wake_at: new Date().toISOString() } };
  const store = createMemoryStore({ workUnits: [work], authorizationVerifier: authorization.verifyExecution });
  const past = new Date(Date.now() - 1000).toISOString();
  const executionId = `exec-${randomUUID()}`;
  const claimed = claimWorkUnit({ ...(await store.reconstruct({ work_unit_id: 'rec-memory' })), state: 'actionable' }, { executionId, owner: 'test-owner', claimExpiresAt: past });
  const execution = { ...startExecution(createExecution(claimed, { executionId, owner: 'test-owner' })), authorization_decision_ref: `test:${executionId}` };
  const begun = await store.beginExecution(claimed, execution, { ref: execution.authorization_decision_ref });
  // A launch record requires live authority; the expired attempt can no longer
  // acquire one, which is exactly what recovery consumes.
  await assert.rejects(store.recordLaunch(begun.workUnit, begun.execution, identityFor(executionId)), /authority expired/);
  const attempts = await store.listInDoubtAttempts('rec-memory-project');
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].execution.execution_id, executionId);
  const recovered = await store.recoverAttempt({ projectId: 'rec-memory-project', workUnitId: 'rec-memory', executionId, fence: 1, resolution: 'not-launched' });
  assert.equal(recovered.state, 'waiting');
  assert.equal(recovered.attempt, 1);
  const replay = await store.recoverAttempt({ projectId: 'rec-memory-project', workUnitId: 'rec-memory', executionId, fence: 1, resolution: 'not-launched' });
  assert.deepEqual(replay, recovered);
  await assert.rejects(store.recoverAttempt({ projectId: 'rec-memory-project', workUnitId: 'rec-memory', executionId, fence: 1, resolution: 'uncertain', reason: 'divergent' }), /content conflict/);
  assert.equal(store.snapshot().events.filter(e => e.event_id === `recovered:${executionId}`).length, 1);
  const after = await store.reconstruct({ work_unit_id: 'rec-memory' });
  assert.equal(after.claim, null);
  assert.equal(after.failure.reason, 'not-launched');
  assert.ok(after.pilot.next_wake_at, 'the retry is a coordinator-owned opportunity');
  assert.equal(store.snapshot().authorities.length, 0, 'recovery releases the expired authority');
  assert.equal(store.snapshot().reconciliationBlocks.length, 0);
});

test('recoverable dispatch: crash classification, retry, reconciliation and settlement from retained result', { timeout: 120000 }, async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'recoverable-dispatch-'));
  let pool = await testPool({ dataDir: path.join(dir, 'db') });
  await writeFile(path.join(dir, 'identity.md'), 'Recover, classify, settle from durable records only.');
  const store = (options = {}) => createPilotStore({ pool, intervalMs: 1000, authorizationVerifier: authorization.verifyExecution, acceptanceVerifier: async () => false, ...options });
  let seq = 0;
  const submit = async projectId => store().submit({ projectId, threadId: 'thread', receiptId: `receipt-${randomUUID()}`, message: `Input ${++seq}` });
  const attemptsDirectory = path.join(dir, 'attempts');
  const run = (s, projectId, executor, recovery = undefined) => runPilotOnce({ store: s, projectId, workspaceRoot: dir, identityFiles: [path.join(dir, 'identity.md')], authority: authorization, executor,
    ...(recovery ? { recovery: { stateDirectory: attemptsDirectory, ...recovery } } : {}) });
  // Claim expiry updates Work Unit, Execution and Authority together: a
  // deferred constraint trigger requires them to agree at COMMIT, so all three
  // move in one statement batch with one transaction timestamp.
  const expireClaim = async id => {
    if (!/^[A-Za-z0-9._:-]+$/.test(id)) throw new Error('unsafe test identifier');
    await pool.query(`UPDATE vnext_work_units SET claim_expires_at=now()-interval '1 second' WHERE work_unit_id='${id}';
      UPDATE vnext_executions SET claim_expires_at=now()-interval '1 second' WHERE work_unit_id='${id}' AND state IN ('created','running');
      UPDATE vnext_project_mutation_authority SET claim_expires_at=now()-interval '1 second' WHERE work_unit_id='${id}';`);
  };
  try {
    await pool.query("DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF; IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anonymous') THEN CREATE ROLE anonymous; END IF; END $$");
    await migrateVNext({ pool, directory: path.join(import.meta.dirname, '../vnext-migrations') });

    await t.test('a never-launched attempt is safely reclaimed on the next tick', async () => {
      const project = `dispatch-notlaunched-${randomUUID()}`;
      const { work_unit_id: id } = await submit(project);
      const begun = await admit(store(), id);
      await expireClaim(id);
      let executions = 0;
      const result = await run(store(), project, async ({ workUnit }) => { executions += 1; return next(workUnit.objective_ref); }, {});
      assert.equal(result.disposition, 'continue');
      assert.equal(result.recovered.length, 1);
      assert.equal(result.recovered[0].verdict, 'not-launched');
      assert.equal(result.recovered[0].action, 'retry-eligible');
      assert.equal(executions, 1, 'the reclaimed attempt runs and the settled one never re-enters');
      const rows = await pool.query("SELECT state,failure FROM vnext_executions WHERE work_unit_id=$1 ORDER BY started_at", [id]);
      assert.equal(rows.rows[0].state, 'failed');
      assert.equal(rows.rows[0].failure.reason, 'not-launched');
      assert.equal(rows.rows[0].failure.reconciliation_required, undefined);
      const cleared = await pool.query('SELECT 1 FROM vnext_project_mutation_authority WHERE project_id=$1', [project]);
      assert.equal(cleared.rowCount, 0);
      assert.equal(Number((await pool.query('SELECT count(*)::int AS c FROM vnext_events WHERE event_id=$1', [`recovered:${begun.execution.execution_id}`])).rows[0].c), 1);
    });

    await t.test('an unconfirmed launch is ambiguous, blocks, and resolves through reconciliation', async () => {
      const project = `dispatch-unconfirmed-${randomUUID()}`;
      const { work_unit_id: id } = await submit(project);
      const begun = await admit(store(), id);
      const attempt = path.join(attemptsDirectory, begun.execution.execution_id);
      await mkdir(attempt, { recursive: true });
      await writeFile(path.join(attempt, 'request.json'), '{}');
      await expireClaim(id);
      // Without recovery configured the attempt stays in doubt; it is never
      // silently reclaimed.
      const uninformed = await run(store(), project, async () => { throw new Error('must not execute'); });
      assert.equal(uninformed.disposition, 'blocked');
      assert.equal(uninformed.recovered, undefined);
      const result = await run(store(), project, async () => { throw new Error('must not execute'); }, {});
      assert.equal(result.disposition, 'blocked');
      assert.equal(result.recovered[0].verdict, 'launch-unconfirmed');
      assert.equal(result.recovered[0].action, 'reconciliation-required');
      const execRow = (await pool.query('SELECT state,failure FROM vnext_executions WHERE execution_id=$1', [begun.execution.execution_id])).rows[0];
      assert.equal(execRow.state, 'failed');
      assert.equal(execRow.failure.reconciliation_required, true);
      assert.equal(execRow.failure.reason, 'launch-was-not-confirmed');
      const block = (await pool.query('SELECT * FROM vnext_project_reconciliation_blocks WHERE project_id=$1', [project])).rows[0];
      assert.ok(block, 'uncertainty is durable before anything may run again');
      const reconciled = await store().reconcileFailure({ projectId: project, workUnitId: id, executionId: begun.execution.execution_id, fence: Number(block.fence), resolution: 'no_effect' });
      assert.equal(reconciled.state, 'actionable');
    });

    await t.test('a completed attempt settles from its retained result and evidence', async () => {
      const project = `dispatch-completed-${randomUUID()}`;
      const { work_unit_id: id } = await submit(project);
      const begun = await admit(store(), id);
      await store().recordLaunch(begun.workUnit, begun.execution, identityFor(begun.execution.execution_id));
      const attempt = path.join(attemptsDirectory, begun.execution.execution_id);
      await mkdir(attempt, { recursive: true });
      await writeFile(path.join(attempt, 'request.json'), JSON.stringify({ workspaceRoot: dir, wake: { workspace_root: dir } }));
      await writeFile(path.join(dir, 'proof.txt'), 'checked');
      const ref = { kind: 'file', path: 'proof.txt', sha256: createHash('sha256').update('checked').digest('hex') };
      await writeFile(path.join(attempt, 'result.json'), JSON.stringify(done(id, [ref])));
      await expireClaim(id);
      const result = await run(store(), project, async () => { throw new Error('must not execute'); }, { probe: async () => 'gone' });
      assert.equal(result.recovered[0].verdict, 'completed');
      assert.equal(result.recovered[0].action, 'settled-from-retained-result');
      const after = await store().reconstruct({ work_unit_id: id });
      assert.equal(after.state, 'review', 'a completion claim settles into review absent terminal authority');
      assert.equal(after.last_turn.summary, 'Checked outcome.');
      assert.equal(after.claim, null);
      assert.equal(Number((await pool.query('SELECT count(*)::int AS c FROM vnext_events WHERE event_id=$1', [`handoff:${begun.execution.execution_id}`])).rows[0].c), 1);
      const evidence = await pool.query('SELECT evidence FROM vnext_evidence_refs WHERE execution_id=$1', [begun.execution.execution_id]);
      assert.equal(evidence.rowCount, 1);
      // The retained bytes are the cited bytes.
      const retained = path.join(attempt, 'evidence', `0-${ref.sha256}`);
      assert.equal(await readFile(retained, 'utf8'), 'checked');
      // Recovery is idempotent: nothing in doubt remains and nothing changes.
      const again = await run(store(), project, async () => { throw new Error('must not execute'); }, { probe: async () => 'gone' });
      assert.equal(again.recovered, undefined);
    });

    await t.test('a worker that exited without a result is never treated as retryable', async () => {
      const project = `dispatch-noresult-${randomUUID()}`;
      const { work_unit_id: id } = await submit(project);
      const begun = await admit(store(), id);
      await store().recordLaunch(begun.workUnit, begun.execution, identityFor(begun.execution.execution_id));
      await expireClaim(id);
      const result = await run(store(), project, async () => { throw new Error('must not execute'); }, { probe: async () => 'gone' });
      assert.equal(result.disposition, 'blocked');
      assert.equal(result.recovered[0].verdict, 'exited-without-result');
      assert.equal(result.recovered[0].action, 'reconciliation-required');
      const execRow = (await pool.query('SELECT state,failure FROM vnext_executions WHERE execution_id=$1', [begun.execution.execution_id])).rows[0];
      assert.equal(execRow.failure.reason, 'worker-exited-without-result');
      assert.equal((await store().listInDoubtAttempts(project)).length, 0);
    });

    await t.test('a provably running attempt is stopped after claim expiry and settled conservatively', { skip: process.platform !== 'linux' }, async () => {
      const project = `dispatch-running-${randomUUID()}`;
      const { work_unit_id: id } = await submit(project);
      const begun = await admit(store(), id);
      let captured = null;
      const executor = createCommandExecutor({ command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'], stateDirectory: attemptsDirectory });
      const running = executor({ execution: { execution_id: begun.execution.execution_id }, workspaceRoot: dir, timeoutMs: 60000 }, {
        onSpawn: async identity => { captured = identity; await store().recordLaunch(begun.workUnit, begun.execution, identity); },
      }).catch(() => null);
      for (let i = 0; i < 100 && !captured; i += 1) await pause(50);
      assert.ok(captured, 'the launch identity is durable before the attempt can run long');
      assert.equal(await probeRunIdentity(captured), 'live');
      await expireClaim(id);
      const result = await run(store(), project, async () => { throw new Error('must not execute'); }, {});
      assert.equal(result.disposition, 'blocked');
      assert.equal(result.recovered[0].verdict, 'exited-without-result');
      assert.equal(await probeRunIdentity(captured), 'gone', 'the orphaned process group is confirmed stopped');
      await running;
      const execRow = (await pool.query('SELECT failure FROM vnext_executions WHERE execution_id=$1', [begun.execution.execution_id])).rows[0];
      assert.equal(execRow.failure.reconciliation_required, true);
    });
  } finally { await pool.end(); await rm(dir, { recursive: true, force: true }); }
});
