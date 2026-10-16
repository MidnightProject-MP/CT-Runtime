import { acceptanceContext, validateAcceptanceDecision, digest, settlement, settlementIdentity, requirementsValue } from './operating-boundary.mjs';

export function memoryBoundary({ state, serializeTransition, acceptanceVerifier }) {
  function prior(eventId, hash) {
    const event = state.events.find(e => e.event_id === eventId);
    if (event && event.payload?.digest !== hash) throw new Error('receipt content conflict');
    return event?.payload?.result && structuredClone(event.payload.result);
  }
  function context(workId) {
    const work = state.work.get(workId);
    if (!work) throw new Error('Work Unit does not exist');
    if (state.authorities.has(work.project_id)) throw new Error('project authority is held');
    if (state.reconciliationBlocks.has(work.project_id)) throw new Error('reconciliation is required');
    const execution = state.executions.get(work.last_execution_id);
    const evidence = state.evidence.filter(e => e.work_unit_id === workId && e.execution_id === work.last_execution_id).map(e => e.evidence);
    const record = state.events.find(e => e.event_id === `handoff:${work.last_execution_id}`)?.payload?.result;
    return acceptanceContext(work, execution, evidence, work.pilot?.input_seq ?? 0, record);
  }
  return {
    async persistTurn(input) {
      const result = structuredClone(input);
      return serializeTransition(async () => {
        const id = `handoff:${result.execution.execution_id}`;
        const hash = settlementIdentity(result);
        const replay = prior(id, hash);
        if (replay) return replay;
        const work = state.work.get(result.workUnit.work_unit_id);
        const e = result.execution;
        const a = state.authorities.get(e.project_id);
        if (!work || e.work_unit_id !== work.work_unit_id || result.workUnit.project_id !== work.project_id || e.project_id !== work.project_id || !a || a.work_unit_id !== work.work_unit_id || a.execution_id !== e.execution_id || a.fence !== e.fence || a.owner !== e.owner || a.authorization_decision_ref !== e.authorization_decision_ref || work.fence !== e.fence || work.claim?.execution_id !== e.execution_id || work.claim?.owner !== e.owner || work.claim?.fence !== e.fence) throw new Error('fencing conflict while persisting turn');
        if (Date.parse(a.claim_expires_at) <= Date.now()) throw new Error('fencing conflict while persisting turn: project mutation authority expired');
        if (work.claim_expires_at !== e.claim_expires_at || a.claim_expires_at !== e.claim_expires_at) throw new Error('fencing conflict while persisting turn: execution claim expiration does not match durable claim');
        const execution = state.executions.get(e.execution_id);
        if (!execution || execution.state !== 'running') throw new Error('execution is not running');
        const derived = settlement(result, work, execution);
        const { turn } = derived;
        if (work.pilot) {
          derived.workUnit.pilot = { ...work.pilot, consumed_input_seq: execution.admission.input_seq, next_wake_at: null };
          if (work.pilot.input_seq > execution.admission.input_seq) derived.workUnit.state = 'actionable';
        }
        const proposal = turn.disposition !== 'done' ? structuredClone({ id: Math.max(0, ...state.continuations.map(p => p.id)) + 1, work_unit_id: work.work_unit_id, execution_id: e.execution_id, continuation: turn.continuation }) : null;
        const evidence = turn.outcome_evidence ? structuredClone({ work_unit_id: work.work_unit_id, execution_id: e.execution_id, evidence: turn.outcome_evidence }) : null;
        const event = structuredClone({ event_id: id, type: 'execution.settled', payload: { digest: hash, result: derived } });
        // All validation/cloning, including event collision checks, precede writes.
        state.work.set(work.work_unit_id, structuredClone(derived.workUnit));
        state.executions.set(e.execution_id, structuredClone(derived.execution));
        state.authorities.delete(work.project_id);
        if (proposal) state.continuations.push(proposal);
        if (evidence) state.evidence.push(evidence);
        state.events.push(event); state.eventIds.add(id);
        return structuredClone(derived);
      });
    },
    getAcceptanceContext(workId) { return serializeTransition(async () => context(workId)); },
    async acceptWork(workId, input) {
      const decision = structuredClone(input);
      return serializeTransition(async () => {
        if (!decision?.ref || typeof decision.ref !== 'string') throw new Error('acceptance requires an explicit decision reference');
        const id = `acceptance:${decision.ref}`;
        const hash = digest({ workId, decision });
        const replay = prior(id, hash);
        if (replay) return replay;
        if (state.work.get(workId)?.state !== 'review') throw new Error('work is not settled for acceptance');
        const current = context(workId);
        validateAcceptanceDecision(decision, current);
        if (typeof acceptanceVerifier !== 'function') throw new Error('acceptance verifier is required');
        if (await acceptanceVerifier(decision, structuredClone(current)) !== true) throw new Error('acceptance decision is not valid for this Work Unit');
        // appendEvent is an independent API and may have run while awaiting the
        // verifier. Recheck its collision before committing any state.
        const completed = prior(id, hash);
        if (completed) return completed;
        const value = { work_unit_id: workId, state: 'terminal', execution_id: current.execution_id, acceptance_ref: decision.ref, snapshotDigest: current.snapshotDigest };
        const event = structuredClone({ event_id: id, type: 'work.accepted', payload: { digest: hash, result: value } });
        state.work.set(workId, { ...current.workUnit, state: 'terminal' });
        state.events.push(event); state.eventIds.add(id);
        return value;
      });
    },
    async reviseWorkRequirements(workId, { expectedRevision, requirements }) {
      const value = requirementsValue(requirements);
      return serializeTransition(async () => {
        const work = state.work.get(workId);
        if (!work || work.work_revision !== expectedRevision) throw new Error('work revision conflict');
        state.work.set(workId, { ...work, work_revision: expectedRevision + 1, requirements: value, state: work.claim ? work.state : 'actionable',
          ...(work.pilot && !work.claim ? { pilot: { ...work.pilot, next_wake_at: new Date().toISOString() } } : {}) });
        return { work_revision: expectedRevision + 1, requirements: value };
      });
    },
  };
}
