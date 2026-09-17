import test from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { migrateVNext } from '../lib/vnext/migration.mjs';
import { claimWorkUnit, createExecution, createWorkUnit, startExecution } from '../lib/vnext/kernel.mjs';
import { createNeonStore } from '../lib/vnext/neon-store.mjs';

const connectionString = process.env.TEST_DATABASE_URL;

async function cleanup(pool, workUnitId, projectId) {
  await pool.query('DELETE FROM vnext_project_mutation_authority WHERE project_id=$1', [projectId]).catch(() => {});
  await pool.query('DELETE FROM vnext_executions WHERE work_unit_id=$1', [workUnitId]).catch(() => {});
  await pool.query('DELETE FROM vnext_work_units WHERE work_unit_id=$1', [workUnitId]).catch(() => {});
}

async function assertCommitRejected(pool, sql, values) {
  await pool.query('BEGIN');
  try {
    await pool.query(sql, values);
    await assert.rejects(
      () => pool.query('COMMIT'),
      /project mutation authority must reference the Work Unit current active claim/,
    );
  } finally {
    await pool.query('ROLLBACK').catch(() => {});
  }
}

test('PostgreSQL rejects authority owner drift on Execution and Work Unit claims', { skip: !connectionString, timeout: 60000 }, async () => {
  const pool = new Pool({ connectionString, max: 4 });
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  const projectId = `project-owner-${suffix}`;
  const workUnitId = `wu-owner-${suffix}`;
  const executionId = `exec-owner-${suffix}`;
  const work = createWorkUnit({ workUnitId, objectiveRef: `objective-owner-${suffix}`, projectId });
  const store = createNeonStore({ pool });

  try {
    await migrateVNext({ pool, directory: path.join(import.meta.dirname, '..', 'vnext-migrations') });
    await store.createWorkUnit(work);
    const claim = claimWorkUnit(work, { executionId, owner: 'owner-a' });
    const execution = startExecution(createExecution(claim, { executionId, owner: 'owner-a' }));
    await store.beginExecution(claim, execution);

    await assertCommitRejected(
      pool,
      'UPDATE vnext_executions SET owner=$1 WHERE execution_id=$2',
      ['owner-b', executionId],
    );

    await assertCommitRejected(
      pool,
      'UPDATE vnext_work_units SET claim_owner=$1 WHERE work_unit_id=$2',
      ['owner-b', workUnitId],
    );

    await assertCommitRejected(
      pool,
      'UPDATE vnext_executions SET owner=$1 WHERE execution_id=$2',
      ['owner-b', executionId],
    );

    await assertCommitRejected(
      pool,
      'UPDATE vnext_work_units SET claim_owner=$1 WHERE work_unit_id=$2',
      ['owner-b', workUnitId],
    );

    const persisted = (await pool.query(
      'SELECT e.owner, w.claim_owner FROM vnext_executions e JOIN vnext_work_units w USING (work_unit_id) WHERE e.execution_id=$1',
      [executionId],
    )).rows[0];
    assert.deepEqual(persisted, { owner: 'owner-a', claim_owner: 'owner-a' });
  } finally {
    await cleanup(pool, workUnitId, projectId);
    await pool.end();
  }
});
