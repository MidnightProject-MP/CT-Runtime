import test from 'node:test';
import assert from 'node:assert/strict';
import { testAuthorizationVerifier } from './vnext-test-authorization.mjs';
import { createMemoryStore as createMemoryStoreCore } from '../lib/vnext/memory-store.mjs';
import { createNeonStore } from '../lib/vnext/neon-store.mjs';
import { createPilotStore } from '../lib/vnext/pilot-store.mjs';
import { applyTurn, claimWorkUnit, createExecution as createExecutionCore, createWorkUnit, startExecution, failExecution } from '../lib/vnext/kernel.mjs';

const createMemoryStore = (options = {}) => createMemoryStoreCore({ authorizationVerifier: testAuthorizationVerifier, ...options });
const createExecution = (workUnit, options = {}) => createExecutionCore(workUnit, { ...options, authorizationDecisionRef: options.authorizationDecisionRef || `test-auth:${options.executionId}` });

function claimedExecution(workUnit, executionId, owner, now = new Date('2026-09-16T12:00:00.000Z'), claimExpiresAt = '2099-09-16T12:00:00.000Z') {
  const claimed = claimWorkUnit(workUnit, { executionId, owner, now, claimExpiresAt });
  return { claimed, execution: startExecution(createExecution(claimed, { executionId, owner, startedAt: now.toISOString() })) };
}

function projectWorkUnit(suffix) {
  return createWorkUnit({ workUnitId: `wu-pool-${suffix}`, objectiveRef: `objective-pool-${suffix}`, projectId: `project-pool-${suffix}` });
}

test('concurrency pool configuration is validated at construction', () => {
  for (const invalid of [0, -1, 1.5, '2']) {
    assert.throws(() => createMemoryStore({ maxConcurrency: invalid }), /positive integer/);
    assert.throws(() => createNeonStore({ pool: {}, maxConcurrency: invalid }), /positive integer/);
    assert.throws(() => createPilotStore({ pool: {}, maxConcurrency: invalid }), /positive integer/);
  }
  assert.ok(createMemoryStore({ maxConcurrency: 2 }));
  assert.ok(createPilotStore({ pool: {}, maxConcurrency: 1 }));
});

test('pool occupancy is derived from the authorities even without a configured cap', async () => {
  const workUnits = [projectWorkUnit('free-a'), projectWorkUnit('free-b'), projectWorkUnit('free-c')];
  const store = createMemoryStore({ workUnits });
  for (const [index, work] of workUnits.entries()) {
    const active = claimedExecution(work, `exec-pool-free-${index}`, `owner-${index}`);
    await store.beginExecution(active.claimed, active.execution, { ref: active.execution.authorization_decision_ref });
  }
  const reservations = await store.listReservations();
  assert.deepEqual(reservations, [
    { project_id: 'project-pool-free-a', work_unit_id: 'wu-pool-free-a', execution_id: 'exec-pool-free-0', fence: 1, owner: 'owner-0' },
    { project_id: 'project-pool-free-b', work_unit_id: 'wu-pool-free-b', execution_id: 'exec-pool-free-1', fence: 1, owner: 'owner-1' },
    { project_id: 'project-pool-free-c', work_unit_id: 'wu-pool-free-c', execution_id: 'exec-pool-free-2', fence: 1, owner: 'owner-2' },
  ]);
  assert.equal(store.snapshot().authorities.length, 3);
});

test('an exhausted pool refuses admission without changing durable state', async () => {
  const firstWork = projectWorkUnit('cap-a');
  const secondWork = projectWorkUnit('cap-b');
  const thirdWork = projectWorkUnit('cap-c');
  const store = createMemoryStore({ workUnits: [firstWork, secondWork, thirdWork], maxConcurrency: 2 });
  const first = claimedExecution(firstWork, 'exec-pool-cap-a', 'owner-a');
  const second = claimedExecution(secondWork, 'exec-pool-cap-b', 'owner-b');
  await store.beginExecution(first.claimed, first.execution, { ref: first.execution.authorization_decision_ref });
  await store.beginExecution(second.claimed, second.execution, { ref: second.execution.authorization_decision_ref });

  const third = claimedExecution(thirdWork, 'exec-pool-cap-c', 'owner-c');
  const before = store.snapshot();
  await assert.rejects(() => store.beginExecution(third.claimed, third.execution, { ref: third.execution.authorization_decision_ref }), /E_CONCURRENCY_LIMIT|concurrency pool is exhausted/);
  assert.deepEqual(store.snapshot(), before);
  assert.equal((await store.listReservations()).length, 2);
});

