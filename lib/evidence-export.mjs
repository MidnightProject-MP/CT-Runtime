import { createExecutionEvidence } from './execution-evidence.mjs';

const ALLOWED = ['evidenceId', 'physicalExecutionId', 'workOrderId', 'parentExecutionId', 'substrate', 'mode', 'initiator', 'role', 'requestedModel', 'canonicalModel', 'provider', 'startedAt', 'finishedAt', 'durationMs', 'modelCalls', 'turns', 'tokens', 'toolCalls', 'mutations', 'repository', 'tests', 'failures', 'retries', 'completionClaim', 'review', 'rework', 'summary', 'artifactReferences', 'provenance', 'outcome'];

export function exportExecutionEvidence(input) {
  const bounded = Object.fromEntries(ALLOWED.filter((key) => input?.[key] !== undefined).map((key) => [key, input[key]]));
  return createExecutionEvidence(bounded);
}
