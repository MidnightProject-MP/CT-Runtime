import test from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { migrateVNext } from '../lib/vnext/migration.mjs';
import { claimWorkUnit, createExecution as createExecutionCore, createWorkUnit, startExecution, applyTurn, failExecution } from '../lib/vnext/kernel.mjs';
import { createNeonStore as createNeonStoreCore } from '../lib/vnext/neon-store.mjs';
import { testAuthorizationVerifier } from './vnext-test-authorization.mjs';

const connectionString = process.env.TEST_DATABASE_URL;
const createNeonStore = (options = {}) => createNeonStoreCore({ ...options, authorizationVerifier: testAuthorizationVerifier });
const createExecution = (workUnit, options = {}) => createExecutionCore(workUnit, { ...options, authorizationDecisionRef: options.authorizationDecisionRef || `test-auth:${options.executionId}` });

async function cleanup(pool, workUnitIds, projectIds) {
  for (const projectId of projectIds) {
    await pool.query('DELETE FROM vnext_concurrency_reservations WHERE project_id=$1', [projectId]).catch(() => {});
    await pool.query('DELETE FROM vnext_project_reconciliation_blocks WHERE project_id=$1', [projectId]).catch(() => {});
    await pool.query('DELETE FROM vnext_project_mutation_authority WHERE project_id=$1', [projectId]).catch(() => {});
  }
  for (const workUnitId of workUnitIds) {
    await pool.query('DELETE FROM vnext_evidence_refs WHERE work_unit_id=$1', [workUnitId]).catch(() => {});
    await pool.query('DELETE FROM vnext_continuations WHERE work_unit_id=$1', [workUnitId]).catch(() => {});
    await pool.query('DELETE FROM vnext_executions WHERE work_unit_id=$1', [workUnitId]).catch(() => {});
    await pool.query('DELETE FROM vnext_work_units WHERE work_unit_id=$1', [workUnitId]).catch(() => {});
  }
}

const reservationCount = async (pool, projectIds) => (await pool.query('SELECT count(*)::int AS count FROM vnext_concurrency_reservations WHERE project_id = ANY($1)', [projectIds])).rows[0].count;

async function expireClaim(pool, claim, execution) {
  const expired = '2000-01-01T00:00:00.000Z';
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('UPDATE vnext_project_mutation_authority SET claim_expires_at=$2 WHERE project_id=$1', [claim.project_id, expired]);
    await client.query('UPDATE vnext_executions SET claim_expires_at=$2 WHERE execution_id=$1', [execution.execution_id, expired]);
    await client.query('UPDATE vnext_work_units SET claim_expires_at=$2 WHERE work_unit_id=$1', [claim.work_unit_id, expired]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { client.release(); }
  return {
    claim: { ...claim, claim_expires_at: expired, claim: { ...claim.claim, claim_expires_at: expired } },
    execution: { ...execution, claim_expires_at: expired },
  };
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
          throw new Error('concurrency injected transaction failure');
        }
        return originalQuery(...args);
      };
      return client;
    },
  };
  return fn(wrappedPool);
}

function poolProjects(suffix, labels) {
  const projects = labels.map((label) => `project-pool-${label}-${suffix}`);
  const workUnits = labels.map((label, index) => createWorkUnit({ workUnitId: `wu-pool-${label}-${suffix}`, objectiveRef: `objective-pool-${label}-${suffix}`, projectId: projects[index] }));
  const claimants = workUnits.map((work, index) => {
    const claim = claimWorkUnit(work, { executionId: `exec-pool-${labels[index]}-${suffix}`, owner: `owner-${labels[index]}` });
    return { claim, execution: startExecution(createExecution(claim, { executionId: claim.claim.execution_id, owner: `owner-${labels[index]}` })) };
  });
  return { projects, workUnits, claimants };
}

