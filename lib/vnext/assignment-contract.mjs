import { digest } from './operating-boundary.mjs';

export const ASSIGNMENT_PURPOSES = Object.freeze(['execution', 'review', 'diagnosis', 'stewardship']);

const reportOutcomes = Object.freeze({
  review: ['recommend_accept', 'request_changes', 'blocked', 'non_progress'],
  diagnosis: ['retry_with_changes', 'wait_for_human', 'stop'],
});
const decisionOutcomes = Object.freeze({
  review: ['recommend_accept', 'request_changes', 'blocked', 'non_progress'],
  diagnosis: ['retry_with_changes', 'wait_for_human', 'stop'],
  stewardship: ['propose', 'no_work'],
});

function text(value, name, maximum = 2000) {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum) throw new Error(`${name} must be a non-empty string within ${maximum} characters`);
  return value;
}

function permissions(value) {
  if (!Array.isArray(value) || value.length > 32) throw new Error('assignment permissions must be a bounded array');
  const result = value.map((permission, index) => text(permission, `assignment.permissions[${index}]`, 120));
  if (new Set(result).size !== result.length) throw new Error('assignment permissions must be unique');
  return result.sort();
}

function assignmentBinding(assignment) {
  const { assignment_id: _assignmentId, assignment_digest: _assignmentDigest, assignment_work_unit_id: _assignmentWorkUnitId, ...binding } = assignment;
  return binding;
}

function instructionValue(value, { revision, predecessorExecutionId }) {
  if (value == null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('assignment instruction must be an object');
  const allowed = new Set(['work_revision','predecessor_execution_id','decision_ref','decision_digest','sources','proposal','requested_changes','approach']);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`assignment instruction has unexpected key ${key}`);
  if (Number(value.work_revision) !== Number(revision)) throw new Error('assignment instruction revision does not match its binding');
  if ((value.predecessor_execution_id ?? null) !== (predecessorExecutionId ?? null)) throw new Error('assignment instruction predecessor does not match its binding');
  const decisionRef = text(value.decision_ref, 'assignment instruction decision_ref', 160);
  if (!/^[a-f0-9]{64}$/.test(value.decision_digest)) throw new Error('assignment instruction decision_digest must be SHA-256');
  if (!Array.isArray(value.sources) || !value.sources.length || value.sources.length > 4) throw new Error('assignment instruction requires bounded authorized sources');
  const sources = value.sources.map(source => {
    if (!source || typeof source !== 'object' || Array.isArray(source)) throw new Error('assignment instruction source must be an object');
    const sourceKeys = new Set(['purpose','decision_ref','decision_digest','report_digest']);
    for (const key of Object.keys(source)) if (!sourceKeys.has(key)) throw new Error(`assignment instruction source has unexpected key ${key}`);
    if (!['review','diagnosis','stewardship'].includes(source.purpose)) throw new Error('assignment instruction source purpose is invalid');
    if (!/^[a-f0-9]{64}$/.test(source.decision_digest) || !/^[a-f0-9]{64}$/.test(source.report_digest)) throw new Error('assignment instruction source digest must be SHA-256');
    return { purpose: source.purpose, decision_ref: text(source.decision_ref, 'assignment instruction source decision_ref', 160),
      decision_digest: source.decision_digest, report_digest: source.report_digest };
  });
  const normalized = { work_revision: Number(revision), predecessor_execution_id: predecessorExecutionId ?? null,
    decision_ref: decisionRef, decision_digest: value.decision_digest, sources };
  for (const key of ['proposal','requested_changes','approach']) {
    if (value[key] !== undefined) normalized[key] = text(value[key], `assignment instruction ${key}`, 1600);
  }
  if (normalized.proposal === undefined && normalized.requested_changes === undefined && normalized.approach === undefined) throw new Error('assignment instruction requires approved content');
  return normalized;
}

