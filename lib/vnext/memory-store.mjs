import { eventIntegrityConflict, eventsEquivalent } from './event-integrity.mjs';
import { memoryBoundary } from './memory-boundary.mjs';
import { admissionContext, baselineRequirements } from './operating-boundary.mjs';

// Deterministic reference store for the vNext outer-loop proof.
// It is intentionally not a production persistence adapter. The production
// adapter implements the same tiny port over Neon/Postgres.

export function createMemoryStore({ workUnits = [], executions = [], authorities = null, reconciliationBlocks = null, events = [], evidence = [], continuations = [], authorizationVerifier = null, acceptanceVerifier = null, pilotIntervalMs = 60000 } = {}) {
  const work = new Map(workUnits.map((item) => [item.work_unit_id, structuredClone({ work_revision: 1, requirements: baselineRequirements, ...item })]));
  const executionMap = new Map(executions.map((item) => [item.execution_id, structuredClone(item)]));
  const suppliedReconciliationBlocks = new Map((reconciliationBlocks || []).map((item) => [item.project_id, structuredClone(item)]));
  if (suppliedReconciliationBlocks.size !== (reconciliationBlocks || []).length) throw new Error('invalid reconstructed reconciliation block: duplicate project block');
  for (const block of suppliedReconciliationBlocks.values()) {
    const execution = executionMap.get(block.execution_id);
    const workUnit = work.get(block.work_unit_id);
    if (!execution || !workUnit || block.project_id !== workUnit.project_id || execution.work_unit_id !== workUnit.work_unit_id || execution.project_id !== block.project_id || execution.fence !== block.fence || execution.state !== 'failed' || execution.failure?.reconciliation_required !== true || workUnit.state !== 'review' || workUnit.last_execution_id !== execution.execution_id) {
      throw new Error(`invalid reconstructed reconciliation block for project ${block.project_id}`);
    }
  }
  const derivedAuthorities = new Map();

  for (const workUnit of work.values()) {
    const claim = workUnit.claim;
    if (!claim?.execution_id) continue;
    const execution = executionMap.get(claim.execution_id);
    if (!execution) throw new Error(`invalid reconstructed authority: missing execution ${claim.execution_id}`);
    const claimExpired = claim.claim_expires_at && new Date(claim.claim_expires_at).getTime() <= Date.now();
    const legacyHistoricalExecution = claimExpired && execution.authorization_decision_ref == null;
    if (execution.work_unit_id !== workUnit.work_unit_id || execution.project_id !== workUnit.project_id || (!execution.authorization_decision_ref && !legacyHistoricalExecution) || execution.fence !== claim.fence || execution.owner !== claim.owner || (!legacyHistoricalExecution && !['created', 'running'].includes(execution.state))) {
      throw new Error(`invalid reconstructed authority: execution ${claim.execution_id} does not match Work Unit claim`);
    }
    // An expired pre-A8 claim with no decision reference is historical state,
    // not current mutation authority. Preserve it for inspection/recovery, but
    // do not reconstruct an authority from it.
    if (execution.claim_expires_at !== claim.claim_expires_at || workUnit.claim_expires_at !== claim.claim_expires_at) {
      throw new Error(`invalid reconstructed authority: execution ${claim.execution_id} claim expiration does not match Work Unit claim`);
    }
    if (legacyHistoricalExecution) continue;
    if (derivedAuthorities.has(workUnit.project_id)) throw new Error(`ambiguous reconstructed authority for project ${workUnit.project_id}`);
    derivedAuthorities.set(workUnit.project_id, {
      project_id: workUnit.project_id,
      work_unit_id: workUnit.work_unit_id,
      execution_id: execution.execution_id,
      fence: execution.fence,
      owner: execution.owner,
      claim_expires_at: claim.claim_expires_at,
      authorization_decision_ref: execution.authorization_decision_ref,
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

  let transitionTail = Promise.resolve();
  const serializeTransition = async (operation) => {
    const previous = transitionTail;
    let release;
    transitionTail = new Promise((resolve) => { release = resolve; });
    await previous;
    try { return await operation(); } finally { release(); }
  };

  const state = {
    work,
    executions: executionMap,
    authorities: derivedAuthorities,
    reconciliationBlocks: suppliedReconciliationBlocks,
    events: structuredClone(events),
    eventIds: new Set(events.map(e => e.event_id)),
    evidence: structuredClone(evidence),
    continuations: structuredClone(continuations),
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
      const work = structuredClone(state.work.get(event.work_unit_id ?? event.feedback?.work_unit_id) ?? null);
      if (work?.pilot) {
        const e = state.executions.get(work.last_execution_id);
        const proposal = state.continuations.find(p => p.work_unit_id === work.work_unit_id && p.execution_id === work.last_execution_id && p.id > work.pilot.considered_proposal_id && e?.state === 'succeeded' && e.admission?.work_revision === work.work_revision);
        work.pilot.pending_proposal = proposal ? { ...structuredClone(proposal), runnable_at: new Date(Date.parse(e.finished_at) + pilotIntervalMs).toISOString() } : null;
      }
      return work;
    },
    async beginExecution(workUnit, execution, authorizationDecision = null) {
      return serializeTransition(async () => {
      // Clone all caller input and all live transition state before mutation.
      // A structuredClone/validation failure therefore cannot leave a partial
      // transition behind.
      const proposedWorkUnit = structuredClone(workUnit);
      const proposedExecution = structuredClone(execution);
      const proposedDecision = structuredClone(authorizationDecision);
      const next = structuredClone({
        work: [...state.work.entries()],
        executions: [...state.executions.entries()],
        authorities: [...state.authorities.entries()],
        reconciliationBlocks: [...state.reconciliationBlocks.entries()],
      });

      if (proposedExecution.work_unit_id !== proposedWorkUnit.work_unit_id) throw new Error('execution belongs to a different Work Unit');
      if (proposedExecution.project_id !== proposedWorkUnit.project_id) throw new Error('execution belongs to a different project');
      const decision = proposedDecision || (proposedExecution.authorization_decision_ref ? { ref: proposedExecution.authorization_decision_ref } : null);
      if (!decision?.ref || proposedExecution.authorization_decision_ref !== decision.ref) throw new Error('mutation-bearing execution requires its authorization decision reference');
      if (typeof authorizationVerifier !== 'function') throw new Error('authorization verifier is required for mutation-bearing execution');

      const workMap = new Map(next.work);
      const executionMap = new Map(next.executions);
      const authorityMap = new Map(next.authorities);
      const reconciliationMap = new Map(next.reconciliationBlocks);
      const current = workMap.get(proposedWorkUnit.work_unit_id);
      if (!current) throw new Error('Work Unit does not exist');
      if ((proposedWorkUnit.work_revision ?? 1) !== current.work_revision) throw new Error('work revision changed before admission');
      proposedExecution.admission = admissionContext(current, proposedExecution, current.pilot?.input_seq ?? 0);
      const verified = await authorizationVerifier(decision, { workUnit: { ...structuredClone(current), fence: proposedExecution.fence }, execution: structuredClone(proposedExecution) });
      if (verified !== true) throw new Error('authorization decision is not valid for this Execution');
      if (current.project_id !== proposedExecution.project_id) throw new Error('execution belongs to a different stored project');
      const now = Date.now();
      const expiredClaim = current.claim?.claim_expires_at && new Date(current.claim.claim_expires_at).getTime() <= now;
      if (current.claim && !expiredClaim && current.claim.claim_expires_at !== proposedExecution.claim_expires_at) throw new Error('execution claim expiration does not match Work Unit claim');
      const reconciliation = reconciliationMap.get(proposedExecution.project_id);
      if (reconciliation) throw new Error('E_RECONCILIATION_REQUIRED: project has unresolved external-effect uncertainty');
      const authority = authorityMap.get(proposedExecution.project_id);
      const expiredAuthority = authority?.claim_expires_at && new Date(authority.claim_expires_at).getTime() <= now;
      if (authority && !expiredAuthority) throw new Error('E_PROJECT_AUTH_HELD: project mutation authority is already held');
      if (!['actionable', 'waiting'].includes(current.state) || (current.claim && !expiredClaim) || current.fence !== proposedExecution.fence - 1) throw new Error('Work Unit changed before execution could be claimed');
      if (executionMap.has(proposedExecution.execution_id)) throw new Error(`duplicate execution: ${proposedExecution.execution_id}`);

      if (expiredAuthority) {
        const previous = executionMap.get(authority.execution_id);
        if (previous && ['created', 'running'].includes(previous.state)) {
          executionMap.set(authority.execution_id, { ...previous, state: 'expired', finished_at: new Date().toISOString() });
        }
        const previousWork = workMap.get(authority.work_unit_id);
        if (previousWork?.claim?.execution_id === authority.execution_id && previousWork?.claim?.fence === authority.fence) {
          workMap.set(authority.work_unit_id, { ...previousWork, state: 'waiting', claim: null, claim_expires_at: null, retry_after: null });
        }
        authorityMap.delete(proposedExecution.project_id);
      }

      const claimed = { ...current, state: 'actionable', fence: proposedExecution.fence, claim: { execution_id: proposedExecution.execution_id, owner: proposedExecution.owner, fence: proposedExecution.fence, claim_expires_at: proposedExecution.claim_expires_at }, claim_expires_at: proposedExecution.claim_expires_at, attempt: proposedExecution.attempt };
      if (current.pilot) {
        if (proposedWorkUnit.pilot?.input_seq !== current.pilot.input_seq || proposedWorkUnit.pilot?.considered_proposal_id !== current.pilot.considered_proposal_id) throw new Error('pilot admission snapshot changed');
        const candidate = proposedWorkUnit.pilot.pending_proposal;
        if (candidate) {
          const actual = state.continuations.find(p => p.id === candidate.id && p.work_unit_id === current.work_unit_id && p.execution_id === current.last_execution_id);
          const prior = state.executions.get(actual?.execution_id);
          if (!actual || actual.id <= current.pilot.considered_proposal_id || prior?.state !== 'succeeded' || prior.admission?.work_revision !== current.work_revision) throw new Error('continuation proposal changed before admission');
          claimed.pilot = { ...current.pilot, considered_proposal_id: actual.id };
        }
        const fresh = current.pilot.input_seq > current.pilot.consumed_input_seq;
        const due = current.pilot.next_wake_at && Date.parse(current.pilot.next_wake_at) <= Date.now();
        const previous = state.executions.get(current.last_execution_id);
        const actualProposal = state.continuations.find(p => p.id === candidate?.id && p.work_unit_id === current.work_unit_id && p.execution_id === current.last_execution_id);
        const immediate = actualProposal?.continuation.mode === 'immediate' && Date.parse(previous?.finished_at) + pilotIntervalMs <= Date.now();
        if (!fresh && !due && !immediate) throw new Error('pilot admission is not justified by current coordinator policy');
      }
      if (expiredClaim && current.claim && current.claim.execution_id !== authority?.execution_id) {
        const previous = executionMap.get(current.claim.execution_id);
        if (previous && ['created', 'running'].includes(previous.state)) executionMap.set(current.claim.execution_id, { ...previous, state: 'expired', finished_at: new Date().toISOString() });
      }
      workMap.set(proposedWorkUnit.work_unit_id, structuredClone(claimed));
      executionMap.set(proposedExecution.execution_id, proposedExecution);
      authorityMap.set(proposedExecution.project_id, { project_id: proposedExecution.project_id, work_unit_id: proposedWorkUnit.work_unit_id, execution_id: proposedExecution.execution_id, fence: proposedExecution.fence, owner: proposedExecution.owner, claim_expires_at: proposedExecution.claim_expires_at, authorization_decision_ref: proposedExecution.authorization_decision_ref });

      state.work.clear(); for (const [key, value] of workMap) state.work.set(key, value);
      state.executions.clear(); for (const [key, value] of executionMap) state.executions.set(key, value);
      state.authorities.clear(); for (const [key, value] of authorityMap) state.authorities.set(key, value);
      return { workUnit: structuredClone(claimed), execution: structuredClone(proposedExecution) };
      });
    },

    async persistFailure(failed) {
      return serializeTransition(async () => {
      const proposed = structuredClone(failed);
      const next = structuredClone({
        work: [...state.work.entries()],
        executions: [...state.executions.entries()],
        authorities: [...state.authorities.entries()],
        reconciliationBlocks: [...state.reconciliationBlocks.entries()],
      });
      const { workUnit, execution } = proposed;
      if (execution.work_unit_id !== workUnit.work_unit_id) throw new Error('execution belongs to a different Work Unit');
      if (execution.project_id !== workUnit.project_id) throw new Error('execution belongs to a different project');
      const workMap = new Map(next.work);
      const executionMap = new Map(next.executions);
      const authorityMap = new Map(next.authorities);
      const reconciliationMap = new Map(next.reconciliationBlocks);
      const current = workMap.get(workUnit.work_unit_id);
      const authority = authorityMap.get(execution.project_id);
      const storedExecution = executionMap.get(execution.execution_id);
      if (!current || !authority || authority.work_unit_id !== workUnit.work_unit_id || authority.execution_id !== execution.execution_id || authority.fence !== execution.fence || authority.owner !== execution.owner || authority.authorization_decision_ref !== execution.authorization_decision_ref || current.fence !== execution.fence || current.claim?.execution_id !== execution.execution_id || current.claim?.owner !== execution.owner || current.claim?.fence !== execution.fence || !storedExecution || storedExecution.work_unit_id !== workUnit.work_unit_id || storedExecution.project_id !== workUnit.project_id || storedExecution.owner !== execution.owner || storedExecution.authorization_decision_ref !== execution.authorization_decision_ref || storedExecution.fence !== execution.fence || !['created', 'running'].includes(storedExecution.state)) throw new Error('fencing conflict while persisting failure');
      if (new Date(authority.claim_expires_at).getTime() <= Date.now()) throw new Error('fencing conflict while persisting failure: project mutation authority expired');
      if (current.claim_expires_at !== execution.claim_expires_at || authority.claim_expires_at !== execution.claim_expires_at) throw new Error('fencing conflict while persisting failure: execution claim expiration does not match durable claim');
      executionMap.set(execution.execution_id, structuredClone(execution));
      workMap.set(workUnit.work_unit_id, structuredClone(workUnit));
      if (execution.failure?.reconciliation_required === true || workUnit.failure?.reconciliation_required === true) {
        reconciliationMap.set(execution.project_id, { project_id: execution.project_id, work_unit_id: workUnit.work_unit_id, execution_id: execution.execution_id, fence: execution.fence, reason: 'external-effect-uncertain' });
      }
      authorityMap.delete(execution.project_id);
      state.work.clear(); for (const [key, value] of workMap) state.work.set(key, value);
      state.executions.clear(); for (const [key, value] of executionMap) state.executions.set(key, value);
      state.authorities.clear(); for (const [key, value] of authorityMap) state.authorities.set(key, value);
      state.reconciliationBlocks.clear(); for (const [key, value] of reconciliationMap) state.reconciliationBlocks.set(key, value);
      return structuredClone(proposed);
      });
    },

    async reconcileFailure({ projectId, workUnitId, executionId, fence, resolution } = {}) {
      return serializeTransition(async () => {
        if (!projectId || !workUnitId || !executionId || !Number.isInteger(fence) || fence < 1) throw new Error('reconciliation identity is required');
        if (!['no_effect', 'effect_applied'].includes(resolution)) throw new Error('reconciliation resolution must be no_effect or effect_applied');
        const block = state.reconciliationBlocks.get(projectId);
        if (!block || block.work_unit_id !== workUnitId || block.execution_id !== executionId || block.fence !== fence) throw new Error('reconciliation identity does not match durable project block');
        const execution = state.executions.get(executionId);
        const workUnit = state.work.get(workUnitId);
        if (!execution || execution.state !== 'failed' || execution.failure?.reconciliation_required !== true) throw new Error('execution is not awaiting reconciliation');
        if (!workUnit || workUnit.state !== 'review' || workUnit.last_execution_id !== executionId) throw new Error('Work Unit is not awaiting reconciliation');
        const next = structuredClone({ work: [...state.work.entries()], executions: [...state.executions.entries()], authorities: [...state.authorities.entries()], reconciliationBlocks: [...state.reconciliationBlocks.entries()] });
        const workMap = new Map(next.work);
        const reconciliationMap = new Map(next.reconciliationBlocks);
        const updated = { ...workUnit, state: resolution === 'no_effect' ? 'actionable' : 'review', failure: null, retry_after: null };
        workMap.set(workUnitId, updated);
        reconciliationMap.delete(projectId);
        state.work.clear(); for (const [key, value] of workMap) state.work.set(key, value);
        state.reconciliationBlocks.clear(); for (const [key, value] of reconciliationMap) state.reconciliationBlocks.set(key, value);
        return { projectId, workUnitId, executionId, fence, resolution, state: updated.state };
      });
    },

    ...memoryBoundary({ state, serializeTransition, acceptanceVerifier }),
    async manifest(executionId) {
      const execution = state.executions.get(executionId);
      return execution ? { execution: { status: execution.state === 'succeeded' ? 'success' : execution.state } } : null;
    },
    snapshot() {
      return structuredClone({
        work: [...state.work.values()],
        executions: [...state.executions.values()],
        authorities: [...state.authorities.values()],
        reconciliationBlocks: [...state.reconciliationBlocks.values()],
        events: state.events,
        evidence: state.evidence,
        continuations: state.continuations,
      });
    },
  };
}
