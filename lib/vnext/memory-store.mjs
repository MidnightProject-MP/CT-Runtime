// Deterministic reference store for the vNext outer-loop proof.
// It is intentionally not a production persistence adapter. The production
// adapter implements the same tiny port over Neon/Postgres.

export function createMemoryStore({ workUnits = [], executions = [] } = {}) {
  const state = {
    work: new Map(workUnits.map((work) => [work.work_unit_id, structuredClone(work)])),
    executions: new Map(executions.map((execution) => [execution.execution_id, structuredClone(execution)])),
    events: [],
    evidence: [],
    continuations: [],
  };

  return {
    async appendEvent(event) {
      state.events.push(structuredClone(event));
      return event;
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
      if (!['actionable', 'waiting'].includes(current.state) || current.claim || current.fence !== execution.fence - 1) throw new Error('Work Unit changed before execution could be claimed');
      if (state.executions.has(execution.execution_id)) throw new Error(`duplicate execution: ${execution.execution_id}`);
      const claimed = { ...workUnit, state: 'actionable', fence: execution.fence, claim: { execution_id: execution.execution_id, owner: execution.owner, fence: execution.fence } };
      state.work.set(workUnit.work_unit_id, structuredClone(claimed));
      state.executions.set(execution.execution_id, structuredClone(execution));
      return { workUnit: structuredClone(claimed), execution: structuredClone(execution) };
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
      state.work.set(workUnit.work_unit_id, structuredClone(workUnit));
      return structuredClone(result);
    },
    async persistFailure(failed) {
      const { workUnit, execution } = failed;
      const current = state.work.get(workUnit.work_unit_id);
      if (!current || current.fence !== execution.fence || current.claim?.execution_id !== execution.execution_id) throw new Error('fencing conflict while persisting failure');
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
      });
    },
  };
}
