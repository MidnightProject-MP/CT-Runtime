import { claimWorkUnit, createExecution, newExecutionId, startExecution, applyTurn, failExecution } from './kernel.mjs';
import { validateObjectiveTurn, verifyTurnEvidenceIntegrity } from '../objective-turn.mjs';

// One bounded outer turn. The injected interfaces are deliberately tiny:
// Runtime reconstructs/claims/persists; cognition executes; nothing here knows
// how Feedback, models, GitHub, Observer, or scheduling work.
export async function runOuterLoop({ wake, store, executor, owner = 'vnext', authorizeTerminal } = {}) {
  if (!wake || typeof wake !== 'object') throw new Error('wake is required');
  if (!store || typeof store.reconstruct !== 'function') throw new Error('store.reconstruct is required');
  if (typeof store.appendEvent === 'function') await store.appendEvent({ type: 'wake.inspected', wake });

  const workUnit = await store.reconstruct(wake);
  if (!workUnit) return { disposition: 'quiesced', reason: 'no-work' };
  if (workUnit.state !== 'actionable') return { disposition: 'quiesced', reason: `work-${workUnit.state}`, work_unit_id: workUnit.work_unit_id };
  if (typeof executor !== 'function') throw new Error('executor is required');

  const executionId = newExecutionId();
  const claimed = claimWorkUnit(workUnit, { executionId, owner });
  await store.saveWorkUnit(claimed);

  let execution = createExecution(claimed, { executionId, owner });
  execution = startExecution(execution);
  await store.createExecution(execution);

  try {
    const turn = validateObjectiveTurn(await executor({ workUnit: claimed, execution, wake }));
    if (turn.disposition === 'done') {
      await verifyTurnEvidenceIntegrity(turn, { workspaceRoot: wake.workspace_root, store });
    }
    const result = applyTurn(claimed, execution, turn, { authorizeTerminal });
    await store.finishExecution(result.execution);
    if (result.turn.disposition !== 'done') await store.appendContinuation(result.workUnit.work_unit_id, result.execution.execution_id, result.turn.continuation);
    if (result.turn.outcome_evidence) await store.appendEvidence(result.workUnit.work_unit_id, result.execution.execution_id, result.turn.outcome_evidence);
    await store.saveWorkUnit(result.workUnit);
    return {
      disposition: result.workUnit.state === 'terminal' ? 'terminal' : result.workUnit.state === 'review' ? 'needs-review' : result.turn.disposition,
      work_unit_id: result.workUnit.work_unit_id,
      execution_id: result.execution.execution_id,
      turn: result.turn,
    };
  } catch (error) {
    const failed = failExecution(claimed, execution, {});
    await store.finishExecution(failed.execution);
    await store.saveWorkUnit(failed.workUnit);
    throw error;
  }
}
