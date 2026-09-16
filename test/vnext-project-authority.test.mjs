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
  await assert.rejects(() => store.beginExecution(second.claimed, second.execution), /project mutation authority is already held/);

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
