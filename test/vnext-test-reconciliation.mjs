export function testReconciliationDecision({ projectId, workUnitId, executionId, fence, resolution = 'no_effect', ref = `test-reconcile:${executionId}` }) {
  return {
    ref,
    project_id: projectId,
    work_unit_id: workUnitId,
    execution_id: executionId,
    fence,
    resolution,
    evidence_ref: `test-evidence:${executionId}`,
    sender_stop_confirmed: true,
  };
}

export async function verifyTestReconciliation(decision, context) {
  return typeof decision.ref === 'string'
    && decision.evidence_ref === `test-evidence:${context.executionId}`
    && decision.sender_stop_confirmed === true
    && decision.project_id === context.projectId
    && decision.work_unit_id === context.workUnitId
    && decision.execution_id === context.executionId
    && decision.fence === context.fence
    && decision.resolution === context.resolution;
}
