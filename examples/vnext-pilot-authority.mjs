// Copy outside the checkout, point the evidence-validator import at the installed
// runtime module, and connect to the project's existing authority.
// This concrete grant adapter does NOT grant permissions by being installed.
import { readFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { verifyTurnEvidenceIntegrity } from '../lib/objective-turn.mjs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
async function grant() {
  const file = process.env.CT_PILOT_GRANT_FILE;
  if (!file || !path.isAbsolute(file)) throw new Error('absolute CT_PILOT_GRANT_FILE required');
  const raw = await readFile(file,'utf8');
  const value = JSON.parse(raw);
  if (!value.authorityRef || !value.projectId || !value.scope || !Number.isFinite(Date.parse(value.expiresAt)) || Date.parse(value.expiresAt) <= Date.now()) throw new Error('missing or expired authority');
  return { value, digest:createHash('sha256').update(raw).digest('hex') };
}
function reference(g, execution) { return `grant:${g.digest}:${execution.execution_id}`; }
export async function authorizeExecution({workUnit,execution}) {
  const g=await grant();
  if (workUnit.project_id!==g.value.projectId || execution.project_id!==g.value.projectId) throw new Error('project outside grant');
  if (g.value.objectiveIds && !g.value.objectiveIds.includes(workUnit.objective_ref)) throw new Error('objective outside grant');
  const assignment=execution.assignment??execution.admission?.assignment;
  if (assignment) {
    if (assignment.project_id!==g.value.projectId || !['execution','review','diagnosis','stewardship'].includes(assignment.purpose)) throw new Error('assignment outside grant');
    if (assignment.purpose!=='execution' && assignment.access_class!=='read-only') throw new Error('non-execution assignment must be read-only');
    if (assignment.purpose==='execution' && assignment.access_class!=='bounded-mutation') throw new Error('execution assignment requires the bounded-mutation profile');
    const profile=g.value.assignmentProfiles?.[assignment.purpose];
    if (!profile || assignment.model!==profile.model || assignment.agent!==profile.agent
      || JSON.stringify(assignment.permissions)!==JSON.stringify([...profile.permissions].sort())) throw new Error('assignment profile is not authorized by the grant');
  }
  return {ref:reference(g,execution), scope:g.value.scope};
}
export async function verifyExecution(decision,context) {
  return (await authorizeExecution(context)).ref === decision.ref && context.execution.authorization_decision_ref === decision.ref;
}
const decisions = new Map();
async function acceptanceAllowed(context) {
  const g=await grant();
  if (context.workUnit.project_id!==g.value.projectId || !g.value.acceptanceModule || !path.isAbsolute(g.value.acceptanceModule)) return false;
  if (context.execution.authorization_decision_ref!==reference(g,context.execution)) return false;
  const policy=await import(pathToFileURL(g.value.acceptanceModule).href);
  // This sample supports file evidence in the explicitly granted workspace.
  // Manifest evidence needs a project-owned resolver, not JSON pretending to be
  // a callable store. Absent that resolver it correctly fails closed.
  const evidence = await verifyTurnEvidenceIntegrity(context.turn, { workspaceRoot: g.value.workspaceRoot });
  // Project-owned evaluation of the actual finish condition, not Runtime semantics.
  if (await policy.accept({...context,evidence,grant:g.value})!==true) return false;
  // Acceptance is a decision with its own identity, distinct from the grant that
  // authorized execution. Bind it to the reviewed acceptance evidence.
  return g.digest;
}
export async function authorizeTerminal(context) {
  const grantDigest = await acceptanceAllowed(context);
  if (!grantDigest || !context.snapshotDigest) return false;
  const decision = { ref: `acceptance:${randomUUID()}`, snapshotDigest: context.snapshotDigest };
  decisions.set(decision.ref, { ...decision, grantDigest });
  return decision;
}
export async function verifyAcceptance(decision, context) {
  const issued = decisions.get(decision.ref);
  return Boolean(issued && issued.snapshotDigest === decision.snapshotDigest && issued.snapshotDigest === context.snapshotDigest
    && issued.grantDigest === await acceptanceAllowed(context));
}
// Assignment outcomes belong to Celestan, not the reviewer or Runtime. Connect
// this verifier to the existing decision authority; the example deliberately
// issues no autonomous assignment decisions.
export async function authorizeAssignmentDecision() { return null; }
export async function verifyAssignmentDecision(decision, context) {
  const g=await grant();
  const modulePath=g.value.assignmentDecisionModule;
  if (!modulePath || !path.isAbsolute(modulePath)) return false;
  const authority=await import(pathToFileURL(modulePath).href);
  if (typeof authority.verifyAssignmentDecision!=='function') return false;
  return await authority.verifyAssignmentDecision(decision,context,g.value)===true;
}
// This sample's opaque decisions live only in this authority process. A durable
// independent authority may implement its own decision registry for later use.