test('Neon pool exhaustion refuses admission without durable trace', { skip: !connectionString, timeout: 60000 }, async () => {
  const pool = new Pool({ connectionString, max: 8 });
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  const { projects, workUnits, claimants } = poolProjects(suffix, ['exhaust-a', 'exhaust-b', 'exhaust-c']);
  const store = createNeonStore({ pool, maxConcurrency: 2 });
  try {
    await migrateVNext({ pool, directory: path.join(import.meta.dirname, '..', 'vnext-migrations') });
    await store.createWorkUnit(workUnits[0]);
    await store.createWorkUnit(workUnits[1]);
    await store.createWorkUnit(workUnits[2]);
    await store.beginExecution(claimants[0].claim, claimants[0].execution);
    await store.beginExecution(claimants[1].claim, claimants[1].execution);

    await assert.rejects(() => store.beginExecution(claimants[2].claim, claimants[2].execution), /E_CONCURRENCY_LIMIT|concurrency pool is exhausted/);

    assert.equal(await reservationCount(pool, projects), 2);
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM vnext_executions WHERE execution_id=$1', [claimants[2].execution.execution_id])).rows[0].count, 0);
    assert.deepEqual((await pool.query('SELECT state,fence,claim_execution_id FROM vnext_work_units WHERE work_unit_id=$1', [workUnits[2].work_unit_id])).rows[0], { state: 'actionable', fence: '0', claim_execution_id: null });
    const reservations = await store.listReservations();
    assert.equal(reservations.length, 2);
    assert.ok(reservations.every((row) => row.fence === 1 && /^\d{4}-/.test(row.reserved_at)));
  } finally {
    await cleanup(pool, workUnits.map((work) => work.work_unit_id), projects);
    await pool.end();
  }
});

test('Neon concurrent admission never exceeds the configured pool cap', { skip: !connectionString, timeout: 60000 }, async () => {
  const pool = new Pool({ connectionString, max: 8 });
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  const { projects, workUnits, claimants } = poolProjects(suffix, ['race-a', 'race-b', 'race-c']);
  const store = createNeonStore({ pool, maxConcurrency: 2 });
  try {
    await migrateVNext({ pool, directory: path.join(import.meta.dirname, '..', 'vnext-migrations') });
    for (const work of workUnits) await store.createWorkUnit(work);

    const results = await Promise.allSettled(claimants.map(({ claim, execution }) => store.beginExecution(claim, execution)));
    const fulfilled = results.filter((result) => result.status === 'fulfilled');
    const rejected = results.filter((result) => result.status === 'rejected');
    assert.equal(fulfilled.length, 2);
    assert.equal(rejected.length, 1);
    assert.match(rejected[0].reason.message, /E_CONCURRENCY_LIMIT/);

    const rows = (await pool.query('SELECT project_id FROM vnext_concurrency_reservations WHERE project_id = ANY($1)', [projects])).rows;
    assert.equal(rows.length, 2);
    const winners = claimants.map(({ claim }, index) => results[index].status === 'fulfilled' ? claim.project_id : null).filter(Boolean);
    assert.deepEqual(rows.map((row) => row.project_id).sort(), winners.sort());
  } finally {
    await cleanup(pool, workUnits.map((work) => work.work_unit_id), projects);
    await pool.end();
  }
});

test('Neon settlement releases the slot for the next project', { skip: !connectionString, timeout: 60000 }, async () => {
  const pool = new Pool({ connectionString, max: 8 });
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  const { projects, workUnits, claimants } = poolProjects(suffix, ['settle-a', 'settle-b']);
  const store = createNeonStore({ pool, maxConcurrency: 1 });
  try {
    await migrateVNext({ pool, directory: path.join(import.meta.dirname, '..', 'vnext-migrations') });
    await store.createWorkUnit(workUnits[0]);
    await store.createWorkUnit(workUnits[1]);
    const first = await store.beginExecution(claimants[0].claim, claimants[0].execution);
    await assert.rejects(() => store.beginExecution(claimants[1].claim, claimants[1].execution), /E_CONCURRENCY_LIMIT/);

    const settled = applyTurn(first.workUnit, first.execution, { objective_id: workUnits[0].objective_ref, summary: 'Waiting for next input.', disposition: 'waiting', continuation: { mode: 'condition', condition: { kind: 'external', condition: 'next input' } } });
    await store.persistTurn(settled);
    assert.equal(await reservationCount(pool, projects), 0);

    await store.beginExecution(claimants[1].claim, claimants[1].execution);
    const rows = (await pool.query('SELECT project_id,execution_id FROM vnext_concurrency_reservations WHERE project_id = ANY($1)', [projects])).rows;
    assert.deepEqual(rows, [{ project_id: claimants[1].claim.project_id, execution_id: claimants[1].execution.execution_id }]);
  } finally {
    await cleanup(pool, workUnits.map((work) => work.work_unit_id), projects);
    await pool.end();
  }
});

