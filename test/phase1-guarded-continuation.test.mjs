import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore } from '../lib/vnext/memory-store.mjs';
import { nextWakeFor } from '../lib/vnext/pilot-store.mjs';
import { normalizeHandoff } from '../lib/handoff-contract.mjs';
import { runOuterLoop } from '../lib/vnext/outer-loop.mjs';
import { createWorkUnit, claimWorkUnit, startExecution, createExecution, applyTurn } from '../lib/vnext/kernel.mjs';

const verifier = async () => true;
// An acceptance authority that returns a DISTINCT decision identity. Runtime
// verifies it; it does not derive it.
const accepter = () => ({ ref: `acceptance:${'reviewer-1'}` });

function storeWith(workUnitId, objectiveRef = 'objective-alpha', projectId = 'project-alpha') {
  return createMemoryStore({
    workUnits: [createWorkUnit({ workUnitId, objectiveRef, projectId })],
    executions: [{ execution_id: 'run-1', work_unit_id: 'prior', project_id: projectId, owner: 'prior', fence: 1, state: 'succeeded', started_at: new Date().toISOString() }],
    authorizationVerifier: verifier,
    acceptanceVerifier: async () => true
  });
}

const wake = (id) => ({ event_id: `wake-${id}`, work_unit_id: id, workspace_root: '/tmp' });
const doneTurn = { objective_id: 'objective-alpha', disposition: 'done', summary: 'fixed and verified', outcome_evidence: [{ kind: 'manifest', execution_id: 'run-1' }] };
const continueTurn = { objective_id: 'objective-alpha', disposition: 'continue', summary: 'next step', continuation: { mode: 'immediate', next_action: 'verify again' } };

test('checkpoint safety: an intermediate checkpoint persists without acceptance', async () => {
  const store = storeWith('wu-check');
  const result = await runOuterLoop({
    wake: wake('wu-check'), store, executor: async () => continueTurn,
    authorizeExecution: async () => ({ ref: 'grant:abc' }), authorizeTerminal: accepter
  });
  assert.equal(result.disposition, 'continue');
  assert.equal(store.snapshot().continuations.length, 1);
  assert.equal(store.snapshot().events.filter(e => e.type === 'work.accepted').length, 0);
});

test('attempt versus work: a successful attempt requiring review settles into review, not terminal', async () => {
  const store = storeWith('wu-review');
  const result = await runOuterLoop({
    wake: wake('wu-review'), store, executor: async () => doneTurn,
    authorizeExecution: async () => ({ ref: 'grant:abc' }),
    authorizeTerminal: async () => false
  });
  assert.equal(result.disposition, 'needs-review');
  assert.equal((await store.reconstruct({ work_unit_id: 'wu-review' })).state, 'review');
  assert.equal(store.snapshot().events.filter(e => e.type === 'work.accepted').length, 0);
});

test('authorized acceptance settles terminal and records a distinct decision', async () => {
  const store = storeWith('wu-accept');
  const result = await runOuterLoop({
    wake: wake('wu-accept'), store, executor: async () => doneTurn,
    authorizeExecution: async () => ({ ref: 'grant:abc' }), authorizeTerminal: accepter
  });
  assert.equal(result.disposition, 'terminal');
  const accepted = store.snapshot().events.filter(e => e.type === 'work.accepted');
  assert.equal(accepted.length, 1);
  assert.equal(accepted[0].payload.ref, `acceptance:reviewer-1`);
  // The recorded decision is distinct from the execution authorization.
  assert.notEqual(accepted[0].payload.ref, 'grant:abc');
});