test('settlement releases the slot for the next project', async () => {
  const firstWork = projectWorkUnit('settle-a');
  const secondWork = projectWorkUnit('settle-b');
  const store = createMemoryStore({ workUnits: [firstWork, secondWork], maxConcurrency: 1 });
  const first = claimedExecution(firstWork, 'exec-pool-settle-a', 'owner-a');
  await store.beginExecution(first.claimed, first.execution, { ref: first.execution.authorization_decision_ref });

  const second = claimedExecution(secondWork, 'exec-pool-settle-b', 'owner-b');
  await assert.rejects(() => store.beginExecution(second.claimed, second.execution, { ref: second.execution.authorization_decision_ref }), /E_CONCURRENCY_LIMIT/);

  const settled = applyTurn(first.claimed, first.execution, {
    objective_id: firstWork.objective_ref, summary: 'Waiting for the next input.',
    disposition: 'waiting',
    continuation: { mode: 'condition', condition: { kind: 'external', condition: 'next input' } },
  });
  await store.persistTurn(settled);
  assert.deepEqual(await store.listReservations(), []);
  assert.deepEqual(store.snapshot().authorities, []);

  await store.beginExecution(second.claimed, second.execution, { ref: second.execution.authorization_decision_ref });
  assert.deepEqual(await store.listReservations(), [
    { project_id: 'project-pool-settle-b', work_unit_id: 'wu-pool-settle-b', execution_id: 'exec-pool-settle-b', fence: 1, owner: 'owner-b' },
  ]);
});

test('failure settlement releases the slot', async () => {
  const firstWork = projectWorkUnit('fail-a');
  const secondWork = projectWorkUnit('fail-b');
  const store = createMemoryStore({ workUnits: [firstWork, secondWork], maxConcurrency: 1 });
  const first = claimedExecution(firstWork, 'exec-pool-fail-a', 'owner-a');
  await store.beginExecution(first.claimed, first.execution, { ref: first.execution.authorization_decision_ref });

  const second = claimedExecution(secondWork, 'exec-pool-fail-b', 'owner-b');
  await assert.rejects(() => store.beginExecution(second.claimed, second.execution, { ref: second.execution.authorization_decision_ref }), /E_CONCURRENCY_LIMIT/);

  await store.persistFailure(failExecution(first.claimed, first.execution, { maxAttempts: 3, failure: { message: 'known-safe failure', no_external_effect: true } }));
  assert.deepEqual(await store.listReservations(), []);
  await store.beginExecution(second.claimed, second.execution, { ref: second.execution.authorization_decision_ref });
  assert.equal((await store.listReservations()).length, 1);
});

test('supersession releases the slot exactly once and never a successor', async () => {
  const firstWork = projectWorkUnit('supersede-a');
  const secondWork = projectWorkUnit('supersede-b');
  const store = createMemoryStore({ workUnits: [firstWork, secondWork], maxConcurrency: 1 });
  const first = claimedExecution(firstWork, 'exec-pool-supersede-a', 'owner-a');
  await store.beginExecution(first.claimed, first.execution, { ref: first.execution.authorization_decision_ref });
  await store.reviseWorkRequirements(firstWork.work_unit_id, { expectedRevision: 1, requirements: { finish: 'revised while the attempt was stale' } });

  await store.persistSuperseded({ workUnit: structuredClone(first.claimed), execution: { ...first.execution, state: 'running' } });
  assert.deepEqual(await store.listReservations(), []);

  const second = claimedExecution(secondWork, 'exec-pool-supersede-b', 'owner-b');
  await store.beginExecution(second.claimed, second.execution, { ref: second.execution.authorization_decision_ref });

  const replay = await store.persistSuperseded({ workUnit: structuredClone(first.claimed), execution: { ...first.execution, state: 'running' } });
  assert.equal(replay.state, 'actionable');
  assert.deepEqual(await store.listReservations(), [
    { project_id: 'project-pool-supersede-b', work_unit_id: 'wu-pool-supersede-b', execution_id: 'exec-pool-supersede-b', fence: 1, owner: 'owner-b' },
  ]);
});

