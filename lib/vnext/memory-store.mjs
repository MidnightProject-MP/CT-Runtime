// Deterministic reference store for the vNext outer-loop proof.
// It is intentionally not a production persistence adapter. The production
// adapter implements the same tiny port over Neon/Postgres.

export function createMemoryStore({ workUnits = [], executions = [] } = {}) {
  const state = {
    work: new Map(workUnits.map((work) => [work.work_unit_id, structuredClone(work)])),
    executions: new Map(executions.map((execution) => [execution.execution_id, structuredClone(execution)])),
    events: [],
    eventIds: new Set(),
    evidence: [],
    continuations: [],
    settlements: new Map(),
  };

  return {
    async appendEvent(event) {
      if (!event?.event_id) throw new Error('event.event_id is required');
      if (state.eventIds.has(event.event_id)) {
        const receipt = state.events.find((item) => item.event_id === event.event_id);
        const original = { ...receipt }; delete original.processing_status; delete original.processing_execution_id;
        if (original.type !== event.type || JSON.stringify(original) !== JSON.stringify(event)) throw new Error('event identity conflict');
        return { ...event, consumed: false, receipt: structuredClone(receipt) };
      }
      state.eventIds.add(event.event_id); state.events.push({ ...structuredClone(event), processing_status: 'received', processing_execution_id: null });
      return { ...event, consumed: true, receipt: structuredClone(state.events.at(-1)) };
    },
    async markEventProcessing({ eventId, executionId, completed = false } = {}) {
      const event = state.events.find((item) => item.event_id === eventId);
      if (!event) return { status: 'missing' };
      if (event.processing_status === 'completed') return { status: 'completed', execution_id: event.processing_execution_id };
      event.processing_status = completed ? 'completed' : 'processing'; event.processing_execution_id = executionId;
      return { status: event.processing_status, execution_id: executionId };
    },
    async discoverUnprocessedEvents({ limit = 100 } = {}) {
      return structuredClone(state.events.filter((event) => event.processing_status !== 'completed').slice(0, limit));
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
      const current = state.work.get(workUnit.work_unit_id);
      if (!current) throw new Error('Work Unit does not exist');
      const expired = current.claim?.claim_expires_at && new Date(current.claim.claim_expires_at).getTime() <= Date.now();
      if (!['actionable', 'waiting'].includes(current.state) || (current.claim && !expired) || current.fence !== execution.fence - 1) throw new Error('Work Unit changed before execution could be claimed');
      if (state.executions.has(execution.execution_id)) throw new Error(`duplicate execution: ${execution.execution_id}`);
      const claimed = { ...workUnit, state: 'actionable', fence: execution.fence, claim: { execution_id: execution.execution_id, owner: execution.owner, fence: execution.fence, claim_expires_at: execution.claim_expires_at }, claim_expires_at: execution.claim_expires_at, attempt: execution.attempt };
      if (expired) state.executions.set(current.claim.execution_id, { ...(state.executions.get(current.claim.execution_id) || {}), state: 'expired', finished_at: new Date().toISOString() });
      state.work.set(workUnit.work_unit_id, structuredClone(claimed));
      state.executions.set(execution.execution_id, structuredClone(execution));
      return { workUnit: structuredClone(claimed), execution: structuredClone(execution) };
    },
    async recoverExpiredClaims({ now = new Date(), limit = 100 } = {}) {
      const recovered = [];
      for (const current of state.work.values()) {
        if (recovered.length >= limit) break;
        const claim = current.claim;
        if (!claim || !claim.claim_expires_at || new Date(claim.claim_expires_at).getTime() > new Date(now).getTime()) continue;
        const execution = state.executions.get(claim.execution_id);
        if (!execution || !['created', 'running'].includes(execution.state)) continue;
        const expiredAt = new Date(now).toISOString();
        state.executions.set(claim.execution_id, { ...execution, state: 'expired', finished_at: expiredAt });
        recovered.push({ work_unit_id: current.work_unit_id, execution_id: claim.execution_id, fence: current.fence, expired_at: expiredAt });
      }
      return structuredClone(recovered);
    },
    async persistTurn(result) {
      const { workUnit, execution, turn } = result;
      const current = state.work.get(workUnit.work_unit_id);
      if (!current || current.fence !== execution.fence || current.claim?.execution_id !== execution.execution_id || current.claim.owner !== execution.owner) throw new Error('fencing conflict while persisting turn');
      const storedExecution = state.executions.get(execution.execution_id);
      if (!storedExecution || storedExecution.state !== 'running') throw new Error('execution is not running');
      state.executions.set(execution.execution_id, structuredClone(execution));
      if (turn.disposition !== 'done') state.continuations.push({ work_unit_id: workUnit.work_unit_id, execution_id: execution.execution_id, continuation: structuredClone(turn.continuation) });
      if (turn.outcome_evidence) state.evidence.push({ work_unit_id: workUnit.work_unit_id, execution_id: execution.execution_id, evidence: structuredClone(turn.outcome_evidence) });
      if (result.settlement?.event_id) state.settlements.set(execution.execution_id, structuredClone(result));
      state.work.set(workUnit.work_unit_id, structuredClone(workUnit));
      return structuredClone(result);
    },
    async readbackSettlement({ workUnitId, executionId, eventId, fence, owner } = {}) {
      const result = state.settlements.get(executionId);
      if (result && (!workUnitId || result.workUnit.work_unit_id === workUnitId) && (!eventId || result.settlement?.event_id === eventId) && (fence == null || result.execution.fence === fence)) return { status: 'committed', committed: true, ...structuredClone(result) };
      const execution = state.executions.get(executionId);
      const work = workUnitId && state.work.get(workUnitId);
      if (execution?.state === 'running' && execution.fence === fence && (!owner || execution.owner === owner) && work?.claim?.execution_id === executionId) return { status: 'same-authority-active', committed: false };
      if (execution && (execution.fence !== fence || work?.fence > fence || work?.claim?.execution_id !== executionId)) return { status: 'superseded', committed: false };
      return { status: 'definitively-uncommitted', committed: false };
    },
    async persistFailure(failed) {
      const { workUnit, execution } = failed;
      const current = state.work.get(workUnit.work_unit_id);
      const storedExecution = state.executions.get(execution.execution_id);
      if (!current || current.fence !== execution.fence || current.claim?.execution_id !== execution.execution_id || current.claim?.owner !== execution.owner || current.claim?.fence !== execution.fence || !storedExecution || !['created', 'running'].includes(storedExecution.state)) throw new Error('fencing conflict while persisting failure');
      state.executions.set(execution.execution_id, structuredClone(execution));
       state.work.set(workUnit.work_unit_id, structuredClone(workUnit));
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
        events: state.events,
        evidence: state.evidence,
        continuations: state.continuations,
        settlements: [...state.settlements.values()],
      });
    },
  };
}