test('Neon failure and supersession release the slot', { skip: !connectionString, timeout: 60000 }, async () => {
  const pool = new Pool({ connectionString, max: 8 });
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  const { projects, workUnits, claimants } = poolProjects(suffix, ['exit-a', 'exit-b', 'exit-c']);
  const store = createNeonStore({ pool, maxConcurrency: 1 });
  try {
    await migrateVNext({ pool, directory: path.join(import.meta.dirname, '..', 'vnext-migrations') });
    for (const work of workUnits) await store.createWorkUnit(work);

    const first = await store.beginExecution(claimants[0].claim, claimants[0].execution);
    await assert.rejects(() => store.beginExecution(claimants[1].claim, claimants[1].execution), /E_CONCURRENCY_LIMIT/);
    await store.persistFailure(failExecution(first.workUnit, first.execution, { maxAttempts: 3, failure: { message: 'known-safe failure', no_external_effect: true } }));
    assert.equal(await reservationCount(pool, projects), 0);

    const second = await store.beginExecution(claimants[1].claim, claimants[1].execution);
    await store.reviseWorkRequirements(workUnits[1].work_unit_id, { expectedRevision: 1, requirements: { finish: 'revised while the attempt was stale' } });
    await store.persistSuperseded({ workUnit: structuredClone(claimants[1].claim), execution: { ...second.execution, state: 'running' } });
    assert.equal(await reservationCount(pool, projects), 0);

    await store.beginExecution(claimants[2].claim, claimants[2].execution);
    const replay = await store.persistSuperseded({ workUnit: structuredClone(claimants[1].claim), execution: { ...second.execution, state: 'running' } });
    assert.equal(replay.state, 'actionable');
    const rows = (await pool.query('SELECT project_id FROM vnext_concurrency_reservations WHERE project_id = ANY($1)', [projects])).rows;
    assert.deepEqual(rows, [{ project_id: claimants[2].claim.project_id }]);
  } finally {
    await cleanup(pool, workUnits.map((work) => work.work_unit_id), projects);
    await pool.end();
  }
});

test('Neon recovery releases the reservation held by a stop-unconfirmed attempt', { skip: !connectionString, timeout: 60000 }, async () => {
  const pool = new Pool({ connectionString, max: 8 });
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  const { projects, workUnits, claimants } = poolProjects(suffix, ['recovery-a', 'recovery-b']);
  const store = createNeonStore({ pool, maxConcurrency: 1 });
  try {
    await migrateVNext({ pool, directory: path.join(import.meta.dirname, '..', 'vnext-migrations') });
    await store.createWorkUnit(workUnits[0]);
    await store.createWorkUnit(workUnits[1]);
    await store.beginExecution(claimants[0].claim, claimants[0].execution);
    const expired = await expireClaim(pool, claimants[0].claim, claimants[0].execution);

    await assert.rejects(() => store.beginExecution(claimants[1].claim, claimants[1].execution), /E_CONCURRENCY_LIMIT/);
    await assert.rejects(() => store.beginExecution(expired.claim, expired.execution), /E_RECONCILIATION_REQUIRED/);
    assert.equal(await reservationCount(pool, projects), 1);

    const recovered = await store.recoverAttempt({ projectId: claimants[0].claim.project_id, workUnitId: workUnits[0].work_unit_id, executionId: claimants[0].execution.execution_id, fence: 1, resolution: 'not-launched' });
    assert.equal(recovered.state, 'waiting');
    assert.equal(await reservationCount(pool, projects), 0);

    await store.beginExecution(claimants[1].claim, claimants[1].execution);
    const rows = (await pool.query('SELECT project_id FROM vnext_concurrency_reservations WHERE project_id = ANY($1)', [projects])).rows;
    assert.deepEqual(rows, [{ project_id: claimants[1].claim.project_id }]);
  } finally {
    await cleanup(pool, workUnits.map((work) => work.work_unit_id), projects);
    await pool.end();
  }
});

