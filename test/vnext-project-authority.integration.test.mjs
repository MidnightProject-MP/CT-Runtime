import test from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { migrateVNext } from '../lib/vnext/migration.mjs';
import { claimWorkUnit, createExecution, createWorkUnit, startExecution, applyTurn } from '../lib/vnext/kernel.mjs';
import { createNeonStore } from '../lib/vnext/neon-store.mjs';

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
    await pool.query("UPDATE vnext_project_mutation_authority SET claim_expires_at='2000-01-01T00:00:00Z' WHERE project_id=$1", [projectId]);

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
    await pool.query("UPDATE vnext_project_mutation_authority SET claim_expires_at='2000-01-01T00:00:00Z' WHERE project_id=$1", [projectId]);

    await assert.rejects(
      () => store.persistTurn(applyTurn(claim, execution, { disposition: 'done' })),
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
      () => pool.query('INSERT INTO vnext_project_mutation_authority(project_id,work_unit_id,execution_id,fence,claim_expires_at) VALUES ($1,$2,$3,$4,$5)', [forgedProject, secondWork.work_unit_id, firstExecution.execution_id, 1, '2099-09-16T12:01:00Z']),
      /foreign key|violates/i,
    );

    await assert.rejects(
      () => pool.query('INSERT INTO vnext_project_mutation_authority(project_id,work_unit_id,execution_id,fence,claim_expires_at) VALUES ($1,$2,$3,$4,$5)', [firstProject, firstWork.work_unit_id, firstExecution.execution_id, 2, '2099-09-16T12:01:00Z']),
      /foreign key|violates/i,
    );
  } finally {
    await cleanup(pool, [firstWork.work_unit_id, secondWork.work_unit_id], [firstProject, secondProject, forgedProject]);
    await pool.end();
  }
});