export function createAssignment({ workUnit, purpose, profile, inputSeq, subjectExecutionId = null, subjectDigest = null, subjectAttempt = null, sequence = 1, executionProfile = null, assignmentWorkUnitId = null, instruction = null } = {}) {
  if (!workUnit || typeof workUnit.work_unit_id !== 'string' || typeof workUnit.project_id !== 'string') throw new Error('assignment requires a bound Work Unit');
  if (!ASSIGNMENT_PURPOSES.includes(purpose)) throw new Error('assignment purpose is invalid');
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) throw new Error(`assignment profile for ${purpose} is required`);
  const model = text(profile.model, `assignmentProfiles.${purpose}.model`, 200);
  const agent = text(profile.agent, `assignmentProfiles.${purpose}.agent`, 120);
  const assignmentPermissions = permissions(profile.permissions ?? []);
  const accessClass = profile.access_class;
  if (!['read-only', 'bounded-mutation'].includes(accessClass)) throw new Error(`assignmentProfiles.${purpose}.access_class must be read-only or bounded-mutation`);
  if (purpose !== 'execution' && accessClass !== 'read-only') throw new Error(`${purpose} assignments must use a read-only permission profile`);
  if (purpose === 'review' && executionProfile && model === executionProfile.model && agent === executionProfile.agent) throw new Error('review assignment must use a distinct model or agent from execution');
  const revision = Number(workUnit.work_revision ?? 1);
  const capturedInput = Number(inputSeq ?? workUnit.pilot?.input_seq ?? 0);
  if (!Number.isSafeInteger(revision) || revision < 1) throw new Error('assignment work_revision must be positive');
  if (!Number.isSafeInteger(capturedInput) || capturedInput < 0) throw new Error('assignment input_seq must be non-negative');
  if (!Number.isSafeInteger(sequence) || sequence < 1) throw new Error('assignment sequence must be positive');
  if (subjectDigest != null && !/^[a-f0-9]{64}$/.test(subjectDigest)) throw new Error('assignment subject_digest must be SHA-256');
  if (purpose !== 'execution' && instruction != null) throw new Error('only execution assignments carry authorized follow-up instructions');
  const boundInstruction = instructionValue(instruction, { revision, predecessorExecutionId: workUnit.last_execution_id ?? null });
  const binding = {
    purpose,
    work_unit_id: workUnit.work_unit_id,
    project_id: workUnit.project_id,
    objective_ref: workUnit.objective_ref,
    work_revision: revision,
    input_seq: capturedInput,
    sequence,
    predecessor_execution_id: workUnit.last_execution_id ?? null,
    subject_execution_id: subjectExecutionId,
    subject_digest: subjectDigest,
    subject_attempt: subjectAttempt == null ? null : Number(subjectAttempt),
    model,
    agent,
    access_class: accessClass,
    permissions: assignmentPermissions,
    ...(boundInstruction ? { instruction: boundInstruction } : {}),
  };
  const assignmentDigest = digest(binding);
  return Object.freeze({
    assignment_id: `assignment-${assignmentDigest.slice(0, 48)}`,
    assignment_digest: assignmentDigest,
    ...(assignmentWorkUnitId ? { assignment_work_unit_id: text(assignmentWorkUnitId, 'assignment_work_unit_id', 160) } : {}),
    ...binding,
  });
}

export function validateAssignment(assignment) {
  if (!assignment || typeof assignment !== 'object' || Array.isArray(assignment)) throw new Error('assignment must be an object');
  if (!ASSIGNMENT_PURPOSES.includes(assignment.purpose)) throw new Error('assignment purpose is invalid');
  for (const [field, maximum] of [['assignment_id', 96], ['work_unit_id', 160], ['project_id', 160], ['objective_ref', 160], ['model', 200], ['agent', 120]]) {
    text(assignment[field], `assignment.${field}`, maximum);
  }
  if (assignment.assignment_work_unit_id != null) text(assignment.assignment_work_unit_id, 'assignment.assignment_work_unit_id', 160);
  if (!Number.isSafeInteger(Number(assignment.work_revision)) || Number(assignment.work_revision) < 1) throw new Error('assignment work_revision must be positive');
  if (!Number.isSafeInteger(Number(assignment.input_seq)) || Number(assignment.input_seq) < 0) throw new Error('assignment input_seq must be non-negative');
  if (!Number.isSafeInteger(Number(assignment.sequence)) || Number(assignment.sequence) < 1) throw new Error('assignment sequence must be positive');
  if (!['read-only', 'bounded-mutation'].includes(assignment.access_class)) throw new Error('assignment access_class is invalid');
  if (assignment.purpose !== 'execution' && assignment.access_class !== 'read-only') throw new Error(`${assignment.purpose} assignments must be read-only`);
  permissions(assignment.permissions);
  if (assignment.subject_execution_id != null) text(assignment.subject_execution_id, 'assignment.subject_execution_id', 160);
  if (assignment.subject_attempt != null && (!Number.isSafeInteger(Number(assignment.subject_attempt)) || Number(assignment.subject_attempt) < 1)) throw new Error('assignment subject_attempt must be positive');
  if (assignment.subject_digest != null && !/^[a-f0-9]{64}$/.test(assignment.subject_digest)) throw new Error('assignment subject_digest must be SHA-256');
  if (assignment.purpose !== 'execution' && assignment.instruction != null) throw new Error('only execution assignments carry authorized follow-up instructions');
  if (assignment.instruction != null) {
    const normalized = instructionValue(assignment.instruction, { revision: Number(assignment.work_revision), predecessorExecutionId: assignment.predecessor_execution_id ?? null });
    if (digest(normalized) !== digest(assignment.instruction)) throw new Error('assignment instruction is invalid');
  }
  const binding = assignmentBinding(assignment);
  const assignmentDigest = digest(binding);
  if (assignment.assignment_digest !== assignmentDigest || assignment.assignment_id !== `assignment-${assignmentDigest.slice(0, 48)}`) throw new Error('assignment binding is invalid');
  return assignment;
}

