import { eventIntegrityConflict, eventsEquivalent } from './event-integrity.mjs';
import { memoryBoundary } from './memory-boundary.mjs';
import { admissionContext, baselineRequirements, digest } from './operating-boundary.mjs';

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
      if (authority && new Date(authority.claim_expires_at).getTime() > now) throw new Error('E_PROJECT_AUTH_HELD: project mutation authority is already held');
      if (!['actionable', 'waiting'].includes(current.state) || (current.claim && !expiredClaim) || current.fence !== proposedExecution.fence - 1) throw new Error('Work Unit changed before execution could be claimed');
      // Stop confirmation: an expired claim bound to an unsettled attempt, or
      // an expired authority, may only be superseded by recovery. Both
      // refusals follow the Work Unit binding checks so a forged fence keeps
      // its specific error; elapsed time is never evidence that a worker
      // stopped.
      if (expiredClaim) {
        const previous = executionMap.get(current.claim.execution_id);
        if (!previous || ['created', 'running'].includes(previous.state)) throw new Error('E_RECONCILIATION_REQUIRED: expired external effects require stop confirmation or reconciliation');
      }
      if (authority) throw new Error('E_RECONCILIATION_REQUIRED: expired external effects require stop confirmation or reconciliation');
      if (executionMap.has(proposedExecution.execution_id)) throw new Error(`duplicate execution: ${proposedExecution.execution_id}`);

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

    async persistSuperseded(superseded, { recovery = false } = {}) {
      return serializeTransition(async () => {
        const proposed = structuredClone(superseded);
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
        const current = workMap.get(workUnit.work_unit_id);
        const authority = authorityMap.get(execution.project_id);
        const storedExecution = executionMap.get(execution.execution_id);
        const eventId = `superseded:${execution.execution_id}`;
        // Request identity uses only the stable attempt binding. The observed
        // superseding revision belongs to the recorded result: a later revision
        // must not retroactively change a committed transition's identity.
        const hash = digest({ execution_id: execution.execution_id, work_unit_id: workUnit.work_unit_id, project_id: execution.project_id, fence: execution.fence });
        const existing = state.events.find(e => e.event_id === eventId);
        if (existing) {
          if (existing.payload?.digest !== hash) throw new Error('supersession content conflict');
          return structuredClone(existing.payload.result);
        }
        if (!current || !authority || authority.work_unit_id !== workUnit.work_unit_id || authority.execution_id !== execution.execution_id || authority.fence !== execution.fence || authority.owner !== execution.owner || authority.authorization_decision_ref !== execution.authorization_decision_ref || current.fence !== execution.fence || current.claim?.execution_id !== execution.execution_id || current.claim?.owner !== execution.owner || current.claim?.fence !== execution.fence || !storedExecution || storedExecution.work_unit_id !== workUnit.work_unit_id || storedExecution.project_id !== workUnit.project_id || storedExecution.owner !== execution.owner || storedExecution.authorization_decision_ref !== execution.authorization_decision_ref || storedExecution.fence !== execution.fence || !['created', 'running'].includes(storedExecution.state)) throw new Error('fencing conflict while superseding attempt');
        if (!recovery && new Date(authority.claim_expires_at).getTime() <= Date.now()) throw new Error('fencing conflict while superseding attempt: project mutation authority expired');
        if (recovery && !(current.claim_expires_at && Date.parse(current.claim_expires_at) <= Date.now())) throw new Error('fencing conflict while recovering supersession: claim is still active');
        if (current.claim_expires_at !== execution.claim_expires_at || authority.claim_expires_at !== execution.claim_expires_at) throw new Error('fencing conflict while superseding attempt: execution claim expiration does not match durable claim');
        const workRevision = current.work_revision ?? 1;
        if (!storedExecution.admission || workRevision <= storedExecution.admission.work_revision) throw new Error('attempt is not superseded by a newer work revision');
        const failure = { message: 'Execution superseded by a material requirements revision.', reason: 'requirements-revision' };
        const result = { work_unit_id: workUnit.work_unit_id, execution_id: execution.execution_id, fence: execution.fence, superseded_by_revision: workRevision, state: 'actionable' };
        // All validation precedes writes: the stale attempt becomes history,
        // exclusion is released, and the current revision gets a coordinator
        // due time in one transition.
        executionMap.set(execution.execution_id, { ...storedExecution, state: 'failed', finished_at: new Date().toISOString(), failure, retry_after: null });
        workMap.set(workUnit.work_unit_id, { ...current, state: 'actionable', claim: null, claim_expires_at: null, failure: null, retry_after: null, last_execution_id: execution.execution_id,
          ...(current.pilot ? { pilot: { ...current.pilot, next_wake_at: new Date().toISOString() } } : {}) });
        authorityMap.delete(execution.project_id);
        state.work.clear(); for (const [key, value] of workMap) state.work.set(key, value);
        state.executions.clear(); for (const [key, value] of executionMap) state.executions.set(key, value);
        state.authorities.clear(); for (const [key, value] of authorityMap) state.authorities.set(key, value);
        state.eventIds.add(eventId);
        state.events.push(structuredClone({ event_id: eventId, type: 'execution.superseded', payload: { digest: hash, result } }));
        return structuredClone(result);
      });
    },

    async reconcileFailure({ projectId, workUnitId, executionId, fence, resolution } = {}) {
      return serializeTransition(async () => {
        if (!projectId || !workUnitId || !executionId || !Number.isInteger(fence) || fence < 1) throw new Error('reconciliation identity is required');
        if (!['no_effect', 'effect_applied'].includes(resolution)) throw new Error('reconciliation resolution must be no_effect or effect_applied');
        const eventId = `reconciliation:${executionId}`;
        const hash = digest({ projectId, workUnitId, executionId, fence, resolution });
        const existing = state.events.find(e => e.event_id === eventId);
        if (existing) {
          if (existing.payload?.digest !== hash) throw new Error('reconciliation content conflict');
          return structuredClone(existing.payload.result);
        }
        const block = state.reconciliationBlocks.get(projectId);
        if (!block || block.work_unit_id !== workUnitId || block.execution_id !== executionId || block.fence !== fence) throw new Error('reconciliation identity does not match durable project block');
        const execution = state.executions.get(executionId);
        const workUnit = state.work.get(workUnitId);
        if (!execution || execution.state !== 'failed' || execution.failure?.reconciliation_required !== true) throw new Error('execution is not awaiting reconciliation');
        // Reconciliation depends on the authoritative block and failed-attempt
        // binding, not on the mutable presentation state: intent updates may
        // legitimately change the label while the block is pending.
        if (!workUnit || workUnit.last_execution_id !== executionId) throw new Error('Work Unit is not awaiting reconciliation');
        const stateName = resolution === 'no_effect' ? 'actionable' : 'review';
        const result = { projectId, workUnitId, executionId, fence, resolution, state: stateName };
        const next = structuredClone({ work: [...state.work.entries()], executions: [...state.executions.entries()], authorities: [...state.authorities.entries()], reconciliationBlocks: [...state.reconciliationBlocks.entries()] });
        const workMap = new Map(next.work);
        const reconciliationMap = new Map(next.reconciliationBlocks);
        // The resolution is the coordinator's recovery opportunity: with the
        // uncertainty gone, the affected Work Unit gets a fresh coordinator-owned
        // due time so a cold restart can discover and resume it.
        const updated = { ...workUnit, state: stateName, failure: null, retry_after: null,
          ...(workUnit.pilot && resolution === 'no_effect' ? { pilot: { ...workUnit.pilot, next_wake_at: new Date().toISOString() } } : {}) };
        workMap.set(workUnitId, updated);
        reconciliationMap.delete(projectId);
        state.work.clear(); for (const [key, value] of workMap) state.work.set(key, value);
        state.reconciliationBlocks.clear(); for (const [key, value] of reconciliationMap) state.reconciliationBlocks.set(key, value);
        state.eventIds.add(eventId);
        state.events.push(structuredClone({ event_id: eventId, type: 'reconciliation.recorded', payload: { digest: hash, result } }));
        return structuredClone(result);
      });
    },

    // Durable launch identity: recorded between admission and worker
    // completion. Exact replay is idempotent; divergent content for the same
    // attempt fails closed. Active claim and unexpired authority are required.
    async recordLaunch(workUnit, execution, identity) {
      return serializeTransition(async () => {
        if (!identity || !Number.isInteger(identity.pid) || identity.pid <= 1 || !Number.isInteger(identity.pgid) || identity.pgid <= 1) throw new Error('launch identity requires pid and pgid');
        if (identity.start_ticks != null && !/^\d+$/.test(String(identity.start_ticks))) throw new Error('launch identity start_ticks must be numeric');
        if (identity.boot_id != null && (typeof identity.boot_id !== 'string' || identity.boot_id.length > 128)) throw new Error('launch identity boot_id must be bounded');
        if (typeof identity.started_at !== 'string' || Number.isNaN(Date.parse(identity.started_at))) throw new Error('launch identity requires started_at');
        const proposedWork = structuredClone(workUnit);
        const proposedExecution = structuredClone(execution);
        const proposedIdentity = structuredClone(identity);
        const current = state.work.get(proposedWork.work_unit_id);
        const authority = state.authorities.get(proposedExecution.project_id);
        const stored = state.executions.get(proposedExecution.execution_id);
        if (!current || !authority || !stored || authority.work_unit_id !== proposedWork.work_unit_id || authority.execution_id !== proposedExecution.execution_id || authority.fence !== proposedExecution.fence || authority.owner !== proposedExecution.owner || authority.authorization_decision_ref !== proposedExecution.authorization_decision_ref || current.fence !== proposedExecution.fence || current.claim?.execution_id !== proposedExecution.execution_id || current.claim?.owner !== proposedExecution.owner || current.claim_expires_at !== proposedExecution.claim_expires_at || stored.work_unit_id !== proposedWork.work_unit_id || stored.project_id !== proposedExecution.project_id || stored.owner !== proposedExecution.owner || stored.authorization_decision_ref !== proposedExecution.authorization_decision_ref || stored.fence !== proposedExecution.fence || !['created', 'running'].includes(stored.state)) throw new Error('fencing conflict while recording launch');
        if (new Date(authority.claim_expires_at).getTime() <= Date.now()) throw new Error('fencing conflict while recording launch: project mutation authority expired');
        if (stored.launch && digest(stored.launch) !== digest(proposedIdentity)) throw new Error('launch content conflict');
        if (!stored.launch) state.executions.set(proposedExecution.execution_id, { ...stored, launch: proposedIdentity });
        return { execution_id: proposedExecution.execution_id, launch: structuredClone(proposedIdentity) };
      });
    },

    // In-doubt attempts: an expired claim still bound to an execution that
    // never reached a terminal state with no pending project reconciliation.
    async listInDoubtAttempts(projectId) {
      const attempts = [];
      for (const work of state.work.values()) {
        const claim = work.claim;
        if (!claim?.execution_id || work.project_id !== projectId) continue;
        if (!work.claim_expires_at || Date.parse(work.claim_expires_at) > Date.now()) continue;
        if (state.reconciliationBlocks.has(work.project_id)) continue;
        const execution = state.executions.get(claim.execution_id);
        if (execution && ['created', 'running'].includes(execution.state)) attempts.push({ work: structuredClone(work), execution: structuredClone(execution) });
      }
      return attempts;
    },

    // Settlement of an expired in-doubt attempt. 'not-launched' is the only
    // outcome that may retry; 'uncertain' records a durable reconciliation
    // block before anything may run again. Exact replay returns the recorded
    // outcome; divergent content for the same attempt fails closed.
    async recoverAttempt({ projectId, workUnitId, executionId, fence, resolution, reason } = {}) {
      return serializeTransition(async () => {
        if (!projectId || !workUnitId || !executionId || !Number.isInteger(fence) || fence < 1) throw new Error('recovery identity is required');
        if (!['not-launched', 'uncertain'].includes(resolution)) throw new Error('recovery resolution must be not-launched or uncertain');
        if (resolution === 'uncertain' && (typeof reason !== 'string' || !reason.trim() || reason.length > 200)) throw new Error('uncertain recovery requires a bounded reason');
        const eventId = `recovered:${executionId}`;
        const hash = digest({ projectId, workUnitId, executionId, fence, resolution, reason: resolution === 'uncertain' ? reason : null });
        const existing = state.events.find(e => e.event_id === eventId);
        if (existing) {
          if (existing.payload?.digest !== hash) throw new Error('recovery content conflict');
          return structuredClone(existing.payload.result);
        }
        const work = state.work.get(workUnitId);
        const execution = state.executions.get(executionId);
        if (!work || work.project_id !== projectId || work.claim?.execution_id !== executionId || work.claim?.fence !== fence || !work.claim_expires_at || Date.parse(work.claim_expires_at) > Date.now()) throw new Error('recovery identity does not match an expired durable claim');
        if (!execution || execution.work_unit_id !== workUnitId || execution.project_id !== projectId || execution.fence !== fence || !['created', 'running'].includes(execution.state) || execution.authorization_decision_ref == null) throw new Error('execution is not awaiting recovery');
        if (resolution === 'not-launched' && execution.launch != null) throw new Error('not-launched resolution conflicts with a recorded launch identity');
        if (state.reconciliationBlocks.has(projectId)) throw new Error('project reconciliation is already pending');
        const authority = state.authorities.get(projectId);
        if (authority && (authority.work_unit_id !== workUnitId || authority.execution_id !== executionId || authority.fence !== fence)) throw new Error('fencing conflict while recovering attempt');
        const notLaunched = resolution === 'not-launched';
        const attemptNumber = Number(work.attempt || execution.attempt || 1);
        const retryable = notLaunched && attemptNumber < 3;
        const failure = notLaunched
          ? { message: 'Execution was never launched; safely retryable.', reason: 'not-launched', recovered: true }
          : { message: 'Dispatch outcome requires reconciliation before resuming.', reason, recovered: true, reconciliation_required: true };
        const stateName = retryable ? 'waiting' : 'review';
        const result = { projectId, workUnitId, executionId, fence, resolution, state: stateName, attempt: attemptNumber };
        // All validation precedes writes.
        state.executions.set(executionId, { ...execution, state: 'failed', finished_at: new Date().toISOString(), failure, retry_after: null });
        state.work.set(workUnitId, { ...work, state: stateName, claim: null, claim_expires_at: null, failure, retry_after: retryable ? new Date().toISOString() : null, last_execution_id: executionId,
          ...(work.pilot && retryable ? { pilot: { ...work.pilot, next_wake_at: new Date().toISOString() } } : {}) });
        if (!notLaunched) state.reconciliationBlocks.set(projectId, { project_id: projectId, work_unit_id: workUnitId, execution_id: executionId, fence, reason: 'external-effect-uncertain' });
        state.authorities.delete(projectId);
        state.eventIds.add(eventId);
        state.events.push(structuredClone({ event_id: eventId, type: 'execution.recovered', payload: { digest: hash, result } }));
        return structuredClone(result);
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
