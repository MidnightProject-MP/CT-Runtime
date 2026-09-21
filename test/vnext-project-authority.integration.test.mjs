import test from 'node:test';
import { testAuthorizationVerifier } from './vnext-test-authorization.mjs';

const createNeonStore = (options = {}) => createNeonStoreCore({ ...options, authorizationVerifier: testAuthorizationVerifier });
const createExecution = (workUnit, options = {}) => createExecutionCore(workUnit, { ...options, authorizationDecisionRef: options.authorizationDecisionRef || `test-auth:${options.executionId}` });
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { migrateVNext } from '../lib/vnext/migration.mjs';
import { claimWorkUnit, createExecution as createExecutionCore, createWorkUnit, startExecution, applyTurn, failExecution } from '../lib/vnext/kernel.mjs';
import { createNeonStore as createNeonStoreCore } from '../lib/vnext/neon-store.mjs';

const connectionString = process.env.TEST_DATABASE_URL;

async function cleanup(pool, workUnitIds, projectIds) {
  for (const projectId of projectIds) {
    await pool.query('DELETE FROM vnext_project_mutation_authority WHERE project_id=$1', [projectId]).catch(() => {});
  }
  for (const workUnitId of workUnitIds) {
    await pool.query('DELETE FROM vnext_evidence_refs WHERE work_unit_id=$1', [workUnitId]).catch(() => {});
    await pool.query('DELETE FROM vnext_continuations WHERE work_unit_id=$1', [workUnitId]).catch(() => {});
    await pool.query('DELETE FROM vnext_executions WHERE work_unit_id=$1', [workUnitId]).catch(() => {});
    await pool.query('DELETE FROM vnext_work_units WHERE work_unit_id=$1', [workUnitId]).catch(() => {});
  }
}

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
    await cleanup(pool, [firstWork.work_unit_id, secondWork.work_unit_id], [projectId]);
    await pool.end();
  }
});

test('Neon serializes simultaneous authority acquisition across different Work Units in one project', { skip: !connectionString, timeout: 60000 }, async () => {
  const pool = new Pool({ connectionString, max: 8 });
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  const projectId = `project-race-${suffix}`;
  const firstWork = createWorkUnit({ workUnitId: `wu-race-a-${suffix}`, objectiveRef: `objective-race-a-${suffix}`, projectId });
  const secondWork = createWorkUnit({ workUnitId: `wu-race-b-${suffix}`, objectiveRef: `objective-race-b-${suffix}`, projectId });
  const store = createNeonStore({ pool });
  try {
    await migrateVNext({ pool, directory: path.join(import.meta.dirname, '..', 'vnext-migrations') });
    await store.createWorkUnit(firstWork);
    await store.createWorkUnit(secondWork);

    const firstClaim = claimWorkUnit(firstWork, { executionId: `exec-race-a-${suffix}`, owner: 'owner-a' });
    const firstExecution = startExecution(createExecution(firstClaim, { executionId: firstClaim.claim.execution_id, owner: 'owner-a' }));
    const secondClaim = claimWorkUnit(secondWork, { executionId: `exec-race-b-${suffix}`, owner: 'owner-b' });
    const secondExecution = startExecution(createExecution(secondClaim, { executionId: secondClaim.claim.execution_id, owner: 'owner-b' }));

    const results = await Promise.allSettled([
      store.beginExecution(firstClaim, firstExecution),
      store.beginExecution(secondClaim, secondExecution),
    ]);
    const fulfilled = results.filter((result) => result.status === 'fulfilled');
    const rejected = results.filter((result) => result.status === 'rejected');
    assert.equal(fulfilled.length, 1);
    assert.equal(rejected.length, 1);
    assert.match(rejected[0].reason.message, /project mutation authority is already held/);

    const authorities = (await pool.query('SELECT project_id,work_unit_id,execution_id,fence FROM vnext_project_mutation_authority WHERE project_id=$1', [projectId])).rows;
    assert.equal(authorities.length, 1);
    assert.equal(authorities[0].project_id, projectId);
    assert.equal(authorities[0].fence, '1');
    assert.ok([firstWork.work_unit_id, secondWork.work_unit_id].includes(authorities[0].work_unit_id));
  } finally {
    await cleanup(pool, [firstWork.work_unit_id, secondWork.work_unit_id], [projectId]);
    await pool.end();
  }
});

