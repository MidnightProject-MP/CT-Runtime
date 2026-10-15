import { createHash } from 'node:crypto';
import { normalizeHandoff } from '../handoff-contract.mjs';
import { applyTurn } from './kernel.mjs';

export const baselineRequirements = Object.freeze({ baseline: 'legacy-objective-reference' });
function ordered(value) {
  if (Array.isArray(value)) return value.map(ordered);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k => [k, ordered(value[k])]));
  return value;
}
export const digest = value => createHash('sha256').update(JSON.stringify(ordered(value))).digest('hex');
export function requirementsValue(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Buffer.byteLength(JSON.stringify(value)) > 12000) throw new Error('requirements must be a bounded JSON object');
  return JSON.parse(JSON.stringify(value));
}
export function admissionContext(work, execution, inputSeq = 0) {
  return { namespace: 'ct-runtime:vnext', work_unit_id: work.work_unit_id, project_id: work.project_id,
    objective_ref: work.objective_ref, execution_id: execution.execution_id, owner: execution.owner,
    fence: execution.fence, work_revision: work.work_revision ?? 1,
    requirements_digest: digest(work.requirements ?? baselineRequirements), input_seq: inputSeq };
}
export function canonicalHandoff(turn, admission) {
  if (!admission || admission.namespace !== 'ct-runtime:vnext') throw new Error('durable admission context is required');
  return { ...normalizeHandoff(turn, { objectiveRef: admission.objective_ref }, { source: 'objective-turn' }), runtime: structuredClone(admission) };
}
export function settlement(result, work, execution) {
  const expected = admissionContext(work, execution, execution.admission?.input_seq ?? 0);
  if (!execution.admission || digest(expected) !== digest(execution.admission)) throw new Error('stale work revision or admission binding');
  const handoff = canonicalHandoff(result.handoff?.validated_result ?? result.turn, execution.admission);
  if (result.handoff && digest(handoff) !== digest(result.handoff)) throw new Error('canonical handoff binding conflict');
  const derived = applyTurn(work, execution, handoff.validated_result);
  return { ...derived, handoff };
}
export function settlementIdentity(result) {
  return digest({ execution_id: result.execution.execution_id, work_unit_id: result.workUnit.work_unit_id,
    project_id: result.workUnit.project_id, fence: result.execution.fence, owner: result.execution.owner,
    claim_expires_at: result.execution.claim_expires_at, authorization_decision_ref: result.execution.authorization_decision_ref,
    handoff: result.handoff ?? null, turn: result.handoff ? null : result.turn });
}
export function acceptanceContext(work, execution, evidence, inputSeq = 0) {
  if (!['review', 'terminal'].includes(work.state) || work.claim || !execution || execution.state !== 'succeeded' || work.last_turn?.disposition !== 'done') throw new Error('work is not settled for acceptance');
  const expected = admissionContext(work, execution, inputSeq);
  if (execution.work_unit_id !== work.work_unit_id || execution.project_id !== work.project_id || execution.execution_id !== work.last_execution_id || execution.fence !== work.fence || !execution.admission || digest(expected) !== digest(execution.admission)) throw new Error('stale revision, requirements, or new input prevents acceptance');
  if (!evidence.length || digest(evidence.flat()) !== digest(work.last_turn.outcome_evidence)) throw new Error('stored evidence does not match completion claim');
  const binding = { ...expected, result_digest: digest(work.last_turn), evidence_digest: digest(evidence) };
  return { ...binding, snapshotDigest: digest(binding), workUnit: structuredClone(work), execution: structuredClone(execution), turn: structuredClone(work.last_turn), evidence: structuredClone(evidence.flat()) };
}
export function validateAcceptanceDecision(decision, snapshot) {
  if (!decision || typeof decision.ref !== 'string' || !decision.ref.trim() || decision.ref.length > 160) throw new Error('acceptance requires an explicit decision reference');
  if (decision.ref === snapshot.execution.authorization_decision_ref) throw new Error('acceptance requires a distinct decision');
  if (decision.snapshotDigest !== snapshot.snapshotDigest) throw new Error('acceptance snapshot binding is stale or missing');
}
