// Canonical internal handoff contract.
//
// Three worker-facing dialects exist today (lib/objective-turn.mjs,
// lib/runtime.mjs validateCelestanResult, and the GAS email model contract).
// This module defines ONE internal representation for execution results and
// normalizes each dialect into it, so lifecycle decisions are made against
// canonical semantics rather than per-dialect field names.
//
// Two rules this contract exists to enforce:
//   1. A completion claim is never acceptance. Missing evidence makes a claim
//      insufficient for acceptance, not silently upgraded.
//   2. Technical failure is not a semantic wait. A failed execution is never
//      represented as a healthy `wait` to fit the contract.
//
// Runtime identity (work unit, execution, project, fence, revision) is bound
// from trusted runtime context here; it is never accepted from model output.

export const HANDOFF_OUTCOMES = Object.freeze([
  'continue-work',
  'wait',
  'completion-claim',
  'failure'
]);

export const HANDOFF_SOURCES = Object.freeze([
  'objective-turn',
  'runtime-legacy',
  'gas-email'
]);

// Identity keys a worker-facing result must never assert. objective_id is the
// single exception: it is asserted, then verified against runtime context.
const FORBIDDEN_KEYS = Object.freeze([
  'work_unit_id',
  'workUnitId',
  'execution_id',
  'executionId',
  'project_id',
  'projectId',
  'fence',
  'revision',
  'terminal',
  'terminal_authorized',
  'accepted',
  'authorization_decision_ref'
]);

const MAX_TEXT = Object.freeze({
  objective_id: 160,
  summary: 2000,
  continuation_action: 1000,
  question: 1000,
  reason: 500
});

const MAX_WAKE = 100;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;

