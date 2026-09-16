import test from 'node:test';
import assert from 'node:assert/strict';
import { applyTurn, claimWorkUnit, createExecution, createWorkUnit, failExecution, startExecution } from '../lib/vnext/kernel.mjs';

test('kernel rejects an execution from another Work Unit during settlement', () => {
  const first = createWorkUnit({ workUnitId: 'wu-a', objectiveRef: 'objective-a', projectId: 'project-a' });
  const second = createWorkUnit({ workUnitId: 'wu-b', objectiveRef: 'objective-b', projectId: 'project-b' });
  const claimed = claimWorkUnit(first, { executionId: 'exec-a', owner: 'owner-a', now: new Date('2026-09-16T12:00:00Z') });
  const execution = startExecution(createExecution(claimed, { executionId: 'exec-a', owner: 'owner-a' }));
  const secondClaimed = claimWorkUnit(second, { executionId: 'exec-a', owner: 'owner-a', now: new Date('2026-09-16T12:00:00Z') });

  assert.throws(() => applyTurn(secondClaimed, execution, { disposition: 'continue', continuation: { mode: 'immediate' } }), /different Work Unit/);
  assert.throws(() => failExecution(secondClaimed, execution), /different Work Unit/);
});

test('kernel keeps the execution Work Unit and project identities immutable at creation', () => {
  const workUnit = createWorkUnit({ workUnitId: 'wu-a', objectiveRef: 'objective-a', projectId: 'project-a' });
  const claimed = claimWorkUnit(workUnit, { executionId: 'exec-a', owner: 'owner-a', now: new Date('2026-09-16T12:00:00Z') });
  const execution = createExecution(claimed, { executionId: 'exec-a', owner: 'owner-a' });
  assert.equal(execution.work_unit_id, workUnit.work_unit_id);
  assert.equal(execution.project_id, workUnit.project_id);
});
