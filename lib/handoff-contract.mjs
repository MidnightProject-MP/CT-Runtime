// Canonical internal handoff contract.
//
// Three worker-facing dialects exist today (lib/objective-turn.mjs,
// lib/runtime.mjs validateCelestanResult, and the GAS email model contract in
// gas/gas_vnext_email.js). This module defines ONE internal representation for
// execution results and normalizes each dialect into it, so lifecycle
// decisions are made against canonical semantics rather than per-dialect
// field names.
//
// Invariants this contract exists to enforce:
//   1. A completion claim is never acceptance. Evidence capability, supplied
//      evidence references, integrity verification, and acceptance are four
//      separate facts; none may be inferred from another.
//   2. Technical failure is not a semantic wait. A failed execution is never
//      represented as a healthy `wait` to fit the contract.
//   3. Runtime identity (work unit, execution, project, fence, revision) is
//      bound from trusted runtime context; it is never accepted from a worker.
//   4. Every wake or successor suggestion is a proposal, never an authority.
//
// Bound resolution: the current dialects bound summary at 2000 (objective-turn,
// legacy runtime) and 4000 (GAS). The canonical bound is the union, 4000, so a
// valid output from any current dialect normalizes without loss. It is not a
// new permission to emit longer results.

import { validateObjectiveTurn } from './objective-turn.mjs';
import { validateCelestanResult } from './runtime.mjs';

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
  'terminalAuthorization',
  'accepted',
  'authorization_decision_ref'
]);

const MAX_TEXT = Object.freeze({
  objective_id: 160,
  summary: 4000,
  continuation_action: 1000,
  question: 1000,
  reason: 500,
  artifact: 3000
});

const MAX_EVIDENCE = 32;
const MAX_WAKE_PROPOSALS = 100;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;

