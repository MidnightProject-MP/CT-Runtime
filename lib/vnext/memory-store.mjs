// Deterministic reference store for the vNext outer-loop proof.
// It is intentionally not a production persistence adapter. The production
// adapter can later implement the same tiny port over Neon/Postgres.

export function createMemoryStore({ workUnits = [] } = {}) {
  const state = {
    work: new Map(workUnits.map((work) => [work.work_unit_id, structuredClone(work)])),
    executions: new Map(),
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