test('Neon admission rollback after the reservation insert releases the slot atomically', { skip: !connectionString, timeout: 60000 }, async () => {
  const pool = new Pool({ connectionString, max: 8 });
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  const { projects, workUnits, claimants } = poolProjects(suffix, ['rollback-a', 'rollback-b']);
  const store = createNeonStore({ pool, maxConcurrency: 1 });
  try {
    await migrateVNext({ pool, directory: path.join(import.meta.dirname, '..', 'vnext-migrations') });
    await store.createWorkUnit(workUnits[0]);
    await store.createWorkUnit(workUnits[1]);

    await assert.rejects(() => withInjectedFailure(pool, sql => sql.startsWith('UPDATE vnext_work_units SET state=\'actionable\',fence=$2'), wrappedPool =>
      createNeonStore({ pool: wrappedPool, maxConcurrency: 1 }).beginExecution(claimants[0].claim, claimants[0].execution)
    ), /concurrency injected transaction failure/);

    assert.equal(await reservationCount(pool, projects), 0);
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM vnext_project_mutation_authority WHERE project_id=$1', [projects[0]])).rows[0].count, 0);
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM vnext_executions WHERE execution_id=$1', [claimants[0].execution.execution_id])).rows[0].count, 0);

    await store.beginExecution(claimants[1].claim, claimants[1].execution);
    assert.equal(await reservationCount(pool, projects), 1);
  } finally {
    await cleanup(pool, workUnits.map((work) => work.work_unit_id), projects);
    await pool.end();
  }
});

test('Neon rejects a forged reservation without its matching authority', { skip: !connectionString, timeout: 60000 }, async () => {
  const pool = new Pool({ connectionString, max: 8 });
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  const { projects, workUnits, claimants } = poolProjects(suffix, ['forge-a']);
  const store = createNeonStore({ pool });
  try {
    await migrateVNext({ pool, directory: path.join(import.meta.dirname, '..', 'vnext-migrations') });
    await store.createWorkUnit(workUnits[0]);
    const begun = await store.beginExecution(claimants[0].claim, claimants[0].execution);

    const forged = await pool.connect();
    try {
      await forged.query('BEGIN');
      await forged.query('UPDATE vnext_concurrency_reservations SET owner=$2 WHERE project_id=$1', [projects[0], 'forged-owner']);
      await assert.rejects(() => forged.query('COMMIT'), /matching project mutation authority/);
    } finally {
      await forged.query('ROLLBACK').catch(() => {});
      forged.release();
    }
    assert.deepEqual((await pool.query('SELECT owner FROM vnext_concurrency_reservations WHERE project_id=$1', [projects[0]])).rows, [{ owner: claimants[0].execution.owner }]);

    const settled = applyTurn(begun.workUnit, begun.execution, { objective_id: workUnits[0].objective_ref, summary: 'Waiting for next input.', disposition: 'waiting', continuation: { mode: 'condition', condition: { kind: 'external', condition: 'next input' } } });
    await store.persistTurn(settled);

    const orphan = await pool.connect();
    try {
      await orphan.query('BEGIN');
      await orphan.query('INSERT INTO vnext_concurrency_reservations(project_id,work_unit_id,execution_id,fence,owner) VALUES ($1,$2,$3,$4,$5)', [projects[0], workUnits[0].work_unit_id, claimants[0].execution.execution_id, 1, 'forged-owner']);
      await assert.rejects(() => orphan.query('COMMIT'), /matching project mutation authority/);
    } finally {
      await orphan.query('ROLLBACK').catch(() => {});
      orphan.release();
    }
    assert.equal(await reservationCount(pool, projects), 0);
  } finally {
    await cleanup(pool, workUnits.map((work) => work.work_unit_id), projects);
    await pool.end();
  }
});
