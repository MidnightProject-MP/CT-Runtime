import { createHash } from 'node:crypto';

export const GAS_SHEETS = Object.freeze(['executions', 'work_orders', 'wakes', 'continuations', 'observer_ledger', 'memory', 'lessons', 'identity_signals', 'foundry_signals', 'model_telemetry', 'evidence', 'chronicle', 'schema']);
export const GAS_BUDGET_MS = 240000;
export const GAS_MIN_BUDGET_MS = 30000;
export const GAS_MAX_BUDGET_MS = 300000;
export const GAS_SAFETY_RESERVE_MS = 10000;
export const GAS_EMERGENCY_BUDGET_MS = 2500;
export const GAS_CLOCK_BANDS = Object.freeze({ normal: 30000, checkpoint: 10000, stop: 0 });

export function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${stableJson(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}
export function deterministicId(kind, value) {
  return `${kind}_${createHash('sha256').update(stableJson(value)).digest('hex').slice(0, 32)}`;
}
export function bounded(value, max = 64000) { return String(value ?? '').slice(0, max); }
export function redact(value, secrets = []) {
  let text = bounded(value);
  for (const secret of secrets) if (secret) text = text.split(String(secret)).join('[REDACTED]');
  return text;
}
export function validateFreeModel(model) {
  if (!/^openrouter\/[^:]+:free$/.test(String(model || ''))) throw new Error('only an OpenRouter :free model is allowed');
  return model;
}
export function nextState(state, event) {
  const allowed = { requested: ['running', 'waiting', 'deferred'], running: ['checkpointed', 'completed', 'deferred', 'waiting'], checkpointed: ['running', 'completed', 'waiting'], deferred: ['running', 'waiting'], waiting: ['running', 'deferred'], completed: [] };
  if (!allowed[state]?.includes(event)) throw new Error(`invalid lifecycle transition ${state} -> ${event}`);
  return event;
}
export function proveAcrossWakes(rows, budget = 1) {
  const state = rows.find(r => r.key === 'proof')?.state || 'requested';
  if (state === 'requested') return { state: 'checkpointed', step: 'A', consumed: Math.min(1, budget) };
  if (state === 'checkpointed') return { state: 'completed', step: 'B', consumed: Math.min(1, budget) };
  return { state, step: null, consumed: 0 };
}
export function boundedBudget(value) { const n = Number(value); return Number.isFinite(n) ? Math.min(GAS_MAX_BUDGET_MS, Math.max(GAS_MIN_BUDGET_MS, n)) : GAS_BUDGET_MS; }
export function createClock(now = Date.now(), budget = GAS_BUDGET_MS, clock = () => Date.now(), reserve = GAS_SAFETY_RESERVE_MS) { const started = Number(now); const budgetMs = boundedBudget(budget); const deadline = started + budgetMs; const remainingMs = () => Math.max(0, deadline - clock()); const signal = () => { const r = remainingMs(); return r > reserve + GAS_CLOCK_BANDS.normal ? 'normal' : r > reserve + GAS_CLOCK_BANDS.checkpoint ? 'checkpoint' : 'stop'; }; const canStart = cost => remainingMs() >= Math.max(0, Number(typeof cost === 'object' ? cost.requiredMs || cost.operationCost || 0 : cost || 0)) + reserve; return { startedAtMs: started, budgetMs, deadlineMs: deadline, remainingMs, signal, canStart, boundary: cost => ({ allowed: canStart(cost), signal: signal(), remainingMs: remainingMs() }), shouldPreempt: cost => !canStart(cost) }; }
export function runGuard(clock, operation, estimatedMs, fn) { if (!clock?.canStart) throw new Error(`clock is required for ${operation}`); return clock.canStart({ requiredMs: Number(estimatedMs || 0), operation }) ? fn() : { status: 'preempted', operation, reason: 'insufficient-budget' }; }
export function buildContinuation(value) { const v = value || {}; const list = x => (Array.isArray(x) ? x : []).slice(0, 20).map(item => bounded(item, 640)); const result = { schema: 'ct-continuation-v1', version: 1, goal: bounded(v.goal, 1200), completed: list(v.completed), decisions: list(v.decisions), evidence: list(v.evidence), provenance: list(v.provenance), outstanding: list(v.outstanding), next_operation: bounded(v.next_operation, 240), reason: bounded(v.reason, 240), resumed_from: bounded(v.resumed_from || 'unknown-execution', 160), physical_execution_count: Math.max(1, Number(v.physical_execution_count || 1)), work_order_id: bounded(v.work_order_id, 160), execution_id: bounded(v.execution_id || v.resumed_from || 'unknown-execution', 160), wake_id: bounded(v.wake_id || 'unknown-wake', 160), continuation_id: bounded(v.continuation_id || 'unknown-continuation', 160), launch_context: bounded(JSON.stringify(v.launch_context || {}), 1200), resume_context: bounded(JSON.stringify(v.resume_context || {}), 1200) }; return validateContinuation(result); }
export function validateContinuation(v) { if (!v || v.schema !== 'ct-continuation-v1' || v.version !== 1 || !v.work_order_id || !v.goal || !v.next_operation || !v.resumed_from || !v.execution_id || !v.wake_id || !v.continuation_id || !Number.isFinite(Number(v.physical_execution_count))) throw new Error('invalid continuation'); if (bounded(v.work_order_id, 160) !== String(v.work_order_id) || Number(v.physical_execution_count) !== Math.max(1, Number(v.physical_execution_count))) throw new Error('invalid continuation bounds'); return v; }
