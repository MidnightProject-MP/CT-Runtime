import test from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { migrate } from '../lib/migration.mjs';
import { createWorkUnit } from '../lib/vnext/kernel.mjs';
import { createNeonStore } from '../lib/vnext/neon-store.mjs';
import { runOuterLoop } from '../lib/vnext/outer-loop.mjs';

const connectionString = process.env.TEST_DATABASE_URL;

async function setup(pool, suffix) {
  await migrate({ pool, directory: path.join(import.meta.dirname, '..', 'migrations') });
  const workUnitId = `wu-neon-${suffix}`;
  await createNeonStore({ pool }).saveWorkUnit(createWorkUnit({ workUnitId, objectiveRef: `objective-neon-${suffix}` }));
  return workUnitId;
}

async function cleanup(pool, workUnitId) {
  await pool.query('DELETE FROM vnext_evidence_refs WHERE work_unit_id=$1', [workUnitId]).catch(() => {});
  await pool.query('DELETE FROM vnext_continuations WHERE work_unit_id=$1', [workUnitId]).catch(() => {});
  await pool.query('DELETE FROM vnext_executions WHERE work_unit_id=$1', [workUnitId]).catch(() => {});
  await pool.query('DELETE FROM vnext_work_units WHERE work_unit_id=$1', [workUnitId]).catch(() => {});
}

test('vNext survives disposable executions through durable Neon state', { skip: !connectionString, timeout: 60000 }, async () => {
  const pool = new Pool({ connectionString, max: 5 });
  const store = createNeonStore({ pool });
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  const workUnitId = `wu-neon-${suffix}`;
  const objectiveRef = `objective-neon-${suffix}`;

  try {
    await migrate({ pool, directory: path.join(import.meta.dirname, '..', 'migrations') });
    await store.saveWorkUnit(createWorkUnit({ workUnitId, objectiveRef }));

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

  try {
    const results = await Promise.allSettled([
      runOuterLoop({ wake, store: storeA, executor: async () => { executions += 1; return { objective_id: `objective-neon-${suffix}`, disposition: 'continue', summary: 'one bounded turn', continuation: { mode: 'immediate', next_action: 'inspect again' } }; } }),
      runOuterLoop({ wake: { ...wake, event_id: `concurrent-${suffix}-b` }, store: storeB, executor: async () => { executions += 1; return { objective_id: `objective-neon-${suffix}`, disposition: 'continue', summary: 'one bounded turn', continuation: { mode: 'immediate', next_action: 'inspect again' } }; } }),
    ]);
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
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
