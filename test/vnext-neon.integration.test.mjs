import test from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { migrateVNext } from '../lib/vnext/migration.mjs';
import { claimWorkUnit, createExecution, createWorkUnit, startExecution } from '../lib/vnext/kernel.mjs';
import { createNeonStore } from '../lib/vnext/neon-store.mjs';

const connectionString = process.env.TEST_DATABASE_URL;

async function setup(pool, suffix) {
  await migrateVNext({ pool, directory: path.join(import.meta.dirname, '..', 'vnext-migrations') });
  const store = createNeonStore({ pool });
  const workUnit = createWorkUnit({ workUnitId: `wu-neon-${suffix}`, objectiveRef: `objective-neon-${suffix}`, projectId: `project-neon-${suffix}` });
  await store.createWorkUnit(workUnit);
  return workUnit.work_unit_id;
}

async function cleanup(pool, workUnitId) {
  await pool.query('DELETE FROM vnext_project_mutation_authority WHERE work_unit_id=$1', [workUnitId]).catch(() => {});
  await pool.query('DELETE FROM vnext_evidence_refs WHERE work_unit_id=$1', [workUnitId]).catch(() => {});
  await pool.query('DELETE FROM vnext_continuations WHERE work_unit_id=$1', [workUnitId]).catch(() => {});
  await pool.query('DELETE FROM vnext_executions WHERE work_unit_id=$1', [workUnitId]).catch(() => {});
  await pool.query('DELETE FROM vnext_work_units WHERE work_unit_id=$1', [workUnitId]).catch(() => {});
}

test('vNext survives disposable executions through durable Neon state', { skip: !connectionString, timeout: 60000 }, async () => {
  const pool = new Pool({ connectionString, max: 5 });
  const store = createNeonStore({ pool });
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  const workUnitId = await setup(pool, suffix);
  try {
    const original = await store.reconstruct({ work_unit_id: workUnitId });
    const claimed = claimWorkUnit(original, { executionId: `exec-neon-${suffix}`, owner: 'owner-a' });
    const execution = startExecution(createExecution(claimed, { executionId: claimed.claim.execution_id, owner: 'owner-a' }));
    const begun = await store.beginExecution(claimed, execution);
    await store.persistTurn({ workUnit: begun.workUnit, execution: begun.execution, turn: { disposition: 'waiting', continuation: { mode: 'condition', condition: 'external.changed' } } });
    const recovered = await store.reconstruct({ work_unit_id: workUnitId });
    assert.equal(recovered.state, 'waiting');
    assert.equal(recovered.last_execution_id, execution.execution_id);
  } finally {
    await cleanup(pool, workUnitId);
    await pool.end();
  }
});

test('two concurrent wakes cannot both claim one Work Unit', { skip: !connectionString, timeout: 60000 }, async () => {
  const poolA = new Pool({ connectionString, max: 5 });
  const poolB = new Pool({ connectionString, max: 5 });
  const storeA = createNeonStore({ pool: poolA });
  const storeB = createNeonStore({ pool: poolB });
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  const workUnitId = await setup(poolA, `concurrent-${suffix}`);
  try {
    const [a, b] = await Promise.all([
      storeA.reconstruct({ work_unit_id: workUnitId }),
      storeB.reconstruct({ work_unit_id: workUnitId }),
    ]);
    const claimA = claimWorkUnit(a, { executionId: `exec-a-${suffix}`, owner: 'owner-a' });
    const claimB = claimWorkUnit(b, { executionId: `exec-b-${suffix}`, owner: 'owner-b' });
    const executionA = startExecution(createExecution(claimA, { executionId: claimA.claim.execution_id, owner: 'owner-a' }));
    const executionB = startExecution(createExecution(claimB, { executionId: claimB.claim.execution_id, owner: 'owner-b' }));
    const results = await Promise.allSettled([
      storeA.beginExecution(claimA, executionA),
      storeB.beginExecution(claimB, executionB),
    ]);
    assert.equal(results.filter((item) => item.status === 'fulfilled').length, 1);
    assert.equal(results.filter((item) => item.status === 'rejected').length, 1);
    const executions = (await poolA.query('SELECT count(*)::int AS count FROM vnext_executions WHERE work_unit_id=$1', [workUnitId])).rows[0].count;
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

    const expired = new Date(Date.now() - 1000).toISOString();
    await pool.query('BEGIN');
    try {
      await pool.query('UPDATE vnext_project_mutation_authority SET claim_expires_at=$2 WHERE project_id=$1', [original.project_id, expired]);
      await pool.query('UPDATE vnext_executions SET claim_expires_at=$2 WHERE execution_id=$1', [execution.execution_id, expired]);
      await pool.query('UPDATE vnext_work_units SET claim_expires_at=$2 WHERE work_unit_id=$1', [workUnitId, expired]);
      await pool.query('COMMIT');
    } catch (error) {
      await pool.query('ROLLBACK').catch(() => {});
      throw error;
    }

    const successorSeed = { ...begun.workUnit, state: 'actionable', claim: null, claim_expires_at: null };
    const successor = claimWorkUnit(successorSeed, { executionId: `exec-new-${suffix}`, owner: 'owner-b' });
    const successorExecution = startExecution(createExecution(successor, { executionId: successor.claim.execution_id, owner: 'owner-b' }));
    await store.beginExecution(successor, successorExecution);

    const staleResult = { workUnit: begun.workUnit, execution: { ...begun.execution, state: 'failed', finished_at: new Date().toISOString() }, turn: { disposition: 'continue', continuation: { mode: 'immediate' } } };
    await assert.rejects(() => store.persistFailure(staleResult), /fencing conflict/);
    const row = (await pool.query('SELECT fence,claim_execution_id,claim_owner,state FROM vnext_work_units WHERE work_unit_id=$1', [workUnitId])).rows[0];
    assert.equal(row.fence, '2');
    assert.equal(row.claim_execution_id, `exec-new-${suffix}`);
    assert.equal(row.claim_owner, 'owner-b');
    assert.equal(row.state, 'actionable');
  } finally {
    await cleanup(pool, workUnitId);
    await pool.end();
  }
});
