// CT-Runtime vNext kernel.
//
// This module deliberately knows nothing about Feedback, GitHub, Observer,
// scheduling, models, hosts, or project semantics. It protects only the
// mechanical boundary between one logical Work Unit and disposable Executions.

import { randomUUID } from 'node:crypto';

export const WORK_STATES = Object.freeze(['actionable', 'waiting', 'review', 'terminal']);
export const EXECUTION_STATES = Object.freeze(['created', 'running', 'succeeded', 'failed', 'expired']);

function id(value, name) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(value)) {
    throw new Error(`${name} must be a safe identifier`);
  }
  return value;
}

function assertState(value, allowed, name) {
  if (!allowed.includes(value)) throw new Error(`${name} is invalid: ${value}`);
}

export function newExecutionId() {
  return `exec-${randomUUID()}`;
}

export function createWorkUnit({ workUnitId, objectiveRef, createdAt }) {
  return {
    work_unit_id: id(workUnitId, 'work_unit_id'),
    objective_ref: id(objectiveRef, 'objective_ref'),
    state: 'actionable',
    fence: 0,
    claim: null,
    continuation: null,
    created_at: createdAt || new Date().toISOString(),
  };
}

export function reactivateWorkUnit(workUnit) {
  assertState(workUnit.state, ['waiting'], 'work_unit.state');
  if (workUnit.claim) throw new Error('waiting work unit cannot be claimed');
  return { ...workUnit, state: 'actionable' };
}

export function claimWorkUnit(workUnit, { executionId, owner }) {
  id(executionId, 'execution_id');
  id(owner, 'owner');
  assertState(workUnit.state, ['actionable'], 'work_unit.state');
  if (workUnit.claim) throw new Error('work unit is already claimed');
  return {
    ...workUnit,
    fence: workUnit.fence + 1,
    claim: { execution_id: executionId, owner, fence: workUnit.fence + 1 },
  };
}

export function createExecution(workUnit, { executionId, owner, startedAt }) {
  id(executionId, 'execution_id');
  id(owner, 'owner');
  if (!workUnit.claim || workUnit.claim.execution_id !== executionId || workUnit.claim.owner !== owner) {
    throw new Error('execution requires the current Work Unit claim');
  }
  return {
    execution_id: executionId,
    work_unit_id: workUnit.work_unit_id,
    owner,
    fence: workUnit.claim.fence,
    state: 'created',
    started_at: startedAt || new Date().toISOString(),
    finished_at: null,
  };
}

export function startExecution(execution) {
  assertState(execution.state, ['created'], 'execution.state');
  return { ...execution, state: 'running' };
}

export function applyTurn(workUnit, execution, turn, { authorizeTerminal = () => false, finishedAt } = {}) {
  if (!workUnit.claim || workUnit.claim.execution_id !== execution.execution_id || workUnit.claim.fence !== execution.fence) {
    throw new Error('stale execution cannot mutate Work Unit');
  }
  if (execution.state !== 'running') throw new Error('execution must be running');
  const valid = turn;

  let nextState = 'actionable';
  if (valid.disposition === 'waiting') nextState = 'waiting';
  if (valid.disposition === 'done') nextState = authorizeTerminal(valid) ? 'terminal' : 'review';

  const nextWork = {
    ...workUnit,
    state: nextState,
    claim: null,
    continuation: valid.disposition === 'done' ? null : valid.continuation,
    last_execution_id: execution.execution_id,
    last_turn: valid,
  };
  const nextExecution = {
    ...execution,
    state: 'succeeded',
    finished_at: finishedAt || new Date().toISOString(),
  };
  return { workUnit: nextWork, execution: nextExecution, turn: valid };
}

export function failExecution(workUnit, execution, { finishedAt } = {}) {
  if (!workUnit.claim || workUnit.claim.execution_id !== execution.execution_id || workUnit.claim.fence !== execution.fence) {
    throw new Error('stale execution cannot mutate Work Unit');
  }
  if (!['created', 'running'].includes(execution.state)) throw new Error('execution is not active');
  return {
    workUnit: { ...workUnit, claim: null, state: 'actionable', last_execution_id: execution.execution_id },
    execution: { ...execution, state: 'failed', finished_at: finishedAt || new Date().toISOString() },
  };
}
