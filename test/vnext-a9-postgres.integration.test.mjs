import test from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { migrateVNext } from '../lib/vnext/migration.mjs';
import { claimWorkUnit, createExecution, createWorkUnit, startExecution, applyTurn, failExecution } from '../lib/vnext/kernel.mjs';
import { createNeonStore } from '../lib/vnext/neon-store.mjs';

const connectionString = process.env.TEST_DATABASE_URL;

function verifier(decision, { execution }) {
  return decision?.ref === execution.authorization_decision_ref;
}

function authorize(execution) {
  return { ref: `test-auth:${execution.execution_id}` };
}

async function withInjectedFailure(pool, matcher, fn) {
  const originalConnect = pool.connect.bind(pool);
  let injected = false;
  const wrappedPool = {
    connect: async () => {
      const client = await originalConnect();
      const originalQuery = client.query.bind(client);
      client.query = async (...args) => {
        const sql = typeof args[0] === 'string' ? args[0] : args[0]?.text || '';
        if (!injected && matcher(sql)) {
          injected = true;
          throw new Error('A9 injected transaction failure');
        }
        return originalQuery(...args);
      };
      return client;
    },
  };
  return fn(wrappedPool);
}

async function setup(pool, suffix) {
  await migrateVNext({ pool, directory: path.join(import.meta.dirname, '..', 'vnext-migrations') });
  const store = createNeonStore({ pool, authorizationVerifier: verifier });
  const work = createWorkUnit({ workUnitId: `wu-a9-${suffix}`, objectiveRef: `objective-a9-${suffix}`, projectId: `project-a9-${suffix}` });
  await store.createWorkUnit(work);
  return { store, work };
}

async function cleanup(pool, workUnitId) {
  await pool.query('DELETE FROM vnext_project_mutation_authority WHERE work_unit_id=$1', [workUnitId]).catch(() => {});
  await pool.query('DELETE FROM vnext_evidence_refs WHERE work_unit_id=$1', [workUnitId]).catch(() => {});
  await pool.query('DELETE FROM vnext_continuations WHERE work_unit_id=$1', [workUnitId]).catch(() => {});
  await pool.query('DELETE FROM vnext_executions WHERE work_unit_id=$1', [workUnitId]).catch(() => {});
  await pool.query('DELETE FROM vnext_work_units WHERE work_unit_id=$1', [workUnitId]).catch(() => {});
}

test('A9 PostgreSQL acquisition rollback leaves no partial claim, Execution, or authority', { skip: !connectionString, timeout: 60000 }, async () => {
  const pool = new Pool({ connectionString, max: 5 });
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  let work;
  try {
    ({ work } = await setup(pool, `acquire-${suffix}`));
    const original = await createNeonStore({ pool, authorizationVerifier: verifier }).reconstruct({ work_unit_id: work.work_unit_id });
    const claimed = claimWorkUnit(original, { executionId: `exec-acquire-${suffix}`, owner: 'owner-a' });
    const execution = startExecution(createExecution(claimed, { executionId: claimed.claim.execution_id, owner: claimed.claim.owner, authorizationDecisionRef: `test-auth:${claimed.claim.execution_id}` }));
    await assert.rejects(() => withInjectedFailure(pool, sql => sql.includes("UPDATE vnext_work_units SET state='actionable'"), wrappedPool =>
      createNeonStore({ pool: wrappedPool, authorizationVerifier: verifier }).beginExecution(claimed, execution, authorize(execution))
    ), /A9 injected transaction failure/);
    const state = await pool.query('SELECT state,fence,claim_execution_id FROM vnext_work_units WHERE work_unit_id=$1', [work.work_unit_id]);
    assert.deepEqual(state.rows[0], { state: 'actionable', fence: '0', claim_execution_id: null });
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM vnext_executions WHERE work_unit_id=$1', [work.work_unit_id])).rows[0].count, 0);
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM vnext_project_mutation_authority WHERE work_unit_id=$1', [work.work_unit_id])).rows[0].count, 0);
  } finally {
    if (work) await cleanup(pool, work.work_unit_id);
    await pool.end();
  }
});