test('Neon expires an old project authority before takeover by another Work Unit', { skip: !connectionString, timeout: 60000 }, async () => {
  const pool = new Pool({ connectionString, max: 8 });
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  const projectId = `project-expired-${suffix}`;
  const firstWork = createWorkUnit({ workUnitId: `wu-expired-a-${suffix}`, objectiveRef: `objective-expired-a-${suffix}`, projectId });
  const secondWork = createWorkUnit({ workUnitId: `wu-expired-b-${suffix}`, objectiveRef: `objective-expired-b-${suffix}`, projectId });
  const store = createNeonStore({ pool });
  try {
    await migrateVNext({ pool, directory: path.join(import.meta.dirname, '..', 'vnext-migrations') });
    await store.createWorkUnit(firstWork);
    await store.createWorkUnit(secondWork);

    const firstClaim = claimWorkUnit(firstWork, { executionId: `exec-expired-a-${suffix}`, owner: 'owner-a', now: new Date('2026-09-16T12:00:00.000Z'), claimExpiresAt: '2099-09-16T12:01:00.000Z' });
    const firstExecution = startExecution(createExecution(firstClaim, { executionId: firstClaim.claim.execution_id, owner: 'owner-a', startedAt: '2026-09-16T12:00:00.000Z' }));
    await store.beginExecution(firstClaim, firstExecution);
    await expireClaim(pool, firstClaim, firstExecution);

    const secondClaim = claimWorkUnit(secondWork, { executionId: `exec-expired-b-${suffix}`, owner: 'owner-b', now: new Date('2026-09-16T12:00:02.000Z'), claimExpiresAt: '2099-09-16T12:01:00.000Z' });
    const secondExecution = startExecution(createExecution(secondClaim, { executionId: secondClaim.claim.execution_id, owner: 'owner-b', startedAt: '2026-09-16T12:00:02.000Z' }));
    await store.beginExecution(secondClaim, secondExecution);

    const oldExecution = (await pool.query('SELECT state FROM vnext_executions WHERE execution_id=$1', [firstExecution.execution_id])).rows[0];
    const oldWork = (await pool.query('SELECT claim_execution_id,claim_fence,state FROM vnext_work_units WHERE work_unit_id=$1', [firstWork.work_unit_id])).rows[0];
    const authorities = (await pool.query('SELECT project_id,work_unit_id,execution_id,fence FROM vnext_project_mutation_authority WHERE project_id=$1', [projectId])).rows;
    assert.deepEqual(oldExecution, { state: 'expired' });
    assert.deepEqual(oldWork, { claim_execution_id: null, claim_fence: null, state: 'waiting' });
    assert.deepEqual(authorities, [{ project_id: projectId, work_unit_id: secondWork.work_unit_id, execution_id: secondExecution.execution_id, fence: '1' }]);
  } finally {
    await cleanup(pool, [firstWork.work_unit_id, secondWork.work_unit_id], [projectId]);
    await pool.end();
  }
});

