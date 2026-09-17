import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore } from '../lib/vnext/memory-store.mjs';
import { applyTurn, claimWorkUnit, createExecution, createWorkUnit, startExecution } from '../lib/vnext/kernel.mjs';

function claimedExecution(workUnit, executionId, owner, now = new Date('2026-09-16T12:00:00.000Z'), claimExpiresAt = '2099-09-16T12:00:00.000Z') {
  const claimed = claimWorkUnit(workUnit, { executionId, owner, now, claimExpiresAt });
  return { claimed, execution: startExecution(createExecution(claimed, { executionId, owner, startedAt: now.toISOString() })) };
}

test('memory store grants at most one current mutation authority per project and releases it on settlement', async () => {
  const firstWork = createWorkUnit({ workUnitId: 'wu-project-a', objectiveRef: 'objective-a', projectId: 'project-shared' });
  const secondWork = createWorkUnit({ workUnitId: 'wu-project-b', objectiveRef: 'objective-b', projectId: 'project-shared' });
  const store = createMemoryStore({ workUnits: [firstWork, secondWork] });
  const first = claimedExecution(firstWork, 'exec-project-a', 'owner-a');
  await store.beginExecution(first.claimed, first.execution);

  const second = claimedExecution(secondWork, 'exec-project-b', 'owner-b');
  await assert.rejects(() => store.beginExecution(second.claimed, second.execution), /E_PROJECT_AUTH_HELD|project mutation authority is already held/);

  const settled = applyTurn(first.claimed, first.execution, {
    disposition: 'waiting',
    continuation: { mode: 'condition', condition: { kind: 'external', condition: 'next input' } },
  });
  await store.persistTurn(settled);
  assert.deepEqual(store.snapshot().authorities, []);

  await store.beginExecution(second.claimed, second.execution);
  assert.deepEqual(store.snapshot().authorities, [{
    project_id: 'project-shared',
    work_unit_id: 'wu-project-b',
    execution_id: 'exec-project-b',
    fence: 1,
    claim_expires_at: second.execution.claim_expires_at,
  }]);
});

test('memory store reconstructs project authority from an active Work Unit claim', async () => {
  const firstWork = createWorkUnit({ workUnitId: 'wu-reconstruct-a', objectiveRef: 'objective-reconstruct-a', projectId: 'project-reconstruct' });
  const secondWork = createWorkUnit({ workUnitId: 'wu-reconstruct-b', objectiveRef: 'objective-reconstruct-b', projectId: 'project-reconstruct' });
  const original = createMemoryStore({ workUnits: [firstWork, secondWork] });
  const first = claimedExecution(firstWork, 'exec-reconstruct-a', 'owner-a');
  await original.beginExecution(first.claimed, first.execution);

  const snapshot = original.snapshot();
  const reconstructed = createMemoryStore({ workUnits: snapshot.work, executions: snapshot.executions });
  const second = claimedExecution(secondWork, 'exec-reconstruct-b', 'owner-b');

  await assert.rejects(() => reconstructed.beginExecution(second.claimed, second.execution), /E_PROJECT_AUTH_HELD|project mutation authority is already held/);
  assert.deepEqual(reconstructed.snapshot().authorities, snapshot.authorities);
});

test('memory store rejects reconstructed authority when execution claim expiry diverges from Work Unit claim', () => {
  const work = createWorkUnit({ workUnitId: 'wu-reconstruct-expiry', objectiveRef: 'objective-reconstruct-expiry', projectId: 'project-reconstruct-expiry' });
  const first = claimedExecution(work, 'exec-reconstruct-expiry', 'owner-a');
  const forgedExecution = { ...first.execution, claim_expires_at: '2099-09-17T12:00:00.000Z' };

  assert.throws(
    () => createMemoryStore({ workUnits: [first.claimed], executions: [forgedExecution] }),
    /claim expiration does not match Work Unit claim/,
  );
});

test('memory store rejects settlement after project authority expiry without a takeover', async () => {
  const work = createWorkUnit({ workUnitId: 'wu-expired-settlement', objectiveRef: 'objective-expired-settlement', projectId: 'project-expired-settlement' });
  const first = claimedExecution(work, 'exec-expired-settlement', 'owner-a', new Date('2026-09-16T12:00:00.000Z'), '2026-09-16T11:59:59.000Z');
  const store = createMemoryStore({
    workUnits: [first.claimed],
    executions: [first.execution],
  });

  await assert.rejects(
    () => store.persistTurn(applyTurn(first.claimed, first.execution, { disposition: 'done' })),
    /project mutation authority expired/,
  );

  const snapshot = store.snapshot();
  assert.equal(snapshot.executions[0].state, 'running');
  assert.equal(snapshot.work[0].claim.execution_id, first.execution.execution_id);
  assert.equal(snapshot.authorities[0].execution_id, first.execution.execution_id);
});

test('kernel rejects a cross-project execution during a pure Work Unit transition', () => {
  const work = createWorkUnit({ workUnitId: 'wu-kernel-project', objectiveRef: 'objective-kernel-project', projectId: 'project-a' });
  const claimed = claimWorkUnit(work, { executionId: 'exec-kernel-project', owner: 'owner-a' });
  const execution = startExecution(createExecution(claimed, { executionId: claimed.claim.execution_id, owner: claimed.claim.owner }));
  const forged = { ...execution, project_id: 'project-b' };

  assert.throws(
    () => applyTurn(claimed, forged, { disposition: 'done' }),
    /execution belongs to a different project/,
  );
});

test('expired project authority is revoked before another Work Unit acquires the project', async () => {
  const firstWork = createWorkUnit({ workUnitId: 'wu-expired-a', objectiveRef: 'objective-expired-a', projectId: 'project-expired' });
  const secondWork = createWorkUnit({ workUnitId: 'wu-expired-b', objectiveRef: 'objective-expired-b', projectId: 'project-expired' });
  const store = createMemoryStore({ workUnits: [firstWork, secondWork] });
  const expiredAt = '2026-09-16T11:59:59.000Z';
  const first = claimedExecution(firstWork, 'exec-expired-a', 'owner-a', new Date('2026-09-16T12:00:00.000Z'), expiredAt);
  await store.beginExecution(first.claimed, first.execution);

  const second = claimedExecution(secondWork, 'exec-expired-b', 'owner-b', new Date('2026-09-16T12:00:02.000Z'), '2099-09-16T12:01:00.000Z');
  await store.beginExecution(second.claimed, second.execution);

  const snapshot = store.snapshot();
  assert.equal(snapshot.executions.find((item) => item.execution_id === 'exec-expired-a').state, 'expired');
  assert.equal(snapshot.work.find((item) => item.work_unit_id === firstWork.work_unit_id).claim, null);
  assert.deepEqual(snapshot.authorities, [{
    project_id: 'project-expired',
    work_unit_id: 'wu-expired-b',
    execution_id: 'exec-expired-b',
    fence: 1,
    claim_expires_at: second.execution.claim_expires_at,
  }]);
});
