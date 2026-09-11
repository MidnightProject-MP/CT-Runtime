import test from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { migrateVNext } from '../lib/vnext/migration.mjs';
import { claimWorkUnit, createExecution, createWorkUnit, startExecution } from '../lib/vnext/kernel.mjs';
import { createNeonStore } from '../lib/vnext/neon-store.mjs';
import { runOuterLoop } from '../lib/vnext/outer-loop.mjs';

const connectionString = process.env.TEST_DATABASE_URL;

async function setup(pool, suffix) {
  await migrateVNext({ pool, directory: path.join(import.meta.dirname, '..', 'vnext-migrations') });
  const workUnitId = `wu-neon-${suffix}`;
  await createNeonStore({ pool }).createWorkUnit(createWorkUnit({ workUnitId, objectiveRef: `objective-neon-${suffix}` }));
  return workUnitId;
}

async function cleanup(pool, workUnitId) {
  await pool.query('DELETE FROM vnext_settlement_attempts WHERE work_unit_id=$1', [workUnitId]).catch(() => {});
  await pool.query('DELETE FROM vnext_evidence_refs WHERE work_unit_id=$1', [workUnitId]).catch(() => {});
  await pool.query('DELETE FROM vnext_continuations WHERE work_unit_id=$1', [workUnitId]).catch(() => {});
  await pool.query('DELETE FROM vnext_executions WHERE work_unit_id=$1', [workUnitId]).catch(() => {});
  await pool.query('DELETE FROM vnext_work_units WHERE work_unit_id=$1', [workUnitId]).catch(() => {});
}

async function cleanupEvent(pool, eventId) {
  await pool.query('DELETE FROM vnext_events WHERE event_id=$1', [eventId]).catch(() => {});
}

test('vNext survives disposable executions through durable Neon state', { skip: !connectionString, timeout: 60000 }, async () => {
  const pool = new Pool({ connectionString, max: 5 });
  const store = createNeonStore({ pool });
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  const workUnitId = `wu-neon-${suffix}`;
  const objectiveRef = `objective-neon-${suffix}`;

  try {
    await migrateVNext({ pool, directory: path.join(import.meta.dirname, '..', 'vnext-migrations') });
    await store.createWorkUnit(createWorkUnit({ workUnitId, objectiveRef }));

    const executions = [];
    const first = await runOuterLoop({
      wake: { type: 'feedback.received', event_id: `feedback-${suffix}`, work_unit_id: workUnitId },
      store,
      executor: async ({ execution }) => {
        executions.push(execution.execution_id);
        return {
          objective_id: objectiveRef,
          disposition: 'waiting',
          summary: 'Durable state now waits for an external change.',
          continuation: { mode: 'condition', condition: { kind: 'external', condition: 'A new result is available.' } },
        };
      },
    });
    assert.equal(first.disposition, 'waiting');

    const persisted = await store.reconstruct({ work_unit_id: workUnitId });
    assert.equal(persisted.state, 'waiting');
    assert.equal(persisted.claim, null);
    assert.equal(persisted.fence, 1);

    const second = await runOuterLoop({
      wake: { type: 'external.changed', event_id: `external-${suffix}`, work_unit_id: workUnitId },
      store,
      isJustified: async ({ workUnit }) => workUnit.state === 'waiting',
      executor: async ({ execution }) => {
        executions.push(execution.execution_id);
        return {
          objective_id: objectiveRef,
          disposition: 'done',
          summary: 'The persisted objective has reached its terminal outcome.',
          outcome_evidence: [{ kind: 'manifest', execution_id: executions[0] }],
        };
      },
      authorizeTerminal: () => true,
    });

    assert.equal(second.disposition, 'terminal');
    assert.equal(executions.length, 2);
    assert.notEqual(executions[0], executions[1]);

    const finalWork = await store.reconstruct({ work_unit_id: workUnitId });
    assert.equal(finalWork.state, 'terminal');
    assert.equal(finalWork.claim, null);
    assert.equal(finalWork.fence, 2);
    assert.equal(finalWork.last_execution_id, executions[1]);

    const rows = await pool.query('SELECT execution_id,state,fence FROM vnext_executions WHERE work_unit_id=$1 ORDER BY fence', [workUnitId]);
    assert.deepEqual(rows.rows, [
      { execution_id: executions[0], state: 'succeeded', fence: '1' },
      { execution_id: executions[1], state: 'succeeded', fence: '2' },
    ]);
  } finally {
    await cleanup(pool, workUnitId);
    await pool.end();
  }
});