test('A9 PostgreSQL settlement rollback preserves running state and writes no continuation/evidence', { skip: !connectionString, timeout: 60000 }, async () => {
  const pool = new Pool({ connectionString, max: 5 });
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  let work;
  try {
    ({ work } = await setup(pool, `settle-${suffix}`));
    const store = createNeonStore({ pool, authorizationVerifier: verifier });
    const original = await store.reconstruct({ work_unit_id: work.work_unit_id });
    const claimed = claimWorkUnit(original, { executionId: `exec-settle-${suffix}`, owner: 'owner-a' });
    const execution = startExecution(createExecution(claimed, { executionId: claimed.claim.execution_id, owner: claimed.claim.owner, authorizationDecisionRef: `test-auth:${claimed.claim.execution_id}` }));
    const begun = await store.beginExecution(claimed, execution, authorize(execution));
    const result = applyTurn(begun.workUnit, begun.execution, { disposition: 'continue', summary: 'settlement', continuation: { mode: 'immediate', next_action: 'again' }, outcome_evidence: [{ kind: 'test' }] });
    await assert.rejects(() => withInjectedFailure(pool, sql => sql.startsWith('INSERT INTO vnext_continuations'), wrappedPool =>
      createNeonStore({ pool: wrappedPool, authorizationVerifier: verifier }).persistTurn(result)
    ), /A9 injected transaction failure/);
    const state = await pool.query('SELECT state,claim_execution_id,fence FROM vnext_work_units WHERE work_unit_id=$1', [work.work_unit_id]);
    assert.deepEqual(state.rows[0], { state: 'actionable', claim_execution_id: execution.execution_id, fence: '1' });
    assert.equal((await pool.query('SELECT state FROM vnext_executions WHERE execution_id=$1', [execution.execution_id])).rows[0].state, 'running');
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM vnext_continuations WHERE work_unit_id=$1', [work.work_unit_id])).rows[0].count, 0);
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM vnext_evidence_refs WHERE work_unit_id=$1', [work.work_unit_id])).rows[0].count, 0);
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM vnext_project_mutation_authority WHERE work_unit_id=$1', [work.work_unit_id])).rows[0].count, 1);
  } finally {
    if (work) await cleanup(pool, work.work_unit_id);
    await pool.end();
  }
});

test('A9 PostgreSQL failure rollback preserves running state and authority', { skip: !connectionString, timeout: 60000 }, async () => {
  const pool = new Pool({ connectionString, max: 5 });
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  let work;
  try {
    ({ work } = await setup(pool, `failure-${suffix}`));
    const store = createNeonStore({ pool, authorizationVerifier: verifier });
    const original = await store.reconstruct({ work_unit_id: work.work_unit_id });
    const claimed = claimWorkUnit(original, { executionId: `exec-failure-${suffix}`, owner: 'owner-a' });
    const execution = startExecution(createExecution(claimed, { executionId: claimed.claim.execution_id, owner: claimed.claim.owner, authorizationDecisionRef: `test-auth:${claimed.claim.execution_id}` }));
    const begun = await store.beginExecution(claimed, execution, authorize(execution));
    const failed = failExecution(begun.workUnit, begun.execution, { failure: { message: 'boom' }, retryAfter: new Date(Date.now() + 1000).toISOString() });
    await assert.rejects(() => withInjectedFailure(pool, sql => sql.startsWith('UPDATE vnext_work_units SET state=$2,fence=$3'), wrappedPool =>
      createNeonStore({ pool: wrappedPool, authorizationVerifier: verifier }).persistFailure(failed)
    ), /A9 injected transaction failure/);
    const state = await pool.query('SELECT state,claim_execution_id,fence FROM vnext_work_units WHERE work_unit_id=$1', [work.work_unit_id]);
    assert.deepEqual(state.rows[0], { state: 'actionable', claim_execution_id: execution.execution_id, fence: '1' });
    assert.equal((await pool.query('SELECT state FROM vnext_executions WHERE execution_id=$1', [execution.execution_id])).rows[0].state, 'running');
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM vnext_project_mutation_authority WHERE work_unit_id=$1', [work.work_unit_id])).rows[0].count, 1);
  } finally {
    if (work) await cleanup(pool, work.work_unit_id);
    await pool.end();
  }
});

