import test from 'node:test';
import { testAuthorizationDecision, testAuthorizationVerifier } from './vnext-test-authorization.mjs';

const createMemoryStore = (options = {}) => createMemoryStoreCore({ authorizationVerifier: testAuthorizationVerifier, ...options });
const createExecution = (workUnit, options = {}) => createExecutionCore(workUnit, { ...options, authorizationDecisionRef: options.authorizationDecisionRef || `test-auth:${options.executionId}` });
const runOuterLoop = (options = {}) => runOuterLoopCore({ authorizeExecution: testAuthorizationDecision, ...options });
import assert from 'node:assert/strict';
import { createMemoryStore as createMemoryStoreCore } from '../lib/vnext/memory-store.mjs';
import { applyTurn, claimWorkUnit, createExecution as createExecutionCore, createWorkUnit, startExecution } from '../lib/vnext/kernel.mjs';

function claimedExecution(workUnit, executionId, owner, now = new Date('2026-09-16T12:00:00.000Z'), claimExpiresAt = '2099-09-16T12:00:00.000Z') {
  const claimed = claimWorkUnit(workUnit, { executionId, owner, now, claimExpiresAt });
  return { claimed, execution: startExecution(createExecution(claimed, { executionId, owner, startedAt: now.toISOString() })) };
}

test('memory acquisition requires a verifier to bind authorization scope to the Execution', async () => {
  const work = createWorkUnit({ workUnitId: 'wu-auth-scope', objectiveRef: 'objective-auth-scope', projectId: 'project-auth-scope' });
  const claimed = claimedExecution(work, 'exec-auth-scope', 'owner-a');
  const store = createMemoryStore({
    workUnits: [work],
    authorizationVerifier: async (decision, { execution }) => decision.scope?.project_id === execution.project_id,
  });
  await assert.rejects(
    () => store.beginExecution(claimed.claimed, claimed.execution, { ref: claimed.execution.authorization_decision_ref, scope: { project_id: 'wrong-project' } }),
    /authorization decision is not valid/,
  );
  assert.equal(store.snapshot().executions.length, 0);
});