test('two concurrent wakes cannot both claim one Work Unit', { skip: !connectionString, timeout: 60000 }, async () => {
  const poolA = new Pool({ connectionString, max: 3 });
  const poolB = new Pool({ connectionString, max: 3 });
  const storeA = createNeonStore({ pool: poolA });
  const storeB = createNeonStore({ pool: poolB });
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  const workUnitId = await setup(poolA, suffix);
  const wake = { type: 'feedback.received', event_id: `concurrent-${suffix}`, work_unit_id: workUnitId };
  let executions = 0;
  let entered;
  let release;
  const executionEntered = new Promise((resolve) => { entered = resolve; });
  const executionRelease = new Promise((resolve) => { release = resolve; });

  try {
    const first = runOuterLoop({ wake, store: storeA, executor: async () => { executions += 1; entered(); await executionRelease; return { objective_id: `objective-neon-${suffix}`, disposition: 'continue', summary: 'one bounded turn', continuation: { mode: 'immediate', next_action: 'inspect again' } }; } });
    await executionEntered;
    const second = runOuterLoop({ wake: { ...wake, event_id: `concurrent-${suffix}-b` }, store: storeB, executor: async () => { throw new Error('must not execute'); } });
    await assert.rejects(second, /work unit is already claimed|Work Unit changed before execution could be claimed/);
    release();
    await first;
    assert.equal(executions, 1);
    const row = (await poolA.query('SELECT fence,claim_execution_id,state FROM vnext_work_units WHERE work_unit_id=$1', [workUnitId])).rows[0];
    assert.equal(row.fence, '1');
    assert.equal(row.claim_execution_id, null);
    assert.equal(row.state, 'actionable');
  } finally {
    await cleanup(poolA, workUnitId);
    await Promise.allSettled([poolA.end(), poolB.end()]);
  }
});

test('Neon rejects stale settlement and preserves a newer claim', { skip: !connectionString, timeout: 60000 }, async () => {
  const pool = new Pool({ connectionString, max: 5 });
  const store = createNeonStore({ pool });
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  const workUnitId = await setup(pool, `stale-${suffix}`);
  try {
    const original = await store.reconstruct({ work_unit_id: workUnitId });
    const claimed = claimWorkUnit(original, { executionId: `exec-stale-${suffix}`, owner: 'owner-a' });
    const execution = startExecution(createExecution(claimed, { executionId: claimed.claim.execution_id, owner: 'owner-a' }));
    const begun = await store.beginExecution(claimed, execution);
    await pool.query(`UPDATE vnext_work_units SET fence=fence+1,claim_execution_id=$2,claim_owner=$3,claim_fence=fence+1 WHERE work_unit_id=$1`, [workUnitId, `exec-new-${suffix}`, 'owner-b']);
    const staleResult = { workUnit: begun.workUnit, execution: { ...begun.execution, state: 'failed', finished_at: new Date().toISOString() }, turn: { disposition: 'continue', continuation: { mode: 'immediate' } } };
    await assert.rejects(() => store.persistFailure(staleResult), /fencing conflict/);
    const row = (await pool.query('SELECT fence,claim_execution_id,claim_owner,state FROM vnext_work_units WHERE work_unit_id=$1', [workUnitId])).rows[0];
    assert.equal(row.claim_execution_id, `exec-new-${suffix}`);
    assert.equal(row.claim_owner, 'owner-b');
    assert.equal(row.state, 'actionable');
  } finally {
    await cleanup(pool, workUnitId);
    await pool.end();
  }
});

