import test from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { migrateVNext } from '../lib/vnext/migration.mjs';
import { claimWorkUnit, createExecution, createWorkUnit, startExecution, applyTurn } from '../lib/vnext/kernel.mjs';
import { createNeonStore } from '../lib/vnext/neon-store.mjs';

const connectionString = process.env.TEST_DATABASE_URL;

async function cleanup(pool, workUnitIds, projectId) {
  await pool.query('DELETE FROM vnext_project_mutation_authority WHERE project_id=$1', [projectId]).catch(() => {});
  for (const workUnitId of workUnitIds) {
    await pool.query('DELETE FROM vnext_evidence_refs WHERE work_unit_id=$1', [workUnitId]).catch(() => {});
    await pool.query('DELETE FROM vnext_continuations WHERE work_unit_id=$1', [workUnitId]).catch(() => {});
    await pool.query('DELETE FROM vnext_executions WHERE work_unit_id=$1', [workUnitId]).catch(() => {});
    await pool.query('DELETE FROM vnext_work_units WHERE work_unit_id=$1', [workUnitId]).catch(() => {});
  }
}

test('Neon grants one mutation authority across different Work Units in one project and releases it on settlement', { skip: !connectionString, timeout: 60000 }, async () => {
  const pool = new Pool({ connectionString, max: 8 });
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  const projectId = `project-authority-${suffix}`;
  const firstWork = createWorkUnit({ workUnitId: `wu-authority-a-${suffix}`, objectiveRef: `objective-a-${suffix}`, projectId });
  const secondWork = createWorkUnit({ workUnitId: `wu-authority-b-${suffix}`, objectiveRef: `objective-b-${suffix}`, projectId });
  const store = createNeonStore({ pool });
  try {
    await migrateVNext({ pool, directory: path.join(import.meta.dirname, '..', 'vnext-migrations') });
    await store.createWorkUnit(firstWork);
    await store.createWorkUnit(secondWork);

    const firstClaim = claimWorkUnit(firstWork, { executionId: `exec-a-${suffix}`, owner: 'owner-a' });
    const firstExecution = startExecution(createExecution(firstClaim, { executionId: firstClaim.claim.execution_id, owner: 'owner-a' }));
    await store.beginExecution(firstClaim, firstExecution);

    const secondClaim = claimWorkUnit(secondWork, { executionId: `exec-b-${suffix}`, owner: 'owner-b' });
    const secondExecution = startExecution(createExecution(secondClaim, { executionId: secondClaim.claim.execution_id, owner: 'owner-b' }));
    await assert.rejects(() => store.beginExecution(secondClaim, secondExecution), /project mutation authority is already held/);

    const settled = applyTurn(firstClaim, firstExecution, { disposition: 'waiting', continuation: { mode: 'condition', condition: { kind: 'external', condition: 'next input' } } });
    await store.persistTurn(settled);

    await store.beginExecution(secondClaim, secondExecution);
    const authority = (await pool.query('SELECT project_id,work_unit_id,execution_id,fence FROM vnext_project_mutation_authority WHERE project_id=$1', [projectId])).rows[0];
    assert.deepEqual(authority, { project_id: projectId, work_unit_id: secondWork.work_unit_id, execution_id: secondExecution.execution_id, fence: '1' });
  } finally {
    await cleanup(pool, [firstWork.work_unit_id, secondWork.work_unit_id], projectId);
    await pool.end();
  }
});
