import { eventIntegrityConflict, eventsEquivalent } from './event-integrity.mjs';

// Deterministic reference store for the vNext outer-loop proof.
// It is intentionally not a production persistence adapter. The production
// adapter implements the same tiny port over Neon/Postgres.

export function createMemoryStore({ workUnits = [], executions = [], authorities = null } = {}) {
  const work = new Map(workUnits.map((item) => [item.work_unit_id, structuredClone(item)]));
  const executionMap = new Map(executions.map((item) => [item.execution_id, structuredClone(item)]));
  const derivedAuthorities = new Map();

  for (const workUnit of work.values()) {
    const claim = workUnit.claim;
    if (!claim?.execution_id) continue;
    const execution = executionMap.get(claim.execution_id);
    if (!execution) throw new Error(`invalid reconstructed authority: missing execution ${claim.execution_id}`);
    if (execution.work_unit_id !== workUnit.work_unit_id || execution.project_id !== workUnit.project_id || execution.fence !== claim.fence || execution.owner !== claim.owner || !['created', 'running'].includes(execution.state)) {
      throw new Error(`invalid reconstructed authority: execution ${claim.execution_id} does not match Work Unit claim`);
    }
    if (execution.claim_expires_at !== claim.claim_expires_at || workUnit.claim_expires_at !== claim.claim_expires_at) {
      throw new Error(`invalid reconstructed authority: execution ${claim.execution_id} claim expiration does not match Work Unit claim`);
    }
    if (derivedAuthorities.has(workUnit.project_id)) throw new Error(`ambiguous reconstructed authority for project ${workUnit.project_id}`);
    derivedAuthorities.set(workUnit.project_id, {
      project_id: workUnit.project_id,
      work_unit_id: workUnit.work_unit_id,
      execution_id: execution.execution_id,
      fence: execution.fence,
      owner: execution.owner,
      claim_expires_at: claim.claim_expires_at,
    });
  }

  if (authorities !== null) {
    const supplied = new Map(authorities.map((item) => [item.project_id, structuredClone(item)]));
    if (supplied.size !== authorities.length) throw new Error('invalid reconstructed authority: duplicate project authority');
    if (supplied.size !== derivedAuthorities.size) throw new Error('invalid reconstructed authority: authority set does not match Work Unit claims');
    for (const [projectId, derived] of derivedAuthorities) {
      const suppliedAuthority = supplied.get(projectId);
      if (!suppliedAuthority || JSON.stringify(suppliedAuthority) !== JSON.stringify(derived)) {
        throw new Error(`invalid reconstructed authority for project ${projectId}`);
      }
    }
  }

  const state = {
    work,
    executions: executionMap,
    authorities: derivedAuthorities,
    events: [],
    eventIds: new Set(),
    evidence: [],
    continuations: [],
  };

  return {
    async appendEvent(event) {
      if (!event?.event_id) throw new Error('event.event_id is required');
      const existing = state.events.find((item) => item.event_id === event.event_id);
      if (existing) {
        if (!eventsEquivalent(existing, event)) throw eventIntegrityConflict(event, existing);
        return { ...event, consumed: false };
      }
      state.eventIds.add(event.event_id); state.events.push(structuredClone(event));
      return { ...event, consumed: true };
    },
    async reconstruct(event) {
      if (event.work_unit_id && state.work.has(event.work_unit_id)) return structuredClone(state.work.get(event.work_unit_id));
      if (event.feedback?.work_unit_id && state.work.has(event.feedback.work_unit_id)) return structuredClone(state.work.get(event.feedback.work_unit_id));
      return null;
    },
    async saveWorkUnit(workUnit) {
      state.work.set(workUnit.work_unit_id, structuredClone(workUnit));
      return structuredClone(workUnit);
    },
    async beginExecution(workUnit, execution) {
      if (execution.work_unit_id !== workUnit.work_unit_id) throw new Error('execution belongs to a different Work Unit');
      if (execution.project_id !== workUnit.project_id) throw new Error('execution belongs to a different project');
      const current = state.work.get(workUnit.work_unit_id);
      if (!current) throw new Error('Work Unit does not exist');
      if (current.project_id !== execution.project_id) throw new Error('execution belongs to a different stored project');
      const now = Date.now();
      const expiredClaim = current.claim?.claim_expires_at && new Date(current.claim.claim_expires_at).getTime() <= now;
      if (current.claim && !expiredClaim && current.claim.claim_expires_at !== execution.claim_expires_at) throw new Error('execution claim expiration does not match Work Unit claim');
      const authority = state.authorities.get(execution.project_id);
      const expiredAuthority = authority?.claim_expires_at && new Date(authority.claim_expires_at).getTime() <= now;
      if (authority && !expiredAuthority) throw new Error('E_PROJECT_AUTH_HELD: project mutation authority is already held');
      if (!['actionable', 'waiting'].includes(current.state) || (current.claim && !expiredClaim) || current.fence !== execution.fence - 1) throw new Error('Work Unit changed before execution could be claimed');
      if (state.executions.has(execution.execution_id)) throw new Error(`duplicate execution: ${execution.execution_id}`);

      if (expiredAuthority) {
        const previous = state.executions.get(authority.execution_id);
        if (previous && ['created', 'running'].includes(previous.state)) {
          state.executions.set(authority.execution_id, { ...previous, state: 'expired', finished_at: new Date().toISOString() });
        }
        const previousWork = state.work.get(authority.work_unit_id);
        if (previousWork?.claim?.execution_id === authority.execution_id && previousWork?.claim?.fence === authority.fence) {
          state.work.set(authority.work_unit_id, { ...previousWork, state: 'waiting', claim: null, claim_expires_at: null, retry_after: null });
        }
        state.authorities.delete(execution.project_id);
      }

      const claimed = { ...workUnit, state: 'actionable', fence: execution.fence, claim: { execution_id: execution.execution_id, owner: execution.owner, fence: execution.fence, claim_expires_at: execution.claim_expires_at }, claim_expires_at: execution.claim_expires_at, attempt: execution.attempt };
      if (expiredClaim && current.claim && current.claim.execution_id !== authority?.execution_id) {
        const previous = state.executions.get(current.claim.execution_id);
        if (previous && ['created', 'running'].includes(previous.state)) state.executions.set(current.claim.execution_id, { ...previous, state: 'expired', finished_at: new Date().toISOString() });
      }
      state.work.set(workUnit.work_unit_id, structuredClone(claimed));
      state.executions.set(execution.execution_id, structuredClone(execution));
      state.authorities.set(execution.project_id, { project_id: execution.project_id, work_unit_id: workUnit.work_unit_id, execution_id: execution.execution_id, fence: execution.fence, owner: execution.owner, claim_expires_at: execution.claim_expires_at });
      return { workUnit: structuredClone(claimed), execution: structuredClone(execution) };
    },
    async persistTurn(result) {
      const { workUnit, execution, turn } = result;
      if (execution.work_unit_id !== workUnit.work_unit_id) throw new Error('execution belongs to a different Work Unit');
      if (execution.project_id !== workUnit.project_id) throw new Error('execution belongs to a different project');
      const current = state.work.get(workUnit.work_unit_id);
      const authority = state.authorities.get(execution.project_id);
      if (!current || !authority || authority.work_unit_id !== workUnit.work_unit_id || authority.execution_id !== execution.execution_id || authority.fence !== execution.fence || authority.owner !== execution.owner || current.fence !== execution.fence || current.claim?.execution_id !== execution.execution_id || current.claim.owner !== execution.owner || current.claim.fence !== execution.fence) throw new Error('fencing conflict while persisting turn');
      if (new Date(authority.claim_expires_at).getTime() <= Date.now()) throw new Error('fencing conflict while persisting turn: project mutation authority expired');
      if (current.claim_expires_at !== execution.claim_expires_at || authority.claim_expires_at !== execution.claim_expires_at) throw new Error('fencing conflict while persisting turn: execution claim expiration does not match durable claim');
      const storedExecution = state.executions.get(execution.execution_id);
      if (!storedExecution || storedExecution.work_unit_id !== workUnit.work_unit_id || storedExecution.project_id !== workUnit.project_id || storedExecution.owner !== execution.owner || storedExecution.fence !== execution.fence || storedExecution.state !== 'running') throw new Error('execution is not running');
      state.executions.set(execution.execution_id, structuredClone(execution));
      if (turn.disposition !== 'done') state.continuations.push({ work_unit_id: workUnit.work_unit_id, execution_id: execution.execution_id, continuation: structuredClone(turn.continuation) });
      if (turn.outcome_evidence) state.evidence.push({ work_unit_id: workUnit.work_unit_id, execution_id: execution.execution_id, evidence: structuredClone(turn.outcome_evidence) });
      state.work.set(workUnit.work_unit_id, structuredClone(workUnit));
      state.authorities.delete(execution.project_id);
      return structuredClone(result);
    },
    async persistFailure(failed) {
      const { workUnit, execution } = failed;
      if (execution.work_unit_id !== workUnit.work_unit_id) throw new Error('execution belongs to a different Work Unit');
      if (execution.project_id !== workUnit.project_id) throw new Error('execution belongs to a different project');
      const current = state.work.get(workUnit.work_unit_id);
      const authority = state.authorities.get(execution.project_id);
      const storedExecution = state.executions.get(execution.execution_id);
      if (!current || !authority || authority.work_unit_id !== workUnit.work_unit_id || authority.execution_id !== execution.execution_id || authority.fence !== execution.fence || authority.owner !== execution.owner || current.fence !== execution.fence || current.claim?.execution_id !== execution.execution_id || current.claim?.owner !== execution.owner || current.claim?.fence !== execution.fence || !storedExecution || storedExecution.work_unit_id !== workUnit.work_unit_id || storedExecution.project_id !== workUnit.project_id || storedExecution.owner !== execution.owner || storedExecution.fence !== execution.fence || !['created', 'running'].includes(storedExecution.state)) throw new Error('fencing conflict while persisting failure');
      if (new Date(authority.claim_expires_at).getTime() <= Date.now()) throw new Error('fencing conflict while persisting failure: project mutation authority expired');
      if (current.claim_expires_at !== execution.claim_expires_at || authority.claim_expires_at !== execution.claim_expires_at) throw new Error('fencing conflict while persisting failure: execution claim expiration does not match durable claim');
      state.executions.set(execution.execution_id, structuredClone(execution));
      state.work.set(workUnit.work_unit_id, structuredClone(workUnit));
      state.authorities.delete(execution.project_id);
      return structuredClone(failed);
    },
    async createExecution(execution) {
      if (state.executions.has(execution.execution_id)) throw new Error(`duplicate execution: ${execution.execution_id}`);
      state.executions.set(execution.execution_id, structuredClone(execution));
      return structuredClone(execution);
    },
    async finishExecution(execution) {
      state.executions.set(execution.execution_id, structuredClone(execution));
      return structuredClone(execution);
    },
    async manifest(executionId) {
      const execution = state.executions.get(executionId);
      return execution ? { execution: { status: execution.state === 'succeeded' ? 'success' : execution.state } } : null;
    },
    async appendContinuation(workUnitId, executionId, continuation) {
      const row = { work_unit_id: workUnitId, execution_id: executionId, continuation: structuredClone(continuation) };
      state.continuations.push(row);
      return row;
    },
    async appendEvidence(workUnitId, executionId, evidence) {
      const row = { work_unit_id: workUnitId, execution_id: executionId, evidence: structuredClone(evidence) };
      state.evidence.push(row);
      return row;
    },
    snapshot() {
      return structuredClone({
        work: [...state.work.values()],
        executions: [...state.executions.values()],
        authorities: [...state.authorities.values()],
        events: state.events,
        evidence: state.evidence,
        continuations: state.continuations,
      });
    },
  };
}