test('Neon settlement rolls back all mutations when Work Unit transition fails', { skip: !connectionString, timeout: 60000 }, async () => {
  const pool = new Pool({ connectionString, max: 5 });
  const store = createNeonStore({ pool });
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  const workUnitId = await setup(pool, `rollback-${suffix}`);
  try {
    const original = await store.reconstruct({ work_unit_id: workUnitId });
    const claimed = claimWorkUnit(original, { executionId: `exec-rollback-${suffix}`, owner: 'owner-a' });
    const execution = startExecution(createExecution(claimed, { executionId: claimed.claim.execution_id, owner: 'owner-a' }));
    const begun = await store.beginExecution(claimed, execution);
    const invalid = {
      workUnit: { ...begun.workUnit, state: 'not-a-work-state' },
      execution: { ...begun.execution, state: 'succeeded', finished_at: new Date().toISOString() },
      turn: { disposition: 'continue', continuation: { mode: 'immediate' } },
    };
    await assert.rejects(() => store.persistTurn(invalid));
    const state = await pool.query(`SELECT w.state,w.claim_execution_id,e.state AS execution_state FROM vnext_work_units w JOIN vnext_executions e ON e.execution_id=$2 WHERE w.work_unit_id=$1`, [workUnitId, execution.execution_id]);
    assert.deepEqual(state.rows[0], { state: 'actionable', claim_execution_id: execution.execution_id, execution_state: 'running' });
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM vnext_continuations WHERE work_unit_id=$1', [workUnitId])).rows[0].count, 0);
  } finally {
    await cleanup(pool, workUnitId);
    await pool.end();
  }
});

test('Neon takes over an expired claim and fences out the dead execution', { skip: !connectionString, timeout: 60000 }, async () => {
  const pool = new Pool({ connectionString, max: 5 });
  const store = createNeonStore({ pool });
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  const workUnitId = await setup(pool, `expiry-${suffix}`);
  const eventId = `expiry-${suffix}`;
  try {
    const expired = new Date(Date.now() - 1000).toISOString();
    await pool.query('UPDATE vnext_work_units SET fence=1,claim_execution_id=$2,claim_owner=$3,claim_fence=1,claim_expires_at=$4 WHERE work_unit_id=$1', [workUnitId, `exec-dead-${suffix}`, 'dead-owner', expired]);
    await pool.query(`INSERT INTO vnext_executions(execution_id,work_unit_id,owner,fence,state,started_at,claim_expires_at,attempt) VALUES ($1,$2,$3,1,'running',clock_timestamp(),$4,1)`, [`exec-dead-${suffix}`, workUnitId, 'dead-owner', expired]);
    const result = await runOuterLoop({
      wake: { type: 'recovery.wake', event_id: eventId, work_unit_id: workUnitId },
      store,
      executor: async () => ({ objective_id: `objective-neon-expiry-${suffix}`, disposition: 'continue', summary: 'successor continued', continuation: { mode: 'immediate', next_action: 'inspect again' } }),
    });
    assert.equal(result.disposition, 'continue');
    const rows = await pool.query('SELECT execution_id,state,fence FROM vnext_executions WHERE work_unit_id=$1 ORDER BY fence', [workUnitId]);
    assert.deepEqual(rows.rows.map((item) => ({ ...item, fence: Number(item.fence) })), [
      { execution_id: `exec-dead-${suffix}`, state: 'expired', fence: 1 },
      { execution_id: result.execution_id, state: 'succeeded', fence: 2 },
    ]);
  } finally {
    await cleanup(pool, workUnitId);
    await cleanupEvent(pool, eventId);
    await pool.end();
  }
});

test('Neon consumes duplicate wakes once and rejects event identity collisions', { skip: !connectionString, timeout: 60000 }, async () => {
  const pool = new Pool({ connectionString, max: 5 });
  const store = createNeonStore({ pool });
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  const workUnitId = await setup(pool, `events-${suffix}`);
  const eventId = `event-${suffix}`;
  try {
    let calls = 0;
    const wake = { type: 'external.changed', event_id: eventId, work_unit_id: workUnitId };
    const executor = async () => { calls += 1; return { objective_id: `objective-neon-events-${suffix}`, disposition: 'continue', summary: 'one event', continuation: { mode: 'immediate', next_action: 'inspect again' } }; };
    await runOuterLoop({ wake, store, executor });
    assert.deepEqual(await runOuterLoop({ wake, store, executor }), { disposition: 'quiesced', reason: 'event-replayed' });
    await assert.rejects(() => store.appendEvent({ ...wake, type: 'different.type' }), /event identity conflict/);
    assert.equal(calls, 1);
  } finally {
    await cleanup(pool, workUnitId);
    await cleanupEvent(pool, eventId);
    await pool.end();
  }
});