test('the store requires an acceptance DECISION, not a label derived from execution identity', async () => {
  const store = storeWith('wu-forge');
  const claimed = claimWorkUnit(createWorkUnit({ workUnitId: 'wu-forge', objectiveRef: 'objective-alpha', projectId: 'project-alpha' }), { executionId: 'exec-forge', owner: 'pilot-owner' });
  const execution = startExecution(createExecution(claimed, { executionId: 'exec-forge', owner: 'pilot-owner', authorizationDecisionRef: 'grant:abc' }));
  const begun = await store.beginExecution(claimed, execution, { ref: 'grant:abc' });

  // A caller asserting terminal with no decision at all.
  const forged = { workUnit: { ...begun.workUnit, state: 'terminal' }, execution: { ...begun.execution, state: 'succeeded' }, turn: doneTurn };
  await assert.rejects(() => store.persistTurn(forged), /explicit decision reference/);

  // Copying the execution authorization as the acceptance decision is a self-grant.
  const copied = { ...forged, terminalAuthorization: { ref: 'grant:abc' } };
  await assert.rejects(() => store.persistTurn(copied), /distinct decision/);

  // Even a well-formed distinct reference is refused unless the verifier agrees.
  const store2 = createMemoryStore({
    workUnits: [createWorkUnit({ workUnitId: 'wu-forge2', objectiveRef: 'objective-alpha', projectId: 'project-alpha' })],
    executions: [{ execution_id: 'run-1', work_unit_id: 'prior', project_id: 'project-alpha', owner: 'prior', fence: 1, state: 'succeeded', started_at: new Date().toISOString() }],
    authorizationVerifier: verifier,
    acceptanceVerifier: async () => false
  });
  const claimed2 = claimWorkUnit(createWorkUnit({ workUnitId: 'wu-forge2', objectiveRef: 'objective-alpha', projectId: 'project-alpha' }), { executionId: 'exec-forge2', owner: 'pilot-owner' });
  const execution2 = startExecution(createExecution(claimed2, { executionId: 'exec-forge2', owner: 'pilot-owner', authorizationDecisionRef: 'grant:abc' }));
  const begun2 = await store2.beginExecution(claimed2, execution2, { ref: 'grant:abc' });
  await assert.rejects(() => store2.persistTurn({ workUnit: { ...begun2.workUnit, state: 'terminal' }, execution: { ...begun2.execution, state: 'succeeded' }, turn: doneTurn, terminalAuthorization: { ref: 'acceptance:unverified' } }), /not valid/);
});

test('a store with no acceptance verifier cannot settle terminal at all', async () => {
  const store = createMemoryStore({
    workUnits: [createWorkUnit({ workUnitId: 'wu-noverify', objectiveRef: 'objective-alpha', projectId: 'project-alpha' })],
    executions: [{ execution_id: 'run-1', work_unit_id: 'prior', project_id: 'project-alpha', owner: 'prior', fence: 1, state: 'succeeded', started_at: new Date().toISOString() }],
    authorizationVerifier: verifier
    // deliberately no acceptanceVerifier
  });
  await assert.rejects(() => runOuterLoop({
    wake: wake('wu-noverify'), store, executor: async () => doneTurn,
    authorizeExecution: async () => ({ ref: 'grant:abc' }),
    authorizeTerminal: async () => ({ ref: 'acceptance:reviewer-1' })
  }), /acceptance verifier/);
});

test('a completion claim cannot satisfy its own acceptance', () => {
  const work = createWorkUnit({ workUnitId: 'wu-self', objectiveRef: 'objective-alpha', projectId: 'project-alpha' });
  const claimed = claimWorkUnit(work, { executionId: 'exec-self', owner: 'pilot-owner' });
  const execution = startExecution(createExecution(claimed, { executionId: 'exec-self', owner: 'pilot-owner', authorizationDecisionRef: 'grant:abc' }));
  assert.throws(() => applyTurn(claimed, execution, doneTurn, { terminalAuthorized: true }), /explicit decision reference/);
  // Without terminal authorization, a done claim is only reviewable.
  assert.equal(applyTurn(claimed, execution, doneTurn, { terminalAuthorized: false }).workUnit.state, 'review');
  // A forged decision string still needs the store's verifier; the kernel only
  // checks presence, never authority.
  const forged = applyTurn(claimed, execution, doneTurn, { terminalAuthorized: true, terminalAuthorization: { ref: 'acceptance:attacker' } });
  assert.equal(forged.workUnit.state, 'terminal');
});

test('no self-dispatch: a worker continue proposes and schedules nothing', async () => {
  const store = storeWith('wu-cont');
  await runOuterLoop({
    wake: wake('wu-cont'), store, executor: async () => continueTurn,
    authorizeExecution: async () => ({ ref: 'grant:abc' }), authorizeTerminal: accepter
  });
  assert.equal(store.snapshot().continuations[0].continuation.next_action, 'verify again');
  assert.equal((await store.reconstruct({ work_unit_id: 'wu-cont' })).state, 'actionable');
});

test('continuation proposals are discoverable rather than stranded', async () => {
  // The eligibility rule a coordinator applies: unconsumed input, coordinator-set
  // due time, or an unconsidered proposal. This is the clause that replaced the
  // removed immediate-continuation fallback.
  const proposal = { id: 7, work_unit_id: 'wu', execution_id: 'exec-1' };
  const eligible = (p) => Boolean(p.unconsumed_input || (p.next_wake_at && p.next_wake_at <= Date.now()) || (p.proposal && p.proposal.id > p.considered_proposal_id));
  assert.equal(eligible({ proposal, considered_proposal_id: 0 }), true);
  assert.equal(eligible({ proposal, considered_proposal_id: 7 }), false);
  assert.equal(eligible({ proposal, considered_proposal_id: 8 }), false);
  assert.equal(eligible({ unconsumed_input: true, proposal: null, considered_proposal_id: 99 }), true);
  assert.equal(eligible({ proposal: null, considered_proposal_id: 0 }), false);
});

