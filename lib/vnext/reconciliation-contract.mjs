const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const DECISION_FIELDS = new Set([
  'ref',
  'project_id',
  'work_unit_id',
  'execution_id',
  'fence',
  'resolution',
  'evidence_ref',
  'sender_stop_confirmed',
]);

function identifier(value, name) {
  if (typeof value !== 'string' || !IDENTIFIER.test(value)) throw new Error(`reconciliation ${name} is invalid`);
  return value;
}

export function validateReconciliationDecision(decision, expected = {}) {
  if (!decision || typeof decision !== 'object' || Array.isArray(decision)) throw new Error('reconciliation decision is required');
  for (const key of Object.keys(decision)) if (!DECISION_FIELDS.has(key)) throw new Error(`reconciliation decision has unexpected key ${key}`);
  const value = {
    ref: identifier(decision.ref, 'reference'),
    project_id: identifier(decision.project_id, 'project_id'),
    work_unit_id: identifier(decision.work_unit_id, 'work_unit_id'),
    execution_id: identifier(decision.execution_id, 'execution_id'),
    fence: decision.fence,
    resolution: decision.resolution,
    evidence_ref: identifier(decision.evidence_ref, 'evidence_ref'),
    sender_stop_confirmed: decision.sender_stop_confirmed,
  };
  if (!Number.isInteger(value.fence) || value.fence < 1) throw new Error('reconciliation decision fence is invalid');
  if (!['no_effect', 'effect_applied'].includes(value.resolution)) throw new Error('reconciliation decision resolution is invalid');
  if (value.sender_stop_confirmed !== true) throw new Error('reconciliation decision requires confirmed sender termination');
  for (const [field, expectedValue] of Object.entries(expected)) {
    if (value[field] !== expectedValue) throw new Error(`reconciliation decision ${field} does not match the requested attempt`);
  }
  return value;
}