test('Neon rejects settlement after project authority expiry without a takeover', { skip: !connectionString, timeout: 60000 }, async () => {
  const pool = new Pool({ connectionString, max: 8 });
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  const projectId = `project-expired-settlement-${suffix}`;
  const work = createWorkUnit({ workUnitId: `wu-expired-settlement-${suffix}`, objectiveRef: `objective-expired-settlement-${suffix}`, projectId });
  const store = createNeonStore({ pool });
  try {
    await migrateVNext({ pool, directory: path.join(import.meta.dirname, '..', 'vnext-migrations') });
    await store.createWorkUnit(work);

    const claim = claimWorkUnit(work, { executionId: `exec-expired-settlement-${suffix}`, owner: 'owner-a', now: new Date('2026-09-16T12:00:00.000Z'), claimExpiresAt: '2099-09-16T12:01:00.000Z' });
    const execution = startExecution(createExecution(claim, { executionId: claim.claim.execution_id, owner: 'owner-a', startedAt: '2026-09-16T12:00:00.000Z' }));
    await store.beginExecution(claim, execution);
    const expired = await expireClaim(pool, claim, execution);

    await assert.rejects(
      () => store.persistTurn(applyTurn(expired.claim, expired.execution, { disposition: 'done' })),
      /project mutation authority expired/,
    );

    const persisted = (await pool.query('SELECT state,claim_execution_id,claim_fence FROM vnext_work_units WHERE work_unit_id=$1', [work.work_unit_id])).rows[0];
    const authority = (await pool.query('SELECT project_id,execution_id,fence FROM vnext_project_mutation_authority WHERE project_id=$1', [projectId])).rows[0];
    assert.deepEqual(persisted, { state: 'actionable', claim_execution_id: execution.execution_id, claim_fence: '1' });
    assert.deepEqual(authority, { project_id: projectId, execution_id: execution.execution_id, fence: '1' });
  } finally {
    await cleanup(pool, [work.work_unit_id], [projectId]);
    await pool.end();
  }
});

test('Neon schema rejects an authority whose project, Work Unit, and Execution identities do not match', { skip: !connectionString, timeout: 60000 }, async () => {
  const pool = new Pool({ connectionString, max: 8 });
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  const firstProject = `project-schema-a-${suffix}`;
  const secondProject = `project-schema-b-${suffix}`;
  const forgedProject = `project-schema-forged-${suffix}`;
  const firstWork = createWorkUnit({ workUnitId: `wu-schema-a-${suffix}`, objectiveRef: `objective-schema-a-${suffix}`, projectId: firstProject });
  const secondWork = createWorkUnit({ workUnitId: `wu-schema-b-${suffix}`, objectiveRef: `objective-schema-b-${suffix}`, projectId: secondProject });
  const store = createNeonStore({ pool });
  try {
    await migrateVNext({ pool, directory: path.join(import.meta.dirname, '..', 'vnext-migrations') });
    await store.createWorkUnit(firstWork);
    await store.createWorkUnit(secondWork);

    const firstClaim = claimWorkUnit(firstWork, { executionId: `exec-schema-a-${suffix}`, owner: 'owner-a' });
    const firstExecution = startExecution(createExecution(firstClaim, { executionId: firstClaim.claim.execution_id, owner: 'owner-a' }));
    await store.beginExecution(firstClaim, firstExecution);
    await pool.query('DELETE FROM vnext_project_mutation_authority WHERE project_id=$1', [firstProject]);

    await assert.rejects(
      () => pool.query('INSERT INTO vnext_project_mutation_authority(project_id,work_unit_id,execution_id,fence,owner,claim_expires_at,authorization_decision_ref) VALUES ($1,$2,$3,$4,$5,$6,$7)', [forgedProject, secondWork.work_unit_id, firstExecution.execution_id, 1, firstExecution.owner, '2099-09-16T12:01:00Z', firstExecution.authorization_decision_ref]),
      /foreign key|violates/i,
    );

    await assert.rejects(
      () => pool.query('INSERT INTO vnext_project_mutation_authority(project_id,work_unit_id,execution_id,fence,owner,claim_expires_at) VALUES ($1,$2,$3,$4,$5,$6)', [firstProject, firstWork.work_unit_id, firstExecution.execution_id, 2, firstExecution.owner, '2099-09-16T12:01:00Z']),
      /foreign key|violates/i,
    );
  } finally {
    await cleanup(pool, [firstWork.work_unit_id, secondWork.work_unit_id], [firstProject, secondProject, forgedProject]);
    await pool.end();
  }
});


