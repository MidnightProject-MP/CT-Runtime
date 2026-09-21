import test from 'node:test';
import { testAuthorizationVerifier } from './vnext-test-authorization.mjs';

const createNeonStore = (options = {}) => createNeonStoreCore({ ...options, authorizationVerifier: testAuthorizationVerifier });
const createExecution = (workUnit, options = {}) => createExecutionCore(workUnit, { ...options, authorizationDecisionRef: options.authorizationDecisionRef || `test-auth:${options.executionId}` });
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { migrateVNext } from '../lib/vnext/migration.mjs';
import { claimWorkUnit, createExecution as createExecutionCore, createWorkUnit, startExecution } from '../lib/vnext/kernel.mjs';
import { createNeonStore as createNeonStoreCore } from '../lib/vnext/neon-store.mjs';

const connectionString = process.env.TEST_DATABASE_URL;

async function cleanup(pool, workUnitId, projectId) {
  await pool.query('DELETE FROM vnext_project_mutation_authority WHERE project_id=$1', [projectId]).catch(() => {});
  await pool.query('DELETE FROM vnext_executions WHERE work_unit_id=$1', [workUnitId]).catch(() => {});
  await pool.query('DELETE FROM vnext_work_units WHERE work_unit_id=$1', [workUnitId]).catch(() => {});
}

async function assertCommitRejected(pool, statements) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const { sql, values = [] } of statements) {
      await client.query(sql, values);
    }
    await assert.rejects(
      () => client.query('COMMIT'),
      /project mutation authority must reference the Work Unit current active claim/,
    );
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
  }
}

test('PostgreSQL rejects authority owner and claim-expiry drift on Execution and Work Unit claims', { skip: !connectionString, timeout: 60000 }, async () => {
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

    await assertCommitRejected(pool, [{
      sql: 'UPDATE vnext_executions SET owner=$1 WHERE execution_id=$2',
      values: ['owner-b', executionId],
    }]);

    await assertCommitRejected(pool, [{
      sql: 'UPDATE vnext_work_units SET claim_owner=$1 WHERE work_unit_id=$2',
      values: ['owner-b', workUnitId],
    }]);

    await assertCommitRejected(pool, [{
      sql: 'UPDATE vnext_executions SET claim_expires_at=$1 WHERE execution_id=$2',
      values: [new Date(Date.now() + 120000).toISOString(), executionId],
    }]);

    await assertCommitRejected(pool, [{
      sql: 'UPDATE vnext_work_units SET claim_expires_at=$1 WHERE work_unit_id=$2',
      values: [new Date(Date.now() + 120000).toISOString(), workUnitId],
    }]);

    await assertCommitRejected(pool, [
      {
        sql: 'UPDATE vnext_executions SET owner=$1 WHERE execution_id=$2',
        values: ['owner-b', executionId],
      },
      {
        sql: 'UPDATE vnext_work_units SET claim_owner=$1 WHERE work_unit_id=$2',
        values: ['owner-b', workUnitId],
      },
    ]);

    const original = await store.reconstruct({ work_unit_id: workUnitId });
    const forgedExecution = { ...execution, claim_expires_at: '2099-09-17T12:00:00.000Z' };
    await assert.rejects(
      () => store.persistTurn({ workUnit: original, execution: forgedExecution, turn: { disposition: 'done' } }),
      /fencing conflict while persisting turn/,
    );

    const persisted = (await pool.query(
      'SELECT e.owner, e.claim_expires_at, w.claim_owner, w.claim_expires_at AS work_claim_expires_at FROM vnext_executions e JOIN vnext_work_units w USING (work_unit_id) WHERE e.execution_id=$1',
      [executionId],
    )).rows[0];
    assert.equal(persisted.owner, 'owner-a');
    assert.equal(persisted.claim_owner, 'owner-a');
    assert.equal(persisted.claim_expires_at.getTime(), persisted.work_claim_expires_at.getTime());
  } finally {
    await cleanup(pool, workUnitId, projectId);
    await pool.end();
  }
});