test('Neon persists bounded failure retry state', { skip: !connectionString, timeout: 60000 }, async () => {
  const pool = new Pool({ connectionString, max: 5 });
  const store = createNeonStore({ pool });
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  const workUnitId = await setup(pool, `retry-${suffix}`);
  const events = [`retry-1-${suffix}`, `retry-2-${suffix}`];
  try {
    const failing = async () => { throw new Error('bounded failure'); };
    await assert.rejects(() => runOuterLoop({ wake: { type: 'retry.event', event_id: events[0], work_unit_id: workUnitId }, store, executor: failing, retryDelayMs: 1000, maxAttempts: 2 }), /bounded failure/);
    let current = (await pool.query('SELECT state,attempt,retry_after FROM vnext_work_units WHERE work_unit_id=$1', [workUnitId])).rows[0];
    assert.equal(current.state, 'waiting');
    assert.equal(current.attempt, 1);
    assert.deepEqual((await runOuterLoop({ wake: { type: 'retry.event', event_id: events[1], work_unit_id: workUnitId }, store, executor: failing, isJustified: async () => true })).reason, 'retry-not-due');
    await new Promise((resolve) => setTimeout(resolve, 1100));
    await assert.rejects(() => runOuterLoop({ wake: { type: 'retry.event', event_id: `retry-3-${suffix}`, work_unit_id: workUnitId }, store, executor: failing, isJustified: async () => true, retryDelayMs: 0, maxAttempts: 2 }), /bounded failure/);
    current = (await pool.query('SELECT state,attempt,retry_after FROM vnext_work_units WHERE work_unit_id=$1', [workUnitId])).rows[0];
    assert.equal(current.state, 'review');
    assert.equal(current.attempt, 2);
  } finally {
    await cleanup(pool, workUnitId);
    for (const eventId of events) await cleanupEvent(pool, eventId);
    await cleanupEvent(pool, `retry-3-${suffix}`);
    await pool.end();
  }
});

test('Neon keeps a received event discoverable when processing stops before execution', { skip: !connectionString, timeout: 60000 }, async () => {
  const pool = new Pool({ connectionString, max: 5 });
  const store = createNeonStore({ pool });
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  const eventId = `death-after-receipt-${suffix}`;
  try {
    const receipt = await store.appendEvent({ type: 'wake.received', event_id: eventId, payload: { bounded: true } });
    assert.equal(receipt.consumed, true);
    const discovered = await store.discoverUnprocessedEvents();
    assert.equal(discovered.some((event) => event.event_id === eventId && event.processing_status === 'received'), true);
  } finally {
    await cleanupEvent(pool, eventId);
    await pool.end();
  }
});

test('Neon readback is exact and preserves uncertainty when the database becomes unavailable', { skip: !connectionString, timeout: 60000 }, async () => {
  const pool = new Pool({ connectionString, max: 5 });
  const store = createNeonStore({ pool });
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  const workUnitId = await setup(pool, `readback-${suffix}`);
  const eventId = `readback-${suffix}`;
  try {
    const result = await runOuterLoop({
      wake: { type: 'readback.received', event_id: eventId, work_unit_id: workUnitId },
      store,
      executor: async () => ({ objective_id: `objective-neon-readback-${suffix}`, disposition: 'continue', summary: 'committed', continuation: { mode: 'immediate', next_action: 'inspect' } }),
    });
    assert.equal((await store.readbackSettlement({ workUnitId, executionId: result.execution_id, eventId, fence: 1 })).status, 'committed');
    await pool.end();
    assert.equal((await store.readbackSettlement({ workUnitId, executionId: result.execution_id, eventId, fence: 1 })).status, 'inconclusive');
  } finally {
    await cleanup(pool, workUnitId);
    await cleanupEvent(pool, eventId);
    await pool.end().catch(() => {});
  }
});
