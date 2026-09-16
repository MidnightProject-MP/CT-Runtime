import test from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import path from 'node:path';
import { migrateVNext } from '../lib/vnext/migration.mjs';
import { claimWorkUnit, createExecution, createWorkUnit, startExecution } from '../lib/vnext/kernel.mjs';
import { createNeonStore } from '../lib/vnext/neon-store.mjs';

const connectionString = process.env.TEST_DATABASE_URL;

async function setup(pool, suffix) {
  await migrateVNext({ pool, directory: path.join(import.meta.dirname, '..', 'vnext-migrations') });
  const store = createNeonStore({ pool });
  const workUnit = createWorkUnit({ workUnitId: `wu-binding-${suffix}`, objectiveRef: `objective-binding-${suffix}` });
  await store.createWorkUnit(workUnit);
  return { store, workUnit };
}

async function cleanup(pool, workUnitIds) {
  for (const workUnitId of workUnitIds) {
    await pool.query('DELETE FROM vnext_evidence_refs WHERE work_unit_id=$1', [workUnitId]).catch(() => {});
    await pool.query('DELETE FROM vnext_continuations WHERE work_unit_id=$1', [workUnitId]).catch(() => {});
    await pool.query('DELETE FROM vnext_executions WHERE work_unit_id=$1', [workUnitId]).catch(() => {});
    await pool.query('DELETE FROM vnext_work_units WHERE work_unit_id=$1', [workUnitId]).catch(() => {});
  }
}

test('Neon rejects an execution forged onto another Work Unit at the persistence boundary', { skip: !connectionString, timeout: 60000 }, async () => {
  const pool = new Pool({ connectionString, max: 5 });
  const first = await setup(pool, `a-${Date.now()}`);
  const second = createWorkUnit({ workUnitId: `wu-binding-b-${Date.now()}`, objectiveRef: `objective-binding-b-${Date.now()}` });
  try {
    await first.store.createWorkUnit(second);
    const claimed = claimWorkUnit(first.workUnit, { executionId: `exec-binding-${Date.now()}`, owner: 'owner-a' });
    const execution = startExecution(createExecution(claimed, { executionId: claimed.claim.execution_id, owner: claimed.claim.owner }));
    const begun = await first.store.beginExecution(claimed, execution);
    const forged = { ...begun.execution, work_unit_id: second.work_unit_id };

    await assert.rejects(() => first.store.persistTurn({
      workUnit: second,
      execution: forged,
      turn: { disposition: 'continue', continuation: { mode: 'immediate' } },
    }), /different Work Unit/);

    await assert.rejects(() => first.store.persistFailure({
      workUnit: second,
      execution: { ...forged, state: 'failed' },
    }), /different Work Unit/);

    const row = (await pool.query('SELECT work_unit_id,state,fence FROM vnext_executions WHERE execution_id=$1', [execution.execution_id])).rows[0];
    assert.deepEqual(row, {
      work_unit_id: first.workUnit.work_unit_id,
      state: 'running',
      fence: '1',
    });
  } finally {
    await cleanup(pool, [first.workUnit.work_unit_id, second.work_unit_id]);
    await pool.end();
  }
});
