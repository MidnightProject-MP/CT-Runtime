import test from 'node:test';
import { testAuthorizationDecision, testAuthorizationVerifier } from './vnext-test-authorization.mjs';

const createMemoryStore = (options = {}) => createMemoryStoreCore({ ...options, authorizationVerifier: testAuthorizationVerifier });
const createExecution = (workUnit, options = {}) => createExecutionCore(workUnit, { ...options, authorizationDecisionRef: options.authorizationDecisionRef || `test-auth:${options.executionId}` });
const runOuterLoop = (options = {}) => runOuterLoopCore({ authorizeExecution: testAuthorizationDecision, ...options });
import assert from 'node:assert/strict';
import { createMemoryStore as createMemoryStoreCore } from '../lib/vnext/memory-store.mjs';
import { claimWorkUnit, createExecution as createExecutionCore, createWorkUnit, startExecution } from '../lib/vnext/kernel.mjs';

function executionPair() {
  const workUnit = createWorkUnit({ workUnitId: 'wu-fence', objectiveRef: 'objective-fence', projectId: 'project-fence', createdAt: '2026-09-16T12:00:00.000Z' });
  const firstClaim = claimWorkUnit(workUnit, {
    executionId: 'exec-1', owner: 'owner-1',
    claimExpiresAt: '2026-09-16T12:00:01.000Z',
    now: new Date('2026-09-16T12:00:00.000Z'),
  });
  const firstExecution = startExecution(createExecution(firstClaim, {
    executionId: 'exec-1', owner: 'owner-1', startedAt: '2026-09-16T12:00:00.000Z',
  }));
  return { workUnit, firstClaim, firstExecution };
}

test('memory store rejects an expired execution after a newer fence takes the Work Unit', async () => {
  const { workUnit, firstClaim, firstExecution } = executionPair();
  const store = createMemoryStore({ workUnits: [workUnit] });
  await store.beginExecution(workUnit, firstExecution, { ref: firstExecution.authorization_decision_ref });

  const secondClaim = claimWorkUnit(firstClaim, {
    executionId: 'exec-2', owner: 'owner-2',
    claimExpiresAt: '2026-09-16T12:01:01.000Z',
    now: new Date('2026-09-16T12:00:02.000Z'),
  });
  const secondExecution = startExecution(createExecution(secondClaim, {
    executionId: 'exec-2', owner: 'owner-2', startedAt: '2026-09-16T12:00:02.000Z',
  }));
  await store.beginExecution(firstClaim, secondExecution, { ref: secondExecution.authorization_decision_ref });

  await assert.rejects(
    () => store.persistTurn({
      workUnit: firstClaim,
      execution: firstExecution,
      turn: { disposition: 'continue', continuation: { mode: 'immediate' } },
    }),
    /fencing conflict/,
  );
  await assert.rejects(
    () => store.persistFailure({ workUnit: firstClaim, execution: firstExecution }),
    /fencing conflict/,
  );

  const snapshot = store.snapshot();
  assert.equal(snapshot.work[0].fence, 2);
  assert.equal(snapshot.work[0].claim.execution_id, 'exec-2');
  assert.equal(snapshot.executions.find((e) => e.execution_id === 'exec-1').state, 'expired');
  assert.equal(snapshot.executions.find((e) => e.execution_id === 'exec-2').state, 'running');
});

test('memory store requires the next claim to advance exactly one fence generation', async () => {
  const { workUnit, firstExecution } = executionPair();
  const store = createMemoryStore({ workUnits: [workUnit] });
  await store.beginExecution(workUnit, firstExecution, { ref: firstExecution.authorization_decision_ref });

  const forged = { ...firstExecution, execution_id: 'exec-3', fence: 3, work_unit_id: workUnit.work_unit_id };
  await assert.rejects(() => store.beginExecution(firstExecution, forged, { ref: forged.authorization_decision_ref }), /Work Unit changed before execution could be claimed/);
});
