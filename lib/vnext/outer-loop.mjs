import { claimWorkUnit, createExecution, newExecutionId, startExecution, applyTurn, failExecution, reactivateWorkUnit } from './kernel.mjs';
import { validateObjectiveTurn, verifyTurnEvidenceIntegrity } from '../objective-turn.mjs';

// One bounded outer turn. The injected interfaces are deliberately tiny:
// Runtime reconstructs/claims/persists; cognition determines whether a wake
// makes waiting work worth inspecting; nothing here knows Feedback, models,
// GitHub, Observer, or scheduling.
export async function runOuterLoop({ wake, store, executor, isJustified = ({ workUnit }) => workUnit.state === 'actionable', owner = 'vnext', authorizeTerminal, maxAttempts = 3, retryDelayMs = 1000 } = {}) {
  if (!wake || typeof wake !== 'object') throw new Error('wake is required');
  if (!store || typeof store.reconstruct !== 'function') throw new Error('store.reconstruct is required');
  if (typeof isJustified !== 'function') throw new Error('isJustified is required');
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
  if (typeof store.markEventProcessing === 'function') await store.markEventProcessing({ eventId: wake.event_id, executionId });

  // Durable stores must combine claim + execution creation. The memory store
  // keeps the same seam but remains only a deterministic reference implementation.
  if (typeof store.beginExecution === 'function') {
    const begun = await store.beginExecution(claimed, execution);
    execution = begun.execution;
  } else {
    await store.saveWorkUnit(claimed);
    await store.createExecution(execution);
  }

  try {
    const turn = validateObjectiveTurn(await executor({ workUnit: claimed, execution, wake }));
    if (turn.objective_id !== claimed.objective_ref) throw new Error('turn objective_id does not match Work Unit objective_ref');
    const verifiedEvidence = turn.disposition === 'done'
      ? await verifyTurnEvidenceIntegrity(turn, { workspaceRoot: wake.workspace_root, store })
      : null;
    const terminalAuthorized = turn.disposition === 'done'
      && typeof authorizeTerminal === 'function'
      && (await authorizeTerminal({ workUnit: claimed, execution, turn, evidence: verifiedEvidence, wake })) === true;
    const result = applyTurn(claimed, execution, turn, { terminalAuthorized });
    if (typeof store.persistTurn === 'function') {
      await store.persistTurn({ ...result, settlement: { event_id: wake.event_id } });
      if (typeof store.markEventProcessing === 'function') await store.markEventProcessing({ eventId: wake.event_id, executionId: execution.execution_id, completed: true });
    } else {
      await store.finishExecution(result.execution);
      if (result.turn.disposition !== 'done') await store.appendContinuation(result.workUnit.work_unit_id, result.execution.execution_id, result.turn.continuation);
      if (result.turn.outcome_evidence) await store.appendEvidence(result.workUnit.work_unit_id, result.execution.execution_id, result.turn.outcome_evidence);
      await store.saveWorkUnit(result.workUnit);
    }
    return {
      disposition: result.workUnit.state === 'terminal' ? 'terminal' : result.workUnit.state === 'review' ? 'needs-review' : result.turn.disposition,
      work_unit_id: result.workUnit.work_unit_id,
      execution_id: result.execution.execution_id,
      turn: result.turn,
    };
  } catch (error) {
    if (typeof store.readbackSettlement === 'function') {
      const readback = await store.readbackSettlement({ workUnitId: claimed.work_unit_id, executionId: execution.execution_id, eventId: wake.event_id, fence: execution.fence, owner: execution.owner });
      if (readback?.committed && readback.workUnit && readback.execution && readback.turn) {
        return { disposition: readback.workUnit.state === 'terminal' ? 'terminal' : readback.workUnit.state === 'review' ? 'needs-review' : readback.turn.disposition, work_unit_id: readback.workUnit.work_unit_id, execution_id: readback.execution.execution_id, turn: readback.turn, recovered: true };
      }
      if (readback?.status === 'inconclusive') return { disposition: 'uncertain-settlement', status: 'inconclusive', work_unit_id: claimed.work_unit_id, execution_id: execution.execution_id };
    }
    const failed = failExecution(claimed, execution, { maxAttempts, retryAfter: new Date(Date.now() + retryDelayMs).toISOString(), failure: { message: String(error.message).slice(0, 500) } });
    if (typeof store.persistFailure === 'function') await store.persistFailure(failed);
    else {
      await store.finishExecution(failed.execution);
      await store.saveWorkUnit(failed.workUnit);
    }
    throw error;
  }
}

// Recovery is deliberately separate from execution. A supervisor may call
// this bounded scan after a process/container disappears; the next justified
// wake still has to pass the normal claim and fence barrier before work runs.
export async function recoverExpiredClaims({ store, now = new Date(), limit = 100 } = {}) {
  if (!store || typeof store.recoverExpiredClaims !== 'function') return [];
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error('limit must be an integer between 1 and 1000');
  const recovered = await store.recoverExpiredClaims({ now, limit });
  return Array.isArray(recovered) ? recovered : [];
}
