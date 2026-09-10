import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorkUnit } from '../lib/vnext/kernel.mjs';
import { createMemoryStore } from '../lib/vnext/memory-store.mjs';
import { runOuterLoop } from '../lib/vnext/outer-loop.mjs';

test('Feedback wake reconstructs one Work Unit and runs a disposable execution', async () => {
  const store = createMemoryStore({ workUnits: [createWorkUnit({ workUnitId: 'wu-feedback-1', objectiveRef: 'objective-1' })] });
  let calls = 0;

  const first = await runOuterLoop({
    wake: { type: 'feedback.received', event_id: 'feedback-1', work_unit_id: 'wu-feedback-1' },
    store,
    executor: async () => {
      calls += 1;
      return {
        objective_id: 'ignored-by-runtime',
        disposition: 'continue',
        summary: 'Meaningful bounded progress was made.',
        continuation: { mode: 'immediate', next_action: 'Inspect the remaining evidence.' },
      };
    },
  });

  assert.equal(first.disposition, 'continue');
  assert.equal(calls, 1);
  const snapshot = store.snapshot();
  assert.equal(snapshot.executions.length, 1);
  assert.equal(snapshot.executions[0].state, 'succeeded');
  assert.equal(snapshot.work[0].state, 'actionable');
  assert.equal(snapshot.work[0].claim, null);
  assert.equal(snapshot.continuations.length, 1);
  assert.notEqual(snapshot.executions[0].execution_id, 'wu-feedback-1');
});

test('a later wake produces a new disposable execution rather than a handoff', async () => {
  const store = createMemoryStore({ workUnits: [createWorkUnit({ workUnitId: 'wu-repeat-1', objectiveRef: 'objective-2' })] });
  const executionIds = [];
  const executor = async ({ execution }) => {
    executionIds.push(execution.execution_id);
    return {
      objective_id: 'objective-2',
      disposition: executionIds.length === 1 ? 'waiting' : 'done',
      summary: executionIds.length === 1 ? 'Waiting for an external condition.' : 'Evidence supports the claimed outcome.',
      ...(executionIds.length === 1
        ? { continuation: { mode: 'condition', condition: { kind: 'external', condition: 'A new result is available.' } } }
        : { outcome_evidence: [{ kind: 'manifest', execution_id: executionIds[0] }] }),
    };
  };

  const first = await runOuterLoop({ wake: { type: 'feedback.received', event_id: 'feedback-2', work_unit_id: 'wu-repeat-1' }, store, executor });
  assert.equal(first.disposition, 'waiting');

  const second = await runOuterLoop({
    wake: { type: 'external.changed', event_id: 'external-1', work_unit_id: 'wu-repeat-1' },
    store,
    executor,
    isJustified: async ({ workUnit }) => workUnit.state === 'waiting',
    authorizeTerminal: () => true,
  });
  assert.equal(second.disposition, 'terminal');
  assert.equal(executionIds.length, 2);
  assert.notEqual(executionIds[0], executionIds[1]);
  assert.equal(store.snapshot().executions.length, 2);
});

test('done remains non-authoritative without independent authorization', async () => {
  const store = createMemoryStore({
    workUnits: [createWorkUnit({ workUnitId: 'wu-review-1', objectiveRef: 'objective-3' })],
    executions: [{ execution_id: 'seed-execution', state: 'succeeded', work_unit_id: 'wu-review-1' }],
  });
  const result = await runOuterLoop({
    wake: { type: 'feedback.received', event_id: 'feedback-3', work_unit_id: 'wu-review-1' },
    store,
    executor: async () => ({
      objective_id: 'objective-3',
      disposition: 'done',
      summary: 'The execution claims the outcome.',
      outcome_evidence: [{ kind: 'manifest', execution_id: 'seed-execution' }],
    }),
  });

  assert.equal(result.disposition, 'needs-review');
  assert.equal(store.snapshot().work[0].state, 'review');
  assert.equal(store.snapshot().executions.at(-1).state, 'succeeded');
});

test('no reconstructed work means quiescence and no execution', async () => {
  const store = createMemoryStore();
  const result = await runOuterLoop({
    wake: { type: 'feedback.received', event_id: 'feedback-4' },
    store,
    executor: async () => { throw new Error('must not execute'); },
  });
  assert.deepEqual(result, { disposition: 'quiesced', reason: 'no-work' });
  assert.equal(store.snapshot().executions.length, 0);
});