test('a stop-unconfirmed attempt keeps its reservation until recovery releases it', async () => {
  const firstWork = projectWorkUnit('recovery-a');
  const secondWork = projectWorkUnit('recovery-b');
  const store = createMemoryStore({ workUnits: [firstWork, secondWork], maxConcurrency: 1 });
  const first = claimedExecution(firstWork, 'exec-pool-recovery-a', 'owner-a', new Date('2026-09-16T12:00:00.000Z'), '2026-09-16T11:59:59.000Z');
  await store.beginExecution(first.claimed, first.execution, { ref: first.execution.authorization_decision_ref });

  const second = claimedExecution(secondWork, 'exec-pool-recovery-b', 'owner-b', new Date('2026-09-16T12:00:02.000Z'), '2099-09-16T12:05:00.000Z');
  await assert.rejects(() => store.beginExecution(second.claimed, second.execution, { ref: second.execution.authorization_decision_ref }), /E_CONCURRENCY_LIMIT/);
  assert.deepEqual(await store.listReservations(), [
    { project_id: 'project-pool-recovery-a', work_unit_id: 'wu-pool-recovery-a', execution_id: 'exec-pool-recovery-a', fence: 1, owner: 'owner-a' },
  ]);

  const recovered = await store.recoverAttempt({ projectId: 'project-pool-recovery-a', workUnitId: 'wu-pool-recovery-a', executionId: 'exec-pool-recovery-a', fence: 1, resolution: 'not-launched' });
  assert.equal(recovered.state, 'waiting');
  assert.deepEqual(await store.listReservations(), []);

  await store.beginExecution(second.claimed, second.execution, { ref: second.execution.authorization_decision_ref });
  assert.deepEqual(await store.listReservations(), [
    { project_id: 'project-pool-recovery-b', work_unit_id: 'wu-pool-recovery-b', execution_id: 'exec-pool-recovery-b', fence: 1, owner: 'owner-b' },
  ]);
});

test('reconstruction derives reservations from the recovered authorities', async () => {
  const firstWork = projectWorkUnit('reconstruct-a');
  const secondWork = projectWorkUnit('reconstruct-b');
  const original = createMemoryStore({ workUnits: [firstWork, secondWork], maxConcurrency: 1 });
  const first = claimedExecution(firstWork, 'exec-pool-reconstruct-a', 'owner-a');
  await original.beginExecution(first.claimed, first.execution, { ref: first.execution.authorization_decision_ref });

  const snapshot = original.snapshot();
  const reconstructed = createMemoryStore({ workUnits: snapshot.work, executions: snapshot.executions, maxConcurrency: 1 });
  const reservations = await reconstructed.listReservations();
  assert.deepEqual(reservations, [
    { project_id: 'project-pool-reconstruct-a', work_unit_id: 'wu-pool-reconstruct-a', execution_id: 'exec-pool-reconstruct-a', fence: 1, owner: 'owner-a' },
  ]);

  const second = claimedExecution(secondWork, 'exec-pool-reconstruct-b', 'owner-b');
  await assert.rejects(() => reconstructed.beginExecution(second.claimed, second.execution, { ref: second.execution.authorization_decision_ref }), /E_CONCURRENCY_LIMIT/);

  const settled = applyTurn(first.claimed, first.execution, {
    objective_id: firstWork.objective_ref, summary: 'Waiting for the next input.',
    disposition: 'waiting',
    continuation: { mode: 'condition', condition: { kind: 'external', condition: 'next input' } },
  });
  await reconstructed.persistTurn(settled);
  await reconstructed.beginExecution(second.claimed, second.execution, { ref: second.execution.authorization_decision_ref });
  assert.equal((await reconstructed.listReservations()).length, 1);
});
