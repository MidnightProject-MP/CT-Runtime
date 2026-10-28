import path from 'node:path';
import { pathToFileURL } from 'node:url';

function required(name) {
  const value = process.env[name];
  if (typeof value !== 'string' || !value) throw new Error(`${name} is required`);
  return value;
}

function absolute(name) {
  const value = required(name);
  if (!path.isAbsolute(value)) throw new Error(`${name} must be absolute`);
  return value;
}

const runtimeRoot = absolute('CT_QUALIFY_RUNTIME_ROOT');
const projectId = required('CT_QUALIFY_PROJECT_ID');
const workspaceRoot = absolute('CT_QUALIFY_WORKSPACE');
const trialId = required('CT_QUALIFY_TRIAL_ID');
const { verifyTurnEvidenceIntegrity } = await import(pathToFileURL(path.join(runtimeRoot, 'lib/objective-turn.mjs')).href);
const { digest } = await import(pathToFileURL(path.join(runtimeRoot, 'lib/vnext/operating-boundary.mjs')).href);

function assertProject(workUnit) {
  if (workUnit?.project_id !== projectId) throw new Error('local authority project mismatch');
}

function executionRef(executionId) {
  return `local-first-launch:exec:${executionId}`;
}

function acceptanceRef(snapshotDigest) {
  return `local-first-launch:accept:${snapshotDigest}`;
}

function assignmentRef(assignment, report) {
  return `local-first-launch:decision:${assignment.assignment_id}:${digest(report)}`;
}

async function accepted(context) {
  assertProject(context.workUnit);
  if (context.execution?.project_id !== projectId) throw new Error('local authority execution project mismatch');
  if (context.execution.authorization_decision_ref !== executionRef(context.execution.execution_id)) return false;
  if (context.turn?.disposition !== 'done') return false;
  if (!String(context.turn.summary ?? '').includes(trialId)) return false;
  const evidence = await verifyTurnEvidenceIntegrity(context.turn, { workspaceRoot });
  return evidence.some(row => row.path === 'deliverable.txt');
}

export async function authorizeExecution({ workUnit, execution }) {
  assertProject(workUnit);
  if (execution?.project_id !== projectId) throw new Error('local authority execution project mismatch');
  return { ref: executionRef(execution.execution_id), scope: { project_id: projectId, objective_ref: workUnit.objective_ref } };
}

export async function verifyExecution(decision, { execution }) {
  return decision?.ref === executionRef(execution.execution_id)
    && execution.authorization_decision_ref === decision.ref;
}

export async function authorizeTerminal(context) {
  if (!context?.snapshotDigest || !await accepted(context)) return false;
  return { ref: acceptanceRef(context.snapshotDigest), snapshotDigest: context.snapshotDigest };
}

export async function verifyAcceptance(decision, context) {
  return decision?.ref === acceptanceRef(context.snapshotDigest)
    && decision.snapshotDigest === context.snapshotDigest
    && await accepted(context);
}

export async function authorizeAssignmentDecision({ assignment, report }) {
  const outcome = assignment.purpose === 'stewardship' ? 'propose'
    : assignment.purpose === 'review' ? 'recommend_accept'
    : assignment.purpose === 'diagnosis' ? 'stop'
    : null;
  if (!outcome) return null;
  return {
    ref: assignmentRef(assignment, report),
    outcome,
    assignment_id: assignment.assignment_id,
    assignment_digest: assignment.assignment_digest,
    report_digest: digest(report),
    subject_digest: assignment.subject_digest,
  };
}

export async function verifyAssignmentDecision(decision, { assignment, report }) {
  const expected = await authorizeAssignmentDecision({ assignment, report });
  return expected != null && digest(decision) === digest(expected);
}
