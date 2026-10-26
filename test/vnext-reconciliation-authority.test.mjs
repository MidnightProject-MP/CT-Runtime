import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore } from '../lib/vnext/memory-store.mjs';
import { createWorkUnit } from '../lib/vnext/kernel.mjs';
import { testReconciliationDecision, verifyTestReconciliation } from './vnext-test-reconciliation.mjs';

function blockedStore({ reconciliationVerifier = null } = {}) {
  const projectId = 'reconciliation-authority-project';
  const workUnitId = 'reconciliation-authority-work';
  const executionId = 'reconciliation-authority-execution';
  const fence = 1;
  const workUnit = {
    ...createWorkUnit({ workUnitId, objectiveRef: 'objective', projectId }),
    state: 'review',
    last_execution_id: executionId,
  };
  const execution = {
    execution_id: executionId,
    work_unit_id: workUnitId,
    project_id: projectId,
    fence,
    state: 'failed',
    attempt: 1,
    failure: { reconciliation_required: true, reason: 'external-effect-uncertain' },
  };
  const block = { project_id: projectId, work_unit_id: workUnitId, execution_id: executionId, fence, reason: 'external-effect-uncertain' };
  const store = createMemoryStore({ workUnits: [workUnit], executions: [execution], reconciliationBlocks: [block], reconciliationVerifier });
  const decision = testReconciliationDecision({ projectId, workUnitId, executionId, fence });
  return { store, decision, projectId, workUnitId, executionId, fence };
}

test('reconciliation refuses to clear uncertainty without a configured verifier', async () => {
  const { store, decision, projectId } = blockedStore();
  await assert.rejects(store.reconcileFailure({ decision }), /reconciliation verifier is required/);
  assert.equal(store.snapshot().reconciliationBlocks[0].project_id, projectId);
  assert.equal(store.snapshot().work[0].state, 'review');
});

test('reconciliation requires evidence and stop confirmation bound to the exact attempt', async () => {
  const { store, decision, workUnitId, executionId } = blockedStore({ reconciliationVerifier: verifyTestReconciliation });
  await assert.rejects(store.reconcileFailure({ decision: { ...decision, evidence_ref: undefined } }), /evidence_ref is invalid/);
  await assert.rejects(store.reconcileFailure({ decision: { ...decision, sender_stop_confirmed: false } }), /confirmed sender termination/);
  await assert.rejects(store.reconcileFailure({ decision: { ...decision, work_unit_id: `${workUnitId}-other` } }), /does not match/);
  assert.equal(store.snapshot().reconciliationBlocks.length, 1);
  assert.equal(store.snapshot().work[0].last_execution_id, executionId);
});

test('verified reconciliation records the evidence binding and exact replay', async () => {
  const { store, decision, executionId } = blockedStore({ reconciliationVerifier: verifyTestReconciliation });
  const result = await store.reconcileFailure({ decision });
  assert.equal(result.state, 'actionable');
  const event = store.snapshot().events.find(row => row.event_id === `reconciliation:${executionId}`);
  assert.equal(event.payload.decision_ref, decision.ref);
  assert.equal(event.payload.evidence_ref, decision.evidence_ref);
  assert.equal(event.payload.sender_stop_confirmed, true);
  assert.match(event.payload.decision_digest, /^[a-f0-9]{64}$/);
  assert.deepEqual(await store.reconcileFailure({ decision }), result);
  await assert.rejects(store.reconcileFailure({ decision: { ...decision, evidence_ref: 'test-evidence:divergent' } }), /content conflict/);
});

test('a configured authority verifier can reject a syntactically bound decision', async () => {
  const { store, decision } = blockedStore({ reconciliationVerifier: async () => false });
  await assert.rejects(store.reconcileFailure({ decision }), /not authorized for this attempt/);
  assert.equal(store.snapshot().reconciliationBlocks.length, 1);
  assert.equal(store.snapshot().events.length, 0);
});
