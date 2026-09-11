import { validateObjectiveTurn } from '../objective-turn.mjs';

// Adapter for a qualified Celestan host.  The host is deliberately injected:
// Runtime supplies mechanics and identity, while Celestan supplies judgment.
// This module never invents a task, completion evidence, or a wake.
function required(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required`);
  if (value.length > 512 || /[\r\n]/.test(value)) throw new Error(`${name} exceeds its bound`);
  return value;
}

function deepFreeze(value, seen = new WeakSet()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

function snapshot(value, name) {
  if (value === undefined) return undefined;
  try {
    return deepFreeze(structuredClone(value));
  } catch (error) {
    throw new Error(`${name} must be structured-cloneable: ${error.message}`);
  }
}

function explicitContext({ project, model, agent, repository, capabilities } = {}) {
  const context = {
    project: required(project, 'host.project'),
    model: required(model, 'host.model'),
    agent: required(agent, 'host.agent'),
    repository: required(repository, 'host.repository'),
  };
  if (!capabilities || typeof capabilities !== 'object' || Array.isArray(capabilities)) {
    throw new Error('host.capabilities is required');
  }
  context.capabilities = snapshot({ ...capabilities }, 'host.capabilities');
  return Object.freeze(context);
}

function actualProvenance(value) {
  if (!value || typeof value !== 'object') throw new Error('host provenance is required');
  for (const field of ['provider', 'model', 'identity_ref', 'identity_revision', 'prompt_version', 'contract_version']) {
    if (typeof value[field] !== 'string' || !value[field].trim()) throw new Error(`host provenance.${field} is required`);
  }
  return Object.freeze({
    provider: value.provider,
    model: value.model,
    identity_ref: value.identity_ref,
    identity_revision: value.identity_revision,
    prompt_version: value.prompt_version,
    contract_version: value.contract_version,
  });
}

/**
 * Build the only supported vNext objective executor seam.
 * `run` is the qualified host (for example an OpenCode process adapter). It is
 * passed the reconstructed Work Unit, not a generic proof prompt. The result
 * must be a typed objective turn and is checked before it reaches the outer
 * loop or any persistence adapter.
 */
export function createObjectiveExecutor({ run, project, model, agent, repository, capabilities } = {}) {
  if (typeof run !== 'function') throw new Error('host.run is required');
  const binding = explicitContext({ project, model, agent, repository, capabilities });
  return async function executeObjective({ workUnit, execution, wake } = {}) {
    if (!workUnit || !execution) throw new Error('workUnit and execution are required');
    if (execution.work_unit_id !== workUnit.work_unit_id) {
      throw new Error('host execution is not bound to the Work Unit');
    }
    const objective = snapshot({
      id: workUnit.objective_ref,
      work_unit_id: workUnit.work_unit_id,
      goal: workUnit.goal,
      project: workUnit.project,
      continuation: workUnit.continuation,
    }, 'host.objective');
    const result = await run({
      binding,
      objective,
      execution: snapshot(execution, 'host.execution'),
      wake: snapshot(wake, 'host.wake'),
    });
    const turn = validateObjectiveTurn(result?.turn ?? result);
    if (turn.objective_id !== workUnit.objective_ref) throw new Error('host turn objective_id does not match Work Unit objective_ref');
    return { ...turn, provenance: actualProvenance(result?.provenance) };
  };
}

export function describeObjectiveHost({ project, model, agent, repository, capabilities } = {}) {
  const binding = explicitContext({ project, model, agent, repository, capabilities });
  return { ...binding, capabilities: { ...binding.capabilities } };
}