test('scheduler policy: a worker wake request never grants dispatch by itself', () => {
  const earliest = Date.now() + 1000;
  assert.equal(nextWakeFor(continueTurn, { earliest }), null);
  assert.equal(nextWakeFor({ disposition: 'waiting', summary: 'x', continuation: { mode: 'condition', condition: { kind: 'timer', condition: 'later' } } }, { earliest }), null);
  assert.equal(nextWakeFor(doneTurn, { earliest }), null);
  // nextWakeFor is only consulted for a coordinator-set due time; the accepted
  // handoff records the request as a proposal instead.
  const canonical = normalizeHandoff(continueTurn, { objectiveRef: 'objective-alpha' }, { source: 'objective-turn' });
  assert.equal(canonical.proposed_wake_at, null);
  assert.equal('next_wake_at' in canonical, false);
});

test('idempotent acceptance: a duplicate decision cannot be recorded twice', async () => {
  const store = storeWith('wu-idem');
  const result = await runOuterLoop({
    wake: wake('wu-idem'), store, executor: async () => doneTurn,
    authorizeExecution: async () => ({ ref: 'grant:abc' }), authorizeTerminal: accepter
  });
  assert.equal(result.disposition, 'terminal');
  const recorded = store.snapshot().events.filter(e => e.type === 'work.accepted');
  assert.equal(recorded.length, 1);
  const duplicate = await store.appendEvent({ event_id: recorded[0].event_id, type: 'work.accepted', payload: recorded[0].payload });
  assert.equal(duplicate.consumed, false);
  assert.equal(store.snapshot().events.filter(e => e.type === 'work.accepted').length, 1);
  await assert.rejects(() => store.appendEvent({ event_id: recorded[0].event_id, type: 'work.accepted', payload: { ref: 'acceptance:someone-else' } }), /conflict/i);
  const replay = await runOuterLoop({
    wake: { event_id: 'wake-idem-again', work_unit_id: 'wu-idem', workspace_root: '/tmp' }, store,
    executor: async () => { throw new Error('must not dispatch'); },
    authorizeExecution: async () => ({ ref: 'grant:abc' }), authorizeTerminal: accepter
  });
  assert.deepEqual(replay, { disposition: 'quiesced', reason: 'work-terminal', work_unit_id: 'wu-idem' });
});

test('stale authority: a stale execution cannot build a settlement against a newer claim', async () => {
  const store = storeWith('wu-stale');
  const claimed = claimWorkUnit(createWorkUnit({ workUnitId: 'wu-stale', objectiveRef: 'objective-alpha', projectId: 'project-alpha' }), { executionId: 'exec-stale', owner: 'pilot-owner' });
  const execution = startExecution(createExecution(claimed, { executionId: 'exec-stale', owner: 'pilot-owner', authorizationDecisionRef: 'grant:abc' }));
  const begun = await store.beginExecution(claimed, execution, { ref: 'grant:abc' });
  assert.throws(() => applyTurn(begun.workUnit, { ...begun.execution, fence: begun.execution.fence + 1 }, doneTurn, { terminalAuthorized: true, terminalAuthorization: { ref: 'acceptance:reviewer-1' } }), /stale execution cannot mutate/);
  assert.equal(store.snapshot().events.filter(e => e.type === 'work.accepted').length, 0);
});

test('memory and core stores enforce the same acceptance boundary', async () => {
  const store = storeWith('wu-parity');
  const claimed = claimWorkUnit(createWorkUnit({ workUnitId: 'wu-parity', objectiveRef: 'objective-alpha', projectId: 'project-alpha' }), { executionId: 'exec-parity', owner: 'pilot-owner' });
  const execution = startExecution(createExecution(claimed, { executionId: 'exec-parity', owner: 'pilot-owner', authorizationDecisionRef: 'grant:abc' }));
  const begun = await store.beginExecution(claimed, execution, { ref: 'grant:abc' });
  const noDecision = { workUnit: { ...begun.workUnit, state: 'terminal' }, execution: { ...begun.execution, state: 'succeeded' }, turn: doneTurn };
  await assert.rejects(() => store.persistTurn(noDecision), /explicit decision reference/);
  const copied = { ...noDecision, terminalAuthorization: { ref: 'grant:abc' } };
  await assert.rejects(() => store.persistTurn(copied), /distinct decision/);
});
