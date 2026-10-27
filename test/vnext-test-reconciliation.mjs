import { digest } from '../lib/vnext/operating-boundary.mjs';

const evidenceRecords = new Map();
const stoppedSenders = new Set();

export function testReconciliationDecision({ projectId, workUnitId, executionId, fence, resolution = 'no_effect', ref = `test-reconcile:${executionId}` }) {
  const evidence_ref = `test-evidence:${executionId}`;
  const evidence = {
    project_id: projectId,
    work_unit_id: workUnitId,
    execution_id: executionId,
    fence,
    resolution,
    provenance: 'test-authority-record',
    sender_termination_ref: `test-stop:${executionId}`,
  };
  evidenceRecords.set(evidence_ref, { ...evidence, evidence_digest: digest(evidence) });
  stoppedSenders.add(executionId);
  return {
    ref,
    project_id: projectId,
    work_unit_id: workUnitId,
    execution_id: executionId,
    fence,
    resolution,
    evidence_ref,
    sender_stop_confirmed: true,
  };
}

export async function verifyTestReconciliation(decision, context) {
  const evidence = evidenceRecords.get(decision.evidence_ref);
  if (!evidence) return false;
  const { evidence_digest: evidenceDigest, ...evidenceBody } = evidence;
  return typeof decision.ref === 'string'
    && evidenceDigest === digest(evidenceBody)
    && evidence.provenance === 'test-authority-record'
    && evidence.sender_termination_ref === `test-stop:${context.executionId}`
    && stoppedSenders.has(context.executionId)
    && decision.evidence_ref === `test-evidence:${context.executionId}`
    && decision.sender_stop_confirmed === true
    && evidence.project_id === context.projectId
    && evidence.work_unit_id === context.workUnitId
    && evidence.execution_id === context.executionId
    && evidence.fence === context.fence
    && evidence.resolution === context.resolution
    && decision.project_id === context.projectId
    && decision.work_unit_id === context.workUnitId
    && decision.execution_id === context.executionId
    && decision.fence === context.fence
    && decision.resolution === context.resolution;
}

export function removeTestReconciliationEvidence(evidenceRef) {
  evidenceRecords.delete(evidenceRef);
}

export function corruptTestReconciliationEvidence(evidenceRef) {
  const evidence = evidenceRecords.get(evidenceRef);
  if (evidence) evidenceRecords.set(evidenceRef, { ...evidence, provenance: 'corrupt-record' });
}

export function setTestReconciliationSenderStopped(executionId, stopped) {
  if (stopped) stoppedSenders.add(executionId);
  else stoppedSenders.delete(executionId);
}

export function setTestReconciliationEvidenceOutcome(evidenceRef, resolution) {
  const evidence = evidenceRecords.get(evidenceRef);
  if (!evidence) return;
  const { evidence_digest: _priorDigest, ...body } = evidence;
  const updated = { ...body, resolution };
  evidenceRecords.set(evidenceRef, { ...updated, evidence_digest: digest(updated) });
}