test('memory store grants at most one current mutation authority per project and releases it on settlement', async () => {
  const firstWork = createWorkUnit({ workUnitId: 'wu-project-a', objectiveRef: 'objective-a', projectId: 'project-shared' });
  const secondWork = createWorkUnit({ workUnitId: 'wu-project-b', objectiveRef: 'objective-b', projectId: 'project-shared' });
  const store = createMemoryStore({ workUnits: [firstWork, secondWork] });
  const first = claimedExecution(firstWork, 'exec-project-a', 'owner-a');
  await store.beginExecution(first.claimed, first.execution, { ref: first.execution.authorization_decision_ref });

  const second = claimedExecution(secondWork, 'exec-project-b', 'owner-b');
  await assert.rejects(() => store.beginExecution(second.claimed, second.execution, { ref: second.execution.authorization_decision_ref }), /E_PROJECT_AUTH_HELD|project mutation authority is already held/);

  const settled = applyTurn(first.claimed, first.execution, {
    disposition: 'waiting',
    continuation: { mode: 'condition', condition: { kind: 'external', condition: 'next input' } },
  });
  await store.persistTurn(settled);
  assert.deepEqual(store.snapshot().authorities, []);

  await store.beginExecution(second.claimed, second.execution, { ref: second.execution.authorization_decision_ref });
  assert.deepEqual(store.snapshot().authorities, [{
    project_id: 'project-shared',
    work_unit_id: 'wu-project-b',
    execution_id: 'exec-project-b',
    fence: 1,
    owner: 'owner-b',
    claim_expires_at: second.execution.claim_expires_at,
    authorization_decision_ref: second.execution.authorization_decision_ref,
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

test('memory reconstruction preserves an expired pre-A8 claim and permits an independently authorized successor', async () => {
  const work = createWorkUnit({ workUnitId: 'wu-legacy-recovery', objectiveRef: 'objective-legacy-recovery', projectId: 'project-legacy-recovery' });
  const legacyClaimed = claimWorkUnit(work, {
    executionId: 'exec-legacy-recovery',
    owner: 'legacy-owner',
    now: new Date('2026-09-16T12:00:00.000Z'),
    claimExpiresAt: '2026-09-16T11:59:59.000Z',
  });
  const legacyExecution = createExecutionCore(legacyClaimed, {
    executionId: 'exec-legacy-recovery',
    owner: 'legacy-owner',
    authorizationDecisionRef: null,
  });
  const legacy = { ...legacyExecution, state: 'expired', finished_at: '2026-09-16T12:00:01.000Z' };

  const reconstructed = createMemoryStore({
    workUnits: [legacyClaimed],
    executions: [legacy],
  });
  assert.deepEqual(reconstructed.snapshot().authorities, []);

  const successorClaimed = claimWorkUnit(legacyClaimed, {
    executionId: 'exec-legacy-successor',
    owner: 'successor-owner',
    now: new Date('2026-09-16T12:00:02.000Z'),
    claimExpiresAt: '2099-09-16T12:05:00.000Z',
  });
  const successor = startExecution(createExecution(successorClaimed, {
    executionId: 'exec-legacy-successor',
    owner: 'successor-owner',
    authorizationDecisionRef: 'test-auth:exec-legacy-successor',
  }));

  await reconstructed.beginExecution(successorClaimed, successor, { ref: successor.authorization_decision_ref });
  const snapshot = reconstructed.snapshot();
  assert.equal(snapshot.executions.find((item) => item.execution_id === 'exec-legacy-recovery').authorization_decision_ref, null);
  assert.equal(snapshot.executions.find((item) => item.execution_id === 'exec-legacy-successor').authorization_decision_ref, 'test-auth:exec-legacy-successor');
  assert.deepEqual(snapshot.authorities, [{
    project_id: 'project-legacy-recovery',
    work_unit_id: 'wu-legacy-recovery',
    execution_id: 'exec-legacy-successor',
    fence: 2,
    owner: 'successor-owner',
    claim_expires_at: successor.claim_expires_at,
    authorization_decision_ref: successor.authorization_decision_ref,
  }]);
});

test('memory store rejects an expired non-legacy Execution during authority reconstruction', () => {
  const work = createWorkUnit({ workUnitId: 'wu-reconstruct-expired', objectiveRef: 'objective-reconstruct-expired', projectId: 'project-reconstruct-expired' });
  const first = claimedExecution(work, 'exec-reconstruct-expired', 'owner-a');
  const expiredExecution = { ...first.execution, state: 'expired', authorization_decision_ref: 'test-auth:exec-reconstruct-expired' };

  assert.throws(
    () => createMemoryStore({ workUnits: [first.claimed], executions: [expiredExecution] }),
    /invalid reconstructed authority: execution exec-reconstruct-expired does not match Work Unit claim/,
  );
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

test('memory store rejects settlement when execution claim expiry diverges from durable claim', async () => {
  const work = createWorkUnit({ workUnitId: 'wu-expiry-boundary', objectiveRef: 'objective-expiry-boundary', projectId: 'project-expiry-boundary' });
  const first = claimedExecution(work, 'exec-expiry-boundary', 'owner-a');
  const store = createMemoryStore({ workUnits: [first.claimed], executions: [first.execution] });
  const forged = { ...first.execution, claim_expires_at: '2099-09-17T12:00:00.000Z' };
  await assert.rejects(
    () => store.persistTurn({ workUnit: first.claimed, execution: forged, turn: { disposition: 'done' } }),
    /fencing conflict while persisting turn/,
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
  await store.beginExecution(first.claimed, first.execution, { ref: first.execution.authorization_decision_ref });

  const second = claimedExecution(secondWork, 'exec-expired-b', 'owner-b', new Date('2026-09-16T12:00:02.000Z'), '2099-09-16T12:01:00.000Z');
  await store.beginExecution(second.claimed, second.execution, { ref: second.execution.authorization_decision_ref });

  const snapshot = store.snapshot();
  assert.equal(snapshot.executions.find((item) => item.execution_id === 'exec-expired-a').state, 'expired');
  assert.equal(snapshot.work.find((item) => item.work_unit_id === firstWork.work_unit_id).claim, null);
  assert.deepEqual(snapshot.authorities, [{
    project_id: 'project-expired',
    work_unit_id: 'wu-expired-b',
    execution_id: 'exec-expired-b',
    fence: 1,
    owner: 'owner-b',
    claim_expires_at: second.execution.claim_expires_at,
    authorization_decision_ref: second.execution.authorization_decision_ref,
  }]);
});

test('memory acquisition rejects a consistently forged project without changing durable state', async () => {
  const first = createWorkUnit({ workUnitId: 'binding-a', objectiveRef: 'objective-a', projectId: 'project-a' });
  const second = createWorkUnit({ workUnitId: 'binding-b', objectiveRef: 'objective-b', projectId: 'project-a' });
  const store = createMemoryStore({ workUnits: [first, second] });
  const active = claimedExecution(first, 'binding-active', 'owner-a');
  await store.beginExecution(active.claimed, active.execution, { ref: active.execution.authorization_decision_ref });
  const before = store.snapshot();
  const forged = claimedExecution({ ...second, project_id: 'project-b' }, 'binding-forged', 'owner-b');
  await assert.rejects(() => store.beginExecution(forged.claimed, forged.execution, { ref: forged.execution.authorization_decision_ref }), /different stored project/);
  assert.deepEqual(store.snapshot(), before);
});