test('Neon acquisition rejects a consistently forged project and failure settlement releases authority', { skip: !connectionString, timeout: 60000 }, async () => {
  const pool = new Pool({ connectionString, max: 4 });
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  const projectId = `project-binding-${suffix}`;
  const first = createWorkUnit({ workUnitId: `binding-a-${suffix}`, objectiveRef: 'objective-a', projectId });
  const second = createWorkUnit({ workUnitId: `binding-b-${suffix}`, objectiveRef: 'objective-b', projectId });
  const store = createNeonStore({ pool });
  try {
    await migrateVNext({ pool });
    await store.createWorkUnit(first);
    await store.createWorkUnit(second);
    const active = claimWorkUnit(first, { executionId: `active-${suffix}`, owner: 'owner-a' });
    const execution = startExecution(createExecution(active, { executionId: active.claim.execution_id, owner: 'owner-a' }));
    await store.beginExecution(active, execution);
    const forged = claimWorkUnit({ ...second, project_id: `forged-${suffix}` }, { executionId: `forged-exec-${suffix}`, owner: 'owner-b' });
    const forgedExecution = startExecution(createExecution(forged, { executionId: forged.claim.execution_id, owner: 'owner-b' }));
    await assert.rejects(() => store.beginExecution(forged, forgedExecution), /different stored project/);
    assert.equal((await store.reconstruct({ work_unit_id: second.work_unit_id })).project_id, projectId);
    assert.equal((await store.reconstruct({ work_unit_id: second.work_unit_id })).fence, 0);
    assert.equal((await pool.query('SELECT * FROM vnext_executions WHERE execution_id=$1', [forgedExecution.execution_id])).rowCount, 0);
    assert.equal((await pool.query('SELECT execution_id FROM vnext_project_mutation_authority WHERE project_id=$1', [projectId])).rows[0].execution_id, execution.execution_id);
    await store.persistFailure(failExecution(active, execution));
    assert.equal((await pool.query('SELECT * FROM vnext_project_mutation_authority WHERE project_id=$1', [projectId])).rowCount, 0);
    const next = claimWorkUnit(second, { executionId: `next-${suffix}`, owner: 'owner-b' });
    await store.beginExecution(next, startExecution(createExecution(next, { executionId: next.claim.execution_id, owner: 'owner-b' })));
  } finally {
    await cleanup(pool, [first.work_unit_id, second.work_unit_id], [projectId]);
    await pool.end();
  }
});


test('Neon rejects continuation and evidence references that pair one Work Unit with another Execution', { skip: !connectionString, timeout: 60000 }, async () => {
  const pool = new Pool({ connectionString, max: 5 });
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  const projectA = `project-provenance-a-${suffix}`;
  const projectB = `project-provenance-b-${suffix}`;
  const first = createWorkUnit({ workUnitId: `wu-provenance-a-${suffix}`, objectiveRef: 'objective-a', projectId: projectA });
  const second = createWorkUnit({ workUnitId: `wu-provenance-b-${suffix}`, objectiveRef: 'objective-b', projectId: projectB });
  const store = createNeonStore({ pool });
  try {
    await migrateVNext({ pool });
    await store.createWorkUnit(first);
    await store.createWorkUnit(second);
    const claim = claimWorkUnit(first, { executionId: `exec-provenance-${suffix}`, owner: 'owner-a' });
    const execution = startExecution(createExecution(claim, { executionId: claim.claim.execution_id, owner: claim.claim.owner }));
    await store.beginExecution(claim, execution);

    await assert.rejects(
      () => pool.query('INSERT INTO vnext_continuations(work_unit_id,execution_id,continuation) VALUES ($1,$2,$3::jsonb)', [second.work_unit_id, execution.execution_id, JSON.stringify({ forged: true })]),
      /foreign key|violates/i,
    );
    await assert.rejects(
      () => pool.query('INSERT INTO vnext_evidence_refs(work_unit_id,execution_id,evidence) VALUES ($1,$2,$3::jsonb)', [second.work_unit_id, execution.execution_id, JSON.stringify({ forged: true })]),
      /foreign key|violates/i,
    );
  } finally {
    await cleanup(pool, [first.work_unit_id, second.work_unit_id], [projectA, projectB]);
    await pool.end();
  }
});