function boundedText(value, name, max) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} must be a non-empty string`);
  if (value.length > max) throw new Error(`${name} exceeds bound ${max}`);
  return value;
}

// An optional field that the dialect emits as an empty string is a present-but-empty
// value, not an absent one. The GAS runtime emits `''` for every optional field it
// does not use, so requiring non-empty text here would reject valid output.
function optionalBoundedText(value, name, max) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new Error(`${name} must be a string`);
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

// An unknown key is not evidence that the dialect is wrong; it is evidence that
// this normalizer does not understand it. Fail closed rather than drop meaning.
function rejectUnknownKeys(result, source) {
  const allowed = new Set(source === 'runtime-legacy' ? ['summary', 'status'] : ['summary', 'disposition']);
  if (source === 'objective-turn') {
    ['objective_id', 'continuation', 'outcome_evidence', 'learned', 'turn_id', 'question', 'requested_next_wake'].forEach(k => allowed.add(k));
  }
  if (source === 'runtime-legacy') {
    allowed.add('requested_next_wake');
  }
  if (source === 'gas-email') {
    ['question', 'artifact'].forEach(k => allowed.add(k));
  }
  for (const key of Object.keys(result)) {
    if (!allowed.has(key)) throw new Error(`handoff has unknown key ${key}`);
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
  // The legacy dialect expresses a wake as an object {time, reason, priority,
  // project}; the objective-turn and GAS dialects express it as an ISO string.
  const raw = typeof value === 'string' ? value : (value && typeof value === 'object' ? value.time : undefined);
  if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}T.*Z$/.test(raw) || !Number.isFinite(Date.parse(raw))) {
    throw new Error('wake condition must be a UTC timestamp');
  }
  return new Date(raw).toISOString();
}

// Disposition vocabularies mapped onto canonical outcomes. `failure` is only
// reachable from a dialect that expresses technical failure; semantic dialects
// never produce it, and it is never synthesized from another outcome.
const MAPS = Object.freeze({
  'objective-turn': Object.freeze({ continue: 'continue-work', waiting: 'wait', done: 'completion-claim' }),
  'runtime-legacy': Object.freeze({ complete: 'completion-claim', continue: 'continue-work', failed: 'failure' }),
  'gas-email': Object.freeze({ continue: 'continue-work', waiting: 'wait', done: 'completion-claim' })
});

// Whether each dialect can express outcome evidence at all. This is a property
// of the dialect's contract, not of what the model claimed.
const EVIDENCE_CAPABLE = Object.freeze({
  'objective-turn': true,
  'runtime-legacy': false,
  'gas-email': false
});

// Source validation checks evidence reference shape; it does not resolve files
// or manifests, verify their integrity, or confer acceptance authority.
export function normalizeHandoff(result, context, { source } = {}) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('handoff must be an object');
  if (!context || typeof context !== 'object') throw new Error('handoff requires trusted runtime context');
  if (typeof context.objectiveRef !== 'string' || !IDENTIFIER.test(context.objectiveRef)) {
    throw new Error('context.objectiveRef must be a safe identifier');
  }
  if (!HANDOFF_SOURCES.includes(source)) throw new Error('handoff source is required');
  rejectForbiddenIdentity(result);
  rejectUnknownKeys(result, source);

  // Validate the original dialect before translation. In particular, do not
  // repair missing evidence, invalid hashes or paths into apparently valid data.
  if (source === 'objective-turn') result = validateObjectiveTurn(result);
  if (source === 'runtime-legacy') result = validateCelestanResult(result);
  if (source === 'gas-email') {
    optionalBoundedText(result.question, 'question', MAX_TEXT.question);
    optionalBoundedText(result.artifact, 'artifact', MAX_TEXT.artifact);
  }

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
    summary,
    // What this function did and did not establish about evidence. Integrity
    // verification and acceptance are separate steps with their own results.
    evidence_capable: EVIDENCE_CAPABLE[source],
    evidence_refs: [],
    evidence_verified: false
  };
  handoff.validated_result = structuredClone(result);
  handoff.evidence_refs = structuredClone(result.outcome_evidence ?? []);
  if (outcome !== 'failure') handoff.evidence_supplied = handoff.evidence_refs.length > 0;
  if (result.turn_id !== undefined) handoff.turn_id = result.turn_id;
  if (source === 'runtime-legacy') handoff.requested_next_wake = structuredClone(result.requested_next_wake);
  // An optional lesson is carried when the dialect provides one. It survives
  // normalization so a later attempt can reconstruct what was learned.
  if (result.learned !== undefined) {
    handoff.learned = optionalBoundedText(result.learned, 'learned', 2000);
  }

  if (outcome === 'failure') {
    handoff.failure_reason = boundedText(
      result.failure_reason ?? result.reason ?? 'execution failure',
      'failure_reason',
      MAX_TEXT.reason
    );
    return Object.freeze(handoff);
  }

  if (outcome === 'completion-claim') {
    const supplied = Array.isArray(result.outcome_evidence) ? result.outcome_evidence : [];
    if (EVIDENCE_CAPABLE[source] && supplied.length > MAX_EVIDENCE) {
      throw new Error('outcome_evidence exceeds bound');
    }
    handoff.evidence_refs = structuredClone(supplied);
    handoff.evidence_supplied = supplied.length > 0;
    // Compatibility shape flag ONLY: not integrity verification or acceptance.
    handoff.evidence_complete = EVIDENCE_CAPABLE[source] && supplied.length > 0;
    // A dialect may carry a bounded text deliverable that is not evidence.
    handoff.artifact = optionalBoundedText(result.artifact, 'artifact', MAX_TEXT.artifact);
    return Object.freeze(handoff);
  }

  if (outcome === 'continue-work') {
    const action = result.continuation_action ?? result.continuation?.next_action ?? result.next_action;
    // The GAS dialect carries no explicit continuation action; record that
    // honestly rather than inventing one from the summary.
    handoff.continuation_action = optionalBoundedText(action, 'continuation_action', MAX_TEXT.continuation_action);
    handoff.artifact = optionalBoundedText(result.artifact, 'artifact', MAX_TEXT.artifact);
  } else {
    // wait. A wait must name its reason OR carry the question that is the
    // reason. The GAS dialect expresses `question` and no separate reason, so a
    // question alone is a faithful, complete wait.
    const reason = result.wait_reason ?? result.continuation?.condition?.condition;
    const question = optionalBoundedText(result.question, 'question', MAX_TEXT.question);
    if (reason === undefined && !question?.trim()) {
      throw new Error('wait handoff must name its reason or carry a question');
    }
    handoff.wait_reason = reason === undefined
      ? 'awaiting human input'
      : boundedText(reason, 'wait_reason', MAX_TEXT.reason);
    handoff.question = question;
    // The condition's kind is preserved so a reconstructed turn keeps the
    // distinction between, for example, a human answer and an external arrival.
    const conditionKind = result.continuation?.condition?.kind;
    handoff.wait_condition_kind = conditionKind === undefined ? 'human_answer'
      : optionalBoundedText(conditionKind, 'wait_condition_kind', MAX_TEXT.reason);
    // A waiting GAS turn may still carry a bounded partial artifact. Preserve it
    // rather than discarding payload the worker produced.
    handoff.artifact = optionalBoundedText(result.artifact, 'artifact', MAX_TEXT.artifact);
  }

  // Wake and successor suggestions are proposals in every dialect.
  handoff.proposed_wake_at = requestWake(result.proposed_wake_at ?? result.requested_next_wake);
  handoff.proposed_wake_count = handoff.proposed_wake_at === null ? 0 : 1;
  if (handoff.proposed_wake_count > MAX_WAKE_PROPOSALS) throw new Error('proposed wake count exceeds bound');
  return Object.freeze(handoff);
}

// Smallest useful projection for a durable record or operator read.
export function projectHandoff(handoff) {
  if (!handoff || typeof handoff !== 'object' || handoff.schema !== 'celestan-handoff-v1') {
    throw new Error('not a canonical handoff');
  }
  if (!HANDOFF_OUTCOMES.includes(handoff.outcome)) throw new Error('handoff outcome is invalid');
  const projection = {
    outcome: handoff.outcome,
    source: handoff.source,
    summary: handoff.summary,
    objective_id: handoff.objective_id
  };
  if (handoff.outcome === 'completion-claim') {
    projection.evidence_capable = handoff.evidence_capable;
    projection.evidence_complete = handoff.evidence_complete;
    projection.evidence_supplied = handoff.evidence_supplied;
    projection.evidence_refs = handoff.evidence_refs;
  }
  return projection;
}
