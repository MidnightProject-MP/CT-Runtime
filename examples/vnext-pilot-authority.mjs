// Copy outside the checkout and connect to the project's existing authority.
// This concrete grant adapter does NOT grant permissions by being installed.
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
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
  return {ref:reference(g,execution), scope:g.value.scope};
}
export async function verifyExecution(decision,context) {
  return (await authorizeExecution(context)).ref === decision.ref && context.execution.authorization_decision_ref === decision.ref;
}
export async function authorizeTerminal(context) {
  const g=await grant();
  if (context.workUnit.project_id!==g.value.projectId || !g.value.acceptanceModule || !path.isAbsolute(g.value.acceptanceModule)) return false;
  if (context.execution.authorization_decision_ref!==reference(g,context.execution)) return false;
  const policy=await import(pathToFileURL(g.value.acceptanceModule).href);
  // Project-owned evaluation of the actual finish condition, not Runtime semantics.
  return await policy.accept({...context,grant:g.value}) === true;
}
