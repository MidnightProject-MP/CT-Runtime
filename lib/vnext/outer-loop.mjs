import { claimWorkUnit, createExecution, newExecutionId, startExecution, applyTurn, failExecution, reactivateWorkUnit } from './kernel.mjs';
import { validateObjectiveTurn, verifyTurnEvidenceIntegrity } from '../objective-turn.mjs';

// One bounded outer turn. The injected interfaces are deliberately tiny:
// Runtime reconstructs/claims/persists; cognition determines whether a wake
// makes waiting work worth inspecting; nothing here knows Feedback, models,
// GitHub, Observer, or scheduling.
export async function runOuterLoop({ wake, store, executor, isJustified = ({ workUnit }) => workUnit.state === 'actionable', owner = 'vnext', authorizeExecution, authorizeTerminal, maxAttempts = 3, retryDelayMs = 1000 } = {}) {
  if (!wake || typeof wake !== 'object') throw new Error('wake is required');
  if (!store || typeof store.reconstruct !== 'function') throw new Error('store.reconstruct is required');
  if (typeof isJustified !== 'function') throw new Error('isJustified is required');

  // Admission is fail-closed: every execution path needs the complete
  // transactional transition contract before the wake may launch a worker.
  for (const method of ['beginExecution', 'persistTurn', 'persistFailure']) {
    if (typeof store[method] !== 'function') throw new Error(`transactional store requires ${method}`);
  }
  if (typeof store.appendEvent === 'function') {
    const event = await store.appendEvent({ type: 'wake.inspected', event_id: wake.event_id, wake });
    if (event?.consumed === false) return { disposition: 'quiesced', reason: 'event-replayed' };
  }

  const workUnit = await store.reconstruct(wake);
  if (!workUnit) return { disposition: 'quiesced', reason: 'no-work' };
  if (workUnit.state === 'terminal' || workUnit.state === 'review') return { disposition: 'quiesced', reason: `work-${workUnit.state}`, work_unit_id: workUnit.work_unit_id };
  if (workUnit.retry_after && new Date(workUnit.retry_after).getTime() > Date.now()) return { disposition: 'quiesced', reason: 'retry-not-due', work_unit_id: workUnit.work_unit_id };
  if (!(await isJustified({ workUnit, wake }))) return { disposition: 'quiesced', reason: 'not-justified', work_unit_id: workUnit.work_unit_id };
  if (typeof executor !== 'function') throw new Error('executor is required');

  const actionable = workUnit.state === 'waiting' ? reactivateWorkUnit(workUnit) : workUnit;
  const executionId = newExecutionId();
  const claimed = claimWorkUnit(actionable, { executionId, owner });
  let execution = startExecution(createExecution(claimed, { executionId, owner }));
  if (typeof authorizeExecution !== 'function') throw new Error('mutation-bearing execution requires an authorization authority');
  const authorizationDecision = await authorizeExecution({ workUnit: claimed, execution, wake });
  if (!authorizationDecision?.ref || typeof authorizationDecision.ref !== 'string') throw new Error('authorization authority must return a decision reference');
  execution = { ...execution, authorization_decision_ref: authorizationDecision.ref };

  // Durable stores must combine claim + execution creation. The memory store
  // keeps the same seam but remains only a deterministic reference implementation.
  const begun = await store.beginExecution(claimed, execution, authorizationDecision);
  execution = begun.execution;

  try {
    const turn = validateObjectiveTurn(await executor({ workUnit: begun.workUnit, execution, wake }));
    if (turn.objective_id !== begun.workUnit.objective_ref) throw new Error('turn objective_id does not match Work Unit objective_ref');
    const verifiedEvidence = turn.disposition === 'done'
      ? await verifyTurnEvidenceIntegrity(turn, { workspaceRoot: wake.workspace_root, store })
      : null;
    const terminalAuthorized = turn.disposition === 'done'
      && typeof authorizeTerminal === 'function'
      && (await authorizeTerminal({ workUnit: begun.workUnit, execution, turn, evidence: verifiedEvidence, wake })) === true;
    const result = applyTurn(begun.workUnit, execution, turn, { terminalAuthorized });
    await store.persistTurn(result);
    return {
      disposition: result.workUnit.state === 'terminal' ? 'terminal' : result.workUnit.state === 'review' ? 'needs-review' : result.turn.disposition,
      work_unit_id: result.workUnit.work_unit_id,
      execution_id: result.execution.execution_id,
      turn: result.turn,
    };
  } catch (error) {
    const failed = failExecution(begun.workUnit, execution, { maxAttempts, retryAfter: new Date(Date.now() + retryDelayMs).toISOString(), failure: { message: String(error.message).slice(0, 500) } });
    await store.persistFailure(failed);
    throw error;
  }
}
