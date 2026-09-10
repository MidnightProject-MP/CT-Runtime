import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorkUnit, claimWorkUnit, createExecution, startExecution, applyTurn } from '../lib/vnext/kernel.mjs';
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
      return { objective_id: 'objective-1', disposition: 'continue', summary: 'Meaningful bounded progress was made.', continuation: { mode: 'immediate', next_action: 'Inspect the remaining evidence.' } };
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

test('a later justified wake produces a new disposable execution rather than a handoff', async () => {
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

  const quiesced = await runOuterLoop({ wake: { type: 'unrelated.event', event_id: 'external-0', work_unit_id: 'wu-repeat-1' }, store, executor, isJustified: async () => false });
  assert.equal(quiesced.disposition, 'quiesced');
  assert.equal(executionIds.length, 1);

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
    executor: async () => ({ objective_id: 'objective-3', disposition: 'done', summary: 'The execution claims the outcome.', outcome_evidence: [{ kind: 'manifest', execution_id: 'seed-execution' }] }),
  });

  assert.equal(result.disposition, 'needs-review');
  assert.equal(store.snapshot().work[0].state, 'review');
  assert.equal(store.snapshot().executions.at(-1).state, 'succeeded');
});

test('terminal authorization is awaited and only exact true settles terminally', async () => {
  const store = createMemoryStore({
    workUnits: [createWorkUnit({ workUnitId: 'wu-auth-1', objectiveRef: 'objective-auth' })],
    executions: [{ execution_id: 'seed-auth', state: 'succeeded', work_unit_id: 'wu-auth-1' }],
  });
  let authorized = false;
  const result = await runOuterLoop({
    wake: { type: 'feedback.received', event_id: 'feedback-auth', work_unit_id: 'wu-auth-1' },
    store,
    executor: async () => ({ objective_id: 'objective-auth', disposition: 'done', summary: 'Evidence supports the outcome.', outcome_evidence: [{ kind: 'manifest', execution_id: 'seed-auth' }] }),
    authorizeTerminal: async () => { await new Promise((resolve) => setTimeout(resolve, 0)); authorized = true; return 1; },
  });
  assert.equal(authorized, true);
  assert.equal(result.disposition, 'needs-review');

  const terminalStore = createMemoryStore({
    workUnits: [createWorkUnit({ workUnitId: 'wu-auth-true', objectiveRef: 'objective-auth-true' })],
    executions: [{ execution_id: 'seed-auth-true', state: 'succeeded', work_unit_id: 'wu-auth-true' }],
  });
  let authorizationInput;
  const terminal = await runOuterLoop({
    wake: { type: 'feedback.received', event_id: 'feedback-auth-true', work_unit_id: 'wu-auth-true' },
    store: terminalStore,
    executor: async () => ({ objective_id: 'objective-auth-true', disposition: 'done', summary: 'independently authorized', outcome_evidence: [{ kind: 'manifest', execution_id: 'seed-auth-true' }] }),
    authorizeTerminal: async (input) => { authorizationInput = input; return true; },
  });
  assert.equal(terminal.disposition, 'terminal');
  assert.equal(authorizationInput.workUnit.objective_ref, 'objective-auth-true');
  assert.equal(authorizationInput.execution.fence, 1);
  assert.equal(authorizationInput.evidence.length, 1);

  const rejectedStore = createMemoryStore({ workUnits: [createWorkUnit({ workUnitId: 'wu-auth-reject', objectiveRef: 'objective-auth-reject' })], executions: [{ execution_id: 'seed-auth-reject', state: 'succeeded', work_unit_id: 'wu-auth-reject' }] });
  await assert.rejects(() => runOuterLoop({
    wake: { type: 'feedback.received', event_id: 'feedback-auth-reject', work_unit_id: 'wu-auth-reject' },
    store: rejectedStore,
    executor: async () => ({ objective_id: 'objective-auth-reject', disposition: 'done', summary: 'authorization fails', outcome_evidence: [{ kind: 'manifest', execution_id: 'seed-auth-reject' }] }),
    authorizeTerminal: async () => { throw new Error('authorization unavailable'); },
  }), /authorization unavailable/);
  assert.equal(rejectedStore.snapshot().work[0].state, 'actionable');
});

test('objective identity mismatch is rejected before evidence verification or settlement', async () => {
  const store = createMemoryStore({ workUnits: [createWorkUnit({ workUnitId: 'wu-identity-1', objectiveRef: 'objective-expected' })] });
  let verified = false;
  const original = store.manifest;
  store.manifest = async (...args) => { verified = true; return original(...args); };
  await assert.rejects(() => runOuterLoop({
    wake: { type: 'feedback.received', event_id: 'feedback-identity', work_unit_id: 'wu-identity-1' },
    store,
    executor: async () => ({ objective_id: 'objective-other', disposition: 'done', summary: 'Wrong objective.', outcome_evidence: [{ kind: 'manifest', execution_id: 'missing' }] }),
  }), /objective_id does not match/);
  assert.equal(verified, false);
  const snapshot = store.snapshot();
  assert.equal(snapshot.work[0].claim, null);
  assert.equal(snapshot.executions[0].state, 'failed');
});

test('concurrent wakes have a deterministic single winner at the claim barrier', async () => {
  const store = createMemoryStore({ workUnits: [createWorkUnit({ workUnitId: 'wu-barrier-1', objectiveRef: 'objective-barrier' })] });
  let entered;
  let release;
  const executionEntered = new Promise((resolve) => { entered = resolve; });
  const executionRelease = new Promise((resolve) => { release = resolve; });
  const wake = { type: 'feedback.received', event_id: 'barrier-wake', work_unit_id: 'wu-barrier-1' };
  const first = runOuterLoop({ wake, store, executor: async () => { entered(); await executionRelease; return { objective_id: 'objective-barrier', disposition: 'continue', summary: 'one turn', continuation: { mode: 'immediate', next_action: 'stop' } }; } });
  await executionEntered;
  const second = runOuterLoop({ wake: { ...wake, event_id: 'barrier-wake-2' }, store, executor: async () => { throw new Error('must not execute'); } });
  await assert.rejects(second, /work unit is already claimed|Work Unit changed before execution could be claimed/);
  release();
  await first;
  assert.equal(store.snapshot().executions.length, 1);
});

test('no reconstructed work means quiescence and no execution', async () => {
  const store = createMemoryStore();
  const result = await runOuterLoop({ wake: { type: 'feedback.received', event_id: 'feedback-4' }, store, executor: async () => { throw new Error('must not execute'); } });
  assert.deepEqual(result, { disposition: 'quiesced', reason: 'no-work' });
  assert.equal(store.snapshot().executions.length, 0);
});

test('stale execution cannot mutate after the fence advances', () => {
  const work = createWorkUnit({ workUnitId: 'wu-fence-1', objectiveRef: 'objective-4' });
  const first = claimWorkUnit(work, { executionId: 'exec-first', owner: 'body-a' });
  const firstExecution = startExecution(createExecution(first, { executionId: 'exec-first', owner: 'body-a' }));
  const second = claimWorkUnit({ ...first, claim: null, state: 'actionable' }, { executionId: 'exec-second', owner: 'body-b' });
  assert.throws(() => applyTurn(second, firstExecution, { disposition: 'continue', summary: 'stale', continuation: { mode: 'immediate', next_action: 'nope' } }), /stale execution/);
});