export function validateAssignmentReport(assignment, input) {
  validateAssignment(assignment);
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('assignment report must be an object');
  if (assignment.purpose === 'stewardship') {
    for (const key of Object.keys(input)) if (!['proposal', 'rationale'].includes(key)) throw new Error(`stewardship report has unexpected key ${key}`);
    return {
      proposal: text(input.proposal, 'stewardship proposal', 1200),
      ...(input.rationale === undefined ? {} : { rationale: text(input.rationale, 'stewardship rationale', 1200) }),
    };
  }
  const outcomes = reportOutcomes[assignment.purpose];
  if (!outcomes) throw new Error(`assignment purpose ${assignment.purpose} has no report contract`);
  const extra = assignment.purpose === 'review' ? ['requested_changes', 'question'] : ['approach', 'question'];
  const allowed = new Set(['outcome', 'summary', ...extra]);
  for (const key of Object.keys(input)) if (!allowed.has(key)) throw new Error(`assignment report has unexpected key ${key}`);
  if (!outcomes.includes(input.outcome)) throw new Error(`assignment report outcome is invalid for ${assignment.purpose}`);
  const report = { outcome: input.outcome, summary: text(input.summary, 'assignment report summary', 1200) };
  for (const key of extra) if (input[key] !== undefined) report[key] = text(input[key], `assignment report ${key}`, key === 'question' ? 1000 : 1600);
  if (assignment.purpose === 'review' && input.outcome === 'request_changes' && !report.requested_changes) throw new Error('request_changes requires requested_changes');
  if (assignment.purpose === 'review' && input.outcome === 'blocked' && !report.question) throw new Error('blocked review requires a specific question');
  if (assignment.purpose === 'diagnosis' && input.outcome === 'retry_with_changes' && !report.approach) throw new Error('retry_with_changes requires a changed approach');
  if (assignment.purpose === 'diagnosis' && input.outcome === 'wait_for_human' && !report.question) throw new Error('wait_for_human requires a specific question');
  return report;
}

export function validateAssignmentDecision(assignment, report, decision) {
  validateAssignment(assignment);
  const normalizedReport = validateAssignmentReport(assignment, report);
  if (!decision || typeof decision !== 'object' || Array.isArray(decision)) throw new Error('assignment decision must be an object');
  if (typeof decision.ref !== 'string' || !decision.ref.trim() || decision.ref.length > 160) throw new Error('assignment decision requires a bounded reference');
  if (decision.assignment_id !== assignment.assignment_id || decision.assignment_digest !== assignment.assignment_digest) throw new Error('assignment decision binding is stale or mismatched');
  if (decision.report_digest !== digest(normalizedReport) || decision.subject_digest !== assignment.subject_digest) throw new Error('assignment decision report/subject binding is stale or mismatched');
  if (!decisionOutcomes[assignment.purpose].includes(decision.outcome)) throw new Error(`assignment decision outcome is invalid for ${assignment.purpose}`);
  const allowed = new Set(['ref','outcome','assignment_id','assignment_digest','report_digest','subject_digest','rationale','requested_changes','approach','question']);
  for (const key of Object.keys(decision)) if (!allowed.has(key)) throw new Error(`assignment decision has unexpected key ${key}`);
  const normalizedDecision = structuredClone(decision);
  for (const key of ['rationale','requested_changes','approach','question']) if (decision[key] !== undefined) {
    normalizedDecision[key] = text(decision[key], `assignment decision ${key}`, key === 'question' ? 1000 : 1600);
  }
  if (assignment.purpose === 'review' && decision.outcome === 'request_changes'
    && !normalizedReport.requested_changes && !normalizedDecision.requested_changes) throw new Error('request_changes decision requires requested_changes');
  if (assignment.purpose === 'review' && decision.outcome === 'blocked'
    && !normalizedReport.question && !normalizedDecision.question) throw new Error('blocked decision requires a specific question');
  if (assignment.purpose === 'diagnosis' && decision.outcome === 'retry_with_changes'
    && !normalizedReport.approach && !normalizedDecision.approach) throw new Error('retry_with_changes decision requires a changed approach');
  if (assignment.purpose === 'diagnosis' && decision.outcome === 'wait_for_human'
    && !normalizedReport.question && !normalizedDecision.question) throw new Error('wait_for_human decision requires a specific question');
  return { assignment, report: normalizedReport, decision: normalizedDecision };
}
