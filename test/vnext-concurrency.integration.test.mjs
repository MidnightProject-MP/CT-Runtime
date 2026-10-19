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
  await pool.query("DELETE FROM vnext_pool_policy WHERE policy='coordinator-concurrency'").catch(() => {});
  for (const projectId of projectIds) {
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

const authorityCount = async (pool, projectIds) => (await pool.query('SELECT count(*)::int AS count FROM vnext_project_mutation_authority WHERE project_id = ANY($1)', [projectIds])).rows[0].count;
const authorityProjects = async (pool, projectIds) => (await pool.query('SELECT project_id,execution_id FROM vnext_project_mutation_authority WHERE project_id = ANY($1) ORDER BY project_id', [projectIds])).rows;

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

    assert.equal(await authorityCount(pool, projects), 2);
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM vnext_executions WHERE execution_id=$1', [claimants[2].execution.execution_id])).rows[0].count, 0);
    assert.deepEqual((await pool.query('SELECT state,fence,claim_execution_id FROM vnext_work_units WHERE work_unit_id=$1', [workUnits[2].work_unit_id])).rows[0], { state: 'actionable', fence: '0', claim_execution_id: null });
    const reservations = await store.listReservations();
    assert.equal(reservations.length, 2);
    assert.ok(reservations.every((row) => row.fence === 1));
    assert.deepEqual(reservations, [
      { project_id: claimants[0].claim.project_id, work_unit_id: workUnits[0].work_unit_id, execution_id: claimants[0].execution.execution_id, fence: 1, owner: claimants[0].execution.owner },
      { project_id: claimants[1].claim.project_id, work_unit_id: workUnits[1].work_unit_id, execution_id: claimants[1].execution.execution_id, fence: 1, owner: claimants[1].execution.owner },
    ]);
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

    const rows = await authorityProjects(pool, projects);
    assert.equal(rows.length, 2);
    const winners = claimants.map(({ claim }, index) => results[index].status === 'fulfilled' ? claim.project_id : null).filter(Boolean);
    assert.deepEqual(rows.map((row) => row.project_id), winners.sort());
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
    assert.equal(await authorityCount(pool, projects), 0);

    await store.beginExecution(claimants[1].claim, claimants[1].execution);
    assert.deepEqual(await authorityProjects(pool, projects), [{ project_id: claimants[1].claim.project_id, execution_id: claimants[1].execution.execution_id }]);
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
    assert.equal(await authorityCount(pool, projects), 0);

    const second = await store.beginExecution(claimants[1].claim, claimants[1].execution);
    await store.reviseWorkRequirements(workUnits[1].work_unit_id, { expectedRevision: 1, requirements: { finish: 'revised while the attempt was stale' } });
    await store.persistSuperseded({ workUnit: structuredClone(claimants[1].claim), execution: { ...second.execution, state: 'running' } });
    assert.equal(await authorityCount(pool, projects), 0);

    await store.beginExecution(claimants[2].claim, claimants[2].execution);
    const replay = await store.persistSuperseded({ workUnit: structuredClone(claimants[1].claim), execution: { ...second.execution, state: 'running' } });
    assert.equal(replay.state, 'actionable');
    assert.deepEqual(await authorityProjects(pool, projects), [{ project_id: claimants[2].claim.project_id, execution_id: claimants[2].execution.execution_id }]);
  } finally {
    await cleanup(pool, workUnits.map((work) => work.work_unit_id), projects);
    await pool.end();
  }
});

test('Neon recovery releases the slot held by a stop-unconfirmed attempt', { skip: !connectionString, timeout: 60000 }, async () => {
  const pool = new Pool({ connectionString, max: 8 });
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  const { projects, workUnits, claimants } = poolProjects(suffix, ['recovery-a', 'recovery-b']);
  const store = createNeonStore({ pool, maxConcurrency: 1 });
  try {
    await migrateVNext({ pool, directory: path.join(import.meta.dirname, '..', 'vnext-migrations') });
    await store.createWorkUnit(workUnits[0]);
    await store.createWorkUnit(workUnits[1]);
    await store.beginExecution(claimants[0].claim, claimants[0].execution);
    await expireClaim(pool, claimants[0].claim, claimants[0].execution);

    const sameProjectWork = createWorkUnit({ workUnitId: `wu-pool-recovery-same-${suffix}`, objectiveRef: `objective-pool-recovery-same-${suffix}`, projectId: claimants[0].claim.project_id });
    await store.createWorkUnit(sameProjectWork);
    const sameProjectClaim = claimWorkUnit(sameProjectWork, { executionId: `exec-pool-recovery-same-${suffix}`, owner: 'owner-same' });
    const sameProjectExecution = startExecution(createExecution(sameProjectClaim, { executionId: sameProjectClaim.claim.execution_id, owner: 'owner-same' }));

    // The stop-confirmation refusal is reported before the pool refusal, and
    // the cross-project admission is refused by the pool the attempt holds.
    await assert.rejects(() => store.beginExecution(sameProjectClaim, sameProjectExecution), /E_RECONCILIATION_REQUIRED/);
    await assert.rejects(() => store.beginExecution(claimants[1].claim, claimants[1].execution), /E_CONCURRENCY_LIMIT/);
    assert.equal(await authorityCount(pool, projects), 1);

    const recovered = await store.recoverAttempt({ projectId: claimants[0].claim.project_id, workUnitId: workUnits[0].work_unit_id, executionId: claimants[0].execution.execution_id, fence: 1, resolution: 'not-launched' });
    assert.equal(recovered.state, 'waiting');
    assert.equal(await authorityCount(pool, projects), 0);

    await store.beginExecution(claimants[1].claim, claimants[1].execution);
    assert.deepEqual(await authorityProjects(pool, projects), [{ project_id: claimants[1].claim.project_id, execution_id: claimants[1].execution.execution_id }]);
  } finally {
    await cleanup(pool, [...workUnits.map((work) => work.work_unit_id), `wu-pool-recovery-same-${suffix}`], projects);
    await pool.end();
  }
});

