import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorkUnit, claimWorkUnit, createExecution, startExecution, applyTurn, failExecution } from '../lib/vnext/kernel.mjs';
import { createMemoryStore } from '../lib/vnext/memory-store.mjs';
import { runOuterLoop } from '../lib/vnext/outer-loop.mjs';

const verifier = async (decision, { execution }) => decision?.ref === execution.authorization_decision_ref;
const authorize = ({ execution }) => ({ ref: `test-auth:${execution.execution_id}` });
const makeStore = (options = {}) => createMemoryStore({ authorizationVerifier: verifier, ...options });

test('A9 admission requires the complete transactional contract and launches no worker', async () => {
  for (const missing of ['beginExecution', 'persistTurn', 'persistFailure']) {
    const base = makeStore({ workUnits: [createWorkUnit({ workUnitId: `wu-admission-${missing}`, objectiveRef: 'objective', projectId: 'project' })] });
    const store = { ...base, [missing]: undefined };
    let launched = false;
    await assert.rejects(() => runOuterLoop({
      wake: { type: 'test', event_id: `admission-${missing}`, work_unit_id: `wu-admission-${missing}` },
      store,
      authorizeExecution: authorize,
      executor: async () => { launched = true; return { objective_id: 'objective', disposition: 'continue', summary: 'must not run', continuation: { mode: 'immediate' } }; },
    }), new RegExp(`transactional store requires ${missing}`));
    assert.equal(launched, false);
    assert.equal(base.snapshot().executions.length, 0);
  }
});

test('memory acquisition is exception-atomic when proposed execution cannot be cloned', async () => {
  const work = createWorkUnit({ workUnitId: 'wu-acquire-atomic', objectiveRef: 'objective', projectId: 'project' });
  const store = makeStore({ workUnits: [work] });
  const claimed = claimWorkUnit(work, { executionId: 'exec-acquire-atomic', owner: 'owner' });
  const execution = startExecution(createExecution(claimed, { executionId: claimed.claim.execution_id, owner: claimed.claim.owner, authorizationDecisionRef: 'test-auth:exec-acquire-atomic' }));
  const before = store.snapshot();
  await assert.rejects(() => store.beginExecution(claimed, { ...execution, bad: () => {} }, { ref: execution.authorization_decision_ref }), /could not be cloned|DataCloneError|structuredClone/i);
  assert.deepEqual(store.snapshot(), before);
});

test('memory settlement is exception-atomic when continuation cannot be cloned', async () => {
  const work = createWorkUnit({ workUnitId: 'wu-settle-atomic', objectiveRef: 'objective', projectId: 'project' });
  const store = makeStore({ workUnits: [work] });
  const claimed = claimWorkUnit(work, { executionId: 'exec-settle-atomic', owner: 'owner' });
  const execution = startExecution(createExecution(claimed, { executionId: claimed.claim.execution_id, owner: claimed.claim.owner, authorizationDecisionRef: 'test-auth:exec-settle-atomic' }));
  const begun = await store.beginExecution(claimed, execution, { ref: execution.authorization_decision_ref });
  const result = applyTurn(begun.workUnit, begun.execution, { disposition: 'continue', summary: 'bad clone', continuation: { next: () => {} } });
  const before = store.snapshot();
  await assert.rejects(() => store.persistTurn(result), /could not be cloned|DataCloneError|structuredClone/i);
  assert.deepEqual(store.snapshot(), before);
});

test('memory failure settlement is exception-atomic when failure cannot be cloned', async () => {
  const work = createWorkUnit({ workUnitId: 'wu-failure-atomic', objectiveRef: 'objective', projectId: 'project' });
  const store = makeStore({ workUnits: [work] });
  const claimed = claimWorkUnit(work, { executionId: 'exec-failure-atomic', owner: 'owner' });
  const execution = startExecution(createExecution(claimed, { executionId: claimed.claim.execution_id, owner: claimed.claim.owner, authorizationDecisionRef: 'test-auth:exec-failure-atomic' }));
  const begun = await store.beginExecution(claimed, execution, { ref: execution.authorization_decision_ref });
  const failed = failExecution(begun.workUnit, begun.execution, { failure: { message: 'failure' }, retryAfter: new Date(Date.now() + 1000).toISOString() });
  failed.workUnit.failure = { message: () => {} };
  const before = store.snapshot();
  await assert.rejects(() => store.persistFailure(failed), /could not be cloned|DataCloneError|structuredClone/i);
  assert.deepEqual(store.snapshot(), before);
});

test('failed takeover preserves the expired predecessor and commits no successor state', async () => {
  const expired = new Date(Date.now() - 1000).toISOString();
  const work = { ...createWorkUnit({ workUnitId: 'wu-takeover-atomic', objectiveRef: 'objective', projectId: 'project' }), fence: 1, attempt: 1, claim_expires_at: expired, claim: { execution_id: 'exec-predecessor', owner: 'old-owner', fence: 1, claim_expires_at: expired } };
  const predecessor = { execution_id: 'exec-predecessor', work_unit_id: work.work_unit_id, project_id: work.project_id, authorization_decision_ref: 'test-auth:exec-predecessor', owner: 'old-owner', fence: 1, state: 'running', attempt: 1, claim_expires_at: expired };
  const store = makeStore({ workUnits: [work], executions: [predecessor] });
  const before = store.snapshot();
  const successorClaim = claimWorkUnit({ ...work, claim: null, claim_expires_at: null, state: 'waiting' }, { executionId: 'exec-successor', owner: 'new-owner' });
  const successor = startExecution(createExecution(successorClaim, { executionId: 'exec-successor', owner: 'new-owner', authorizationDecisionRef: 'test-auth:exec-successor' }));
  await assert.rejects(() => store.beginExecution(successorClaim, { ...successor, invalid: () => {} }, { ref: successor.authorization_decision_ref }), /could not be cloned|DataCloneError|structuredClone/i);
  assert.deepEqual(store.snapshot(), before);
  assert.equal(store.snapshot().executions.find((item) => item.execution_id === 'exec-predecessor').state, 'running');
  assert.equal(store.snapshot().authorities.length, 0);
});

test('runtime exposes only transactional mutation transitions', () => {
  const store = makeStore();
  for (const method of ['saveWorkUnit', 'createExecution', 'finishExecution', 'appendContinuation', 'appendEvidence']) {
    assert.equal(method in store, false, method);
  }
});