function boundedText(value, name, max) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} must be a non-empty string`);
  if (value.length > max) throw new Error(`${name} exceeds bound ${max}`);
  return value;
}

function rejectForbiddenIdentity(result) {
  for (const key of Object.keys(result)) {
    if (FORBIDDEN_KEYS.includes(key)) {
      throw new Error(`handoff must not assert runtime identity: ${key}`);
    }
  }
}

function bindObjectiveId(result, context) {
  if (result.objective_id === undefined) return context.objectiveRef;
  const claimed = boundedText(result.objective_id, 'objective_id', MAX_TEXT.objective_id);
  if (!IDENTIFIER.test(claimed)) throw new Error('objective_id must be a safe identifier');
  if (claimed !== context.objectiveRef) {
    throw new Error('objective_id does not match the executing Work Unit');
  }
  return claimed;
}

function requestWake(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T.*Z$/.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new Error('wake condition must be a UTC timestamp');
  }
  return new Date(value).toISOString();
}

// Each dialect's disposition vocabulary mapped onto canonical outcomes.
// `failure` is only reachable from a dialect that expresses technical failure;
// semantic dialects never produce it, and it is never synthesized.
const OBJECTIVE_TURN = Object.freeze({
  continue: 'continue-work',
  waiting: 'wait',
  done: 'completion-claim'
});
const RUNTIME_LEGACY = Object.freeze({
  complete: 'completion-claim',
  continue: 'continue-work',
  failed: 'failure'
});
const GAS_EMAIL = Object.freeze({
  continue: 'continue-work',
  waiting: 'wait',
  done: 'completion-claim'
});

const MAPS = Object.freeze({
  'objective-turn': OBJECTIVE_TURN,
  'runtime-legacy': RUNTIME_LEGACY,
  'gas-email': GAS_EMAIL
});

// Evidence capability per dialect. A completion claim from a dialect that
// cannot carry evidence is insufficient for acceptance and must be refused by
// the acceptance transition rather than treated as proven.
const EVIDENCE_CAPABLE = Object.freeze({
  'objective-turn': true,
  'runtime-legacy': false,
  'gas-email': false
});

export function normalizeHandoff(result, context, { source } = {}) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('handoff must be an object');
  if (!context || typeof context !== 'object') throw new Error('handoff requires trusted runtime context');
  if (typeof context.objectiveRef !== 'string' || !IDENTIFIER.test(context.objectiveRef)) {
    throw new Error('context.objectiveRef must be a safe identifier');
  }
  if (!HANDOFF_SOURCES.includes(source)) throw new Error('handoff source is required');
  rejectForbiddenIdentity(result);

  const map = MAPS[source];
  const raw = result.disposition ?? result.status;
  if (typeof raw !== 'string' || !Object.prototype.hasOwnProperty.call(map, raw)) {
    throw new Error(`handoff disposition is invalid for ${source}`);
  }
  const outcome = map[raw];
  const objectiveId = bindObjectiveId(result, context);
  const summary = boundedText(result.summary, 'summary', MAX_TEXT.summary);

  const handoff = {
    schema: 'celestan-handoff-v1',
    version: 1,
    source,
    outcome,
    objective_id: objectiveId,
    summary
  };

  if (outcome === 'failure') {
    handoff.failure_reason = boundedText(
      result.failure_reason ?? result.reason ?? 'execution failure',
      'failure_reason',
      MAX_TEXT.reason
    );
    handoff.evidence_complete = null;
    return Object.freeze(handoff);
  }

  if (outcome === 'completion-claim') {
    // Evidence presence is a property of the dialect, not of the model's claim.
    handoff.evidence_complete = EVIDENCE_CAPABLE[source];
    if (handoff.evidence_complete && Array.isArray(result.outcome_evidence) && result.outcome_evidence.length) {
      handoff.evidence_count = Math.min(result.outcome_evidence.length, 32);
    }
    return Object.freeze(handoff);
  }

  if (outcome === 'continue-work') {
    handoff.continuation_action = boundedText(
      result.continuation_action ?? result.continuation?.next_action ?? result.next_action ?? 'continue the assigned work',
      'continuation_action',
      MAX_TEXT.continuation_action
    );
    // A worker-proposed wake condition is a proposal only. It never carries
    // authority; the coordinator decides whether work is dispatchable.
    handoff.proposed_wake_at = requestWake(result.proposed_wake_at ?? result.requested_next_wake);
    handoff.proposed_wake_count = handoff.proposed_wake_at === null ? 0 : 1;
    handoff.evidence_complete = null;
    return Object.freeze(handoff);
  }

  // wait. A wait must name its reason: there is no default. An unnamed wait is
  // indistinguishable from a lost execution, so it fails closed.
  const waitReason = result.wait_reason ?? result.continuation?.condition?.condition;
  if (waitReason === undefined || waitReason === null) {
    throw new Error('wait handoff must name its wait_reason');
  }
  handoff.wait_reason = boundedText(waitReason, 'wait_reason', MAX_TEXT.reason);
  handoff.question = result.question === undefined ? null
    : boundedText(result.question, 'question', MAX_TEXT.question);
  handoff.proposed_wake_at = requestWake(result.proposed_wake_at ?? result.requested_next_wake);
  handoff.proposed_wake_count = handoff.proposed_wake_at === null ? 0 : 1;
  handoff.evidence_complete = null;
  if (handoff.proposed_wake_count > MAX_WAKE) throw new Error('proposed wake count exceeds bound');
  return Object.freeze(handoff);
}

// Smallest useful projection for a durable record or operator read.
export function projectHandoff(handoff) {
  if (!handoff || typeof handoff !== 'object' || handoff.schema !== 'celestan-handoff-v1') {
    throw new Error('not a canonical handoff');
  }
  if (!HANDOFF_OUTCOMES.includes(handoff.outcome)) throw new Error('handoff outcome is invalid');
  return {
    outcome: handoff.outcome,
    source: handoff.source,
    summary: handoff.summary,
    ...(handoff.evidence_complete === null ? {} : { evidence_complete: handoff.evidence_complete }),
    ...(handoff.objective_id ? { objective_id: handoff.objective_id } : {})
  };
}