for (const settlement of ['turn', 'failure']) {
  test(`Neon cross-WU takeover does not deadlock with expired-holder ${settlement}`, { skip: !connectionString, timeout: 30000 }, async () => {
    const pool = new Pool({ connectionString, max: 6 });
    const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
    const projectId = `project-lock-${suffix}`;
    const first = createWorkUnit({ workUnitId: `lock-a-${suffix}`, objectiveRef: 'objective-a', projectId });
    const second = createWorkUnit({ workUnitId: `lock-b-${suffix}`, objectiveRef: 'objective-b', projectId });
    const store = createNeonStore({ pool });
    let releaseTakeover;
    const barrier = new Promise(resolve => { releaseTakeover = resolve; });
    let authorityLocked;
    const entered = new Promise(resolve => { authorityLocked = resolve; });
    let takeoverPid, settlementPid;
    let takeover, settle;
    const controlledPool = (role) => ({
      async connect() {
        const client = await pool.connect();
        const pid = (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
        if (role === 'takeover') takeoverPid = pid; else settlementPid = pid;
        return {
          async query(sql, values) {
            const result = await client.query(sql, values);
            if (sql === 'BEGIN') await client.query("SET LOCAL lock_timeout = '5s'");
            if (role === 'takeover' && sql.startsWith('SELECT * FROM vnext_project_mutation_authority')) {
              authorityLocked();
              await barrier;
            }
            return result;
          },
          release() { client.release(); },
        };
      },
    });
    try {
      await migrateVNext({ pool });
      await store.createWorkUnit(first);
      await store.createWorkUnit(second);
      const initial = claimWorkUnit(first, { executionId: `lock-old-${suffix}`, owner: 'owner-a' });
      const initialExecution = startExecution(createExecution(initial, { executionId: initial.claim.execution_id, owner: 'owner-a' }));
      await store.beginExecution(initial, initialExecution);
      const expired = await expireClaim(pool, initial, initialExecution);
      const successor = claimWorkUnit(second, { executionId: `lock-new-${suffix}`, owner: 'owner-b' });
      const nextExecution = startExecution(createExecution(successor, { executionId: successor.claim.execution_id, owner: 'owner-b' }));
      takeover = createNeonStore({ pool: controlledPool('takeover') }).beginExecution(successor, nextExecution);
      const takeoverResult = takeover.then(value => ({ value }), error => ({ error }));
      await Promise.race([entered, takeoverResult.then(result => { throw result.error || new Error('takeover completed before lock barrier'); })]);
      const oldStore = createNeonStore({ pool: controlledPool('settlement') });
      settle = settlement === 'turn'
        ? oldStore.persistTurn(applyTurn(expired.claim, expired.execution, { disposition: 'done' }))
        : oldStore.persistFailure(failExecution(expired.claim, expired.execution));
      const settlementResult = settle.then(value => ({ value }), error => ({ error }));
      let blocked = false;
      for (let attempt = 0; attempt < 100 && !blocked; attempt++) {
        if (settlementPid) blocked = (await pool.query('SELECT $1::int = ANY(pg_blocking_pids($2)) AS blocked', [takeoverPid, settlementPid])).rows[0].blocked;
        if (!blocked) await new Promise(resolve => setTimeout(resolve, 20));
      }
      assert.equal(blocked, true, 'settlement must contend while takeover holds authority');
      releaseTakeover();
      const [taken, rejected] = await Promise.all([takeoverResult, settlementResult]);
      assert.ifError(taken.error);
      assert.match(rejected.error?.message || '', /fencing conflict/);
      assert.notEqual(rejected.error?.code, '40P01');
      const authority = (await pool.query('SELECT execution_id FROM vnext_project_mutation_authority WHERE project_id=$1', [projectId])).rows[0];
      assert.equal(authority.execution_id, nextExecution.execution_id);
    } finally {
      releaseTakeover();
      await Promise.allSettled([takeover, settle].filter(Boolean));
      await cleanup(pool, [first.work_unit_id, second.work_unit_id], [projectId]);
      await pool.end();
    }
  });
}