test('A9 PostgreSQL takeover rollback restores the expired predecessor and commits no successor', { skip: !connectionString, timeout: 60000 }, async () => {
  const pool = new Pool({ connectionString, max: 5 });
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  let work;
  try {
    ({ work } = await setup(pool, `takeover-${suffix}`));
    const store = createNeonStore({ pool, authorizationVerifier: verifier });
    const original = await store.reconstruct({ work_unit_id: work.work_unit_id });
    const predecessorClaim = claimWorkUnit(original, { executionId: `exec-old-${suffix}`, owner: 'old-owner' });
    const predecessorExecution = startExecution(createExecution(predecessorClaim, { executionId: predecessorClaim.claim.execution_id, owner: predecessorClaim.claim.owner, authorizationDecisionRef: `test-auth:${predecessorClaim.claim.execution_id}` }));
    const begun = await store.beginExecution(predecessorClaim, predecessorExecution, authorize(predecessorExecution));
    const expired = new Date(Date.now() - 1000).toISOString();
    await pool.query('UPDATE vnext_project_mutation_authority SET claim_expires_at=$2 WHERE project_id=$1', [work.project_id, expired]);
    await pool.query('UPDATE vnext_executions SET claim_expires_at=$2 WHERE execution_id=$1', [predecessorExecution.execution_id, expired]);
    await pool.query('UPDATE vnext_work_units SET claim_expires_at=$2,claim_expires_at=$2 WHERE work_unit_id=$1', [work.work_unit_id, expired]).catch(async () => {
      await pool.query('UPDATE vnext_work_units SET claim_expires_at=$2 WHERE work_unit_id=$1', [work.work_unit_id, expired]);
    });
    const predecessorBefore = await pool.query('SELECT state,claim_execution_id,claim_owner,claim_fence,claim_expires_at,fence FROM vnext_work_units WHERE work_unit_id=$1', [work.work_unit_id]);
    const executionBefore = await pool.query('SELECT state,claim_expires_at,fence FROM vnext_executions WHERE execution_id=$1', [predecessorExecution.execution_id]);
    const authorityBefore = await pool.query('SELECT * FROM vnext_project_mutation_authority WHERE project_id=$1', [work.project_id]);

    const successorClaim = claimWorkUnit({ ...begun.workUnit, state: 'waiting', claim: null, claim_expires_at: null }, { executionId: `exec-new-${suffix}`, owner: 'new-owner' });
    const successorExecution = startExecution(createExecution(successorClaim, { executionId: successorClaim.claim.execution_id, owner: successorClaim.claim.owner, authorizationDecisionRef: `test-auth:${successorClaim.claim.execution_id}` }));
    await assert.rejects(() => withInjectedFailure(pool, sql => sql.startsWith("UPDATE vnext_work_units SET state='actionable'"), wrappedPool =>
      createNeonStore({ pool: wrappedPool, authorizationVerifier: verifier }).beginExecution(successorClaim, successorExecution, authorize(successorExecution))
    ), /A9 injected transaction failure/);

    assert.deepEqual((await pool.query('SELECT state,claim_execution_id,claim_owner,claim_fence,claim_expires_at,fence FROM vnext_work_units WHERE work_unit_id=$1', [work.work_unit_id])).rows, predecessorBefore.rows);
    assert.deepEqual((await pool.query('SELECT state,claim_expires_at,fence FROM vnext_executions WHERE execution_id=$1', [predecessorExecution.execution_id])).rows, executionBefore.rows);
    assert.deepEqual((await pool.query('SELECT * FROM vnext_project_mutation_authority WHERE project_id=$1', [work.project_id])).rows, authorityBefore.rows);
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM vnext_executions WHERE execution_id=$1', [successorExecution.execution_id])).rows[0].count, 0);
  } finally {
    if (work) await cleanup(pool, work.work_unit_id);
    await pool.end();
  }
});