test('Neon admission rollback after the authority insert releases the slot atomically', { skip: !connectionString, timeout: 60000 }, async () => {
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

    assert.equal(await authorityCount(pool, projects), 0);
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM vnext_executions WHERE execution_id=$1', [claimants[0].execution.execution_id])).rows[0].count, 0);

    await store.beginExecution(claimants[1].claim, claimants[1].execution);
    assert.equal(await authorityCount(pool, projects), 1);
  } finally {
    await cleanup(pool, workUnits.map((work) => work.work_unit_id), projects);
    await pool.end();
  }
});

test('Neon counts authorities that predate the configured pool', { skip: !connectionString, timeout: 60000 }, async () => {
  const pool = new Pool({ connectionString, max: 8 });
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  const { projects, workUnits, claimants } = poolProjects(suffix, ['upgrade-a', 'upgrade-b', 'upgrade-c']);
  const unbounded = createNeonStore({ pool });
  const store = createNeonStore({ pool, maxConcurrency: 2 });
  try {
    await migrateVNext({ pool, directory: path.join(import.meta.dirname, '..', 'vnext-migrations') });
    for (const work of workUnits) await store.createWorkUnit(work);

    // An active holder and an expired, stop-unconfirmed holder predate the
    // configured pool entirely (unbounded writer, as before the upgrade).
    await unbounded.beginExecution(claimants[0].claim, claimants[0].execution);
    await unbounded.beginExecution(claimants[1].claim, claimants[1].execution);
    await expireClaim(pool, claimants[1].claim, claimants[1].execution);

    // Configuring a bound later must count both existing holders; neither can
    // escape accounting by having been admitted before the pool existed.
    await assert.rejects(() => store.beginExecution(claimants[2].claim, claimants[2].execution), /E_CONCURRENCY_LIMIT/);
    assert.equal(await authorityCount(pool, projects), 2);

    await store.recoverAttempt({ projectId: claimants[1].claim.project_id, workUnitId: workUnits[1].work_unit_id, executionId: claimants[1].execution.execution_id, fence: 1, resolution: 'not-launched' });
    await store.beginExecution(claimants[2].claim, claimants[2].execution);
    assert.deepEqual(await authorityProjects(pool, projects), [
      { project_id: claimants[0].claim.project_id, execution_id: claimants[0].execution.execution_id },
      { project_id: claimants[2].claim.project_id, execution_id: claimants[2].execution.execution_id },
    ]);
  } finally {
    await cleanup(pool, workUnits.map((work) => work.work_unit_id), projects);
    await pool.end();
  }
});

test('Neon makes the durable pool policy bind every writer', { skip: !connectionString, timeout: 60000 }, async () => {
  const pool = new Pool({ connectionString, max: 8 });
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  const { projects, workUnits, claimants } = poolProjects(suffix, ['policy-a', 'policy-b', 'policy-c']);
  const configured = createNeonStore({ pool, maxConcurrency: 2 });
  const unconfigured = createNeonStore({ pool });
  const conflicting = createNeonStore({ pool, maxConcurrency: 3 });
  const matching = createNeonStore({ pool, maxConcurrency: 2 });
  try {
    await migrateVNext({ pool, directory: path.join(import.meta.dirname, '..', 'vnext-migrations') });
    for (const work of workUnits) await configured.createWorkUnit(work);

    await configured.beginExecution(claimants[0].claim, claimants[0].execution);
    assert.deepEqual((await pool.query("SELECT max_concurrency FROM vnext_pool_policy WHERE policy='coordinator-concurrency'")).rows, [{ max_concurrency: 2 }]);

    // An unconfigured writer adopts the durable policy: it may admit while the
    // pool has room, and cannot bypass the bound once the pool is full.
    await unconfigured.beginExecution(claimants[1].claim, claimants[1].execution);
    await assert.rejects(() => unconfigured.beginExecution(claimants[2].claim, claimants[2].execution), /E_CONCURRENCY_LIMIT/);

    // A writer configured with a different bound fails closed instead of
    // silently re-bounding a shared pool.
    await assert.rejects(() => conflicting.beginExecution(claimants[2].claim, claimants[2].execution), /E_POOL_POLICY_CONFLICT/);
    // A writer configured to match the durable policy operates normally.
    const matchingClaimant = claimants[2];
    await assert.rejects(() => matching.beginExecution(matchingClaimant.claim, matchingClaimant.execution), /E_CONCURRENCY_LIMIT/);

    // Removing the holder's authority releases its slot; nothing is left
    // behind to consume capacity.
    await pool.query('DELETE FROM vnext_project_mutation_authority WHERE project_id=$1', [claimants[0].claim.project_id]);
    assert.equal(await authorityCount(pool, projects), 1);
    await matching.beginExecution(matchingClaimant.claim, matchingClaimant.execution);
    assert.equal(await authorityCount(pool, projects), 2);

    // An explicit operator policy of unbounded conflicts with any configured
    // capacity rather than being silently overridden.
    await pool.query("UPDATE vnext_pool_policy SET max_concurrency=NULL WHERE policy='coordinator-concurrency'");
    await assert.rejects(() => configured.beginExecution(claimants[2].claim, claimants[2].execution), /E_POOL_POLICY_CONFLICT/);
  } finally {
    await cleanup(pool, workUnits.map((work) => work.work_unit_id), projects);
    await pool.end();
  }
});
