// Objective-turn contract for the First Autonomous Objective Loop (local proof stage).
//
// A turn is one attempt to advance a stable objective. This module owns only
// semantic shape and evidence integrity; it does not depend on Runtime
// orchestration, scheduling, persistence, or completion authority.
//
// Dispositions: continue (justified work remains), waiting (work is not presently
// actionable), done (the execution claims the objective outcome is achieved).
// Nonterminal turns share one continuation contract: either work is immediately
// justified, or a named future condition would make continuation worthwhile.
// Conversation cursors are deliberately out of scope here.
import { createHash } from 'node:crypto';
import { realpath, readFile } from 'node:fs/promises';
import path from 'node:path';

export const TURN_DISPOSITIONS = Object.freeze(['continue', 'waiting', 'done']);
export const CONTINUATION_MODES = Object.freeze(['immediate', 'condition']);
const BASE_KEYS = ['objective_id', 'disposition', 'summary'];
const EXTRA_KEYS = { continue: ['continuation'], waiting: ['continuation', 'question'], done: ['outcome_evidence'] };
const MAX_TEXT = { objective_id: 160, summary: 2000, next_action: 1000, question: 1000, continuation_kind: 80, continuation_condition: 500, path: 256, execution_id: 160 };
const MAX_EVIDENCE = 32;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;

function text(value, name, max) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} must be a non-empty string`);
  if (value.length > max) throw new Error(`${name} exceeds bound ${max}`);
  return value;
}

function identifier(value, name) {
  const result = text(value, name, MAX_TEXT[name] || MAX_TEXT.execution_id);
  if (!IDENTIFIER.test(result)) throw new Error(`${name} must be a safe identifier`);
  return result;
}

function continuation(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('continuation must be an object');
  if (!CONTINUATION_MODES.includes(value.mode)) throw new Error('continuation.mode must be immediate or condition');
  if (value.mode === 'immediate') {
    for (const key of Object.keys(value).sort()) if (!['mode', 'next_action'].includes(key)) throw new Error(`continuation has unexpected key ${key}`);
    return { mode: 'immediate', next_action: text(value.next_action, 'continuation.next_action', MAX_TEXT.next_action) };
  }
  for (const key of Object.keys(value).sort()) if (!['mode', 'condition'].includes(key)) throw new Error(`continuation has unexpected key ${key}`);
  const condition = value.condition;
  if (!condition || typeof condition !== 'object' || Array.isArray(condition)) throw new Error('continuation.condition must be an object');
  for (const key of Object.keys(condition).sort()) if (!['kind', 'condition'].includes(key)) throw new Error(`continuation.condition has unexpected key ${key}`);
  return {
    mode: 'condition',
    condition: {
      kind: text(condition.kind, 'continuation.condition.kind', MAX_TEXT.continuation_kind),
      condition: text(condition.condition, 'continuation.condition.condition', MAX_TEXT.continuation_condition),
    },
  };
}

function evidenceRef(ref, name) {
  if (!ref || typeof ref !== 'object' || Array.isArray(ref)) throw new Error(`${name} must be an object`);
  if (ref.kind === 'file') {
    for (const key of Object.keys(ref).sort()) if (!['kind', 'path', 'sha256'].includes(key)) throw new Error(`${name} has unexpected key ${key}`);
    const rel = text(ref.path, `${name}.path`, MAX_TEXT.path);
    if (path.isAbsolute(rel) || rel.split(/[\\/]/).includes('..')) throw new Error(`${name}.path must be workspace-relative`);
    if (!/^[0-9a-f]{64}$/.test(ref.sha256 || '')) throw new Error(`${name}.sha256 must be 64 hex characters`);
    return { kind: 'file', path: rel, sha256: ref.sha256 };
  }
  if (ref.kind === 'manifest') {
    for (const key of Object.keys(ref).sort()) if (!['kind', 'execution_id'].includes(key)) throw new Error(`${name} has unexpected key ${key}`);
    return { kind: 'manifest', execution_id: identifier(ref.execution_id, `${name}.execution_id`) };
  }
  throw new Error(`${name}.kind must be file or manifest`);
}

export function validateObjectiveTurn(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('turn result must be an object');
  if (!TURN_DISPOSITIONS.includes(result.disposition)) throw new Error('turn disposition must be continue, waiting, or done');
  const allowed = new Set([...BASE_KEYS, ...(EXTRA_KEYS[result.disposition] || []), 'turn_id']);
  for (const key of Object.keys(result)) if (!allowed.has(key)) throw new Error(`turn result has unexpected key ${key}`);
  const turn = {
    objective_id: identifier(result.objective_id, 'objective_id'),
    disposition: result.disposition,
    summary: text(result.summary, 'summary', MAX_TEXT.summary),
  };
  if (result.turn_id !== undefined) turn.turn_id = identifier(result.turn_id, 'turn_id');
  if (result.disposition === 'continue') {
    const next = continuation(result.continuation);
    if (next.mode !== 'immediate') throw new Error('continue turn requires immediate continuation');
    turn.continuation = next;
  }
  if (result.disposition === 'waiting') {
    const next = continuation(result.continuation);
    if (next.mode !== 'condition') throw new Error('waiting turn requires condition continuation');
    turn.continuation = next;
    if (result.question !== undefined) turn.question = text(result.question, 'question', MAX_TEXT.question);
  }
  if (result.disposition === 'done') {
    if (!Array.isArray(result.outcome_evidence) || !result.outcome_evidence.length) throw new Error('done turn requires non-empty outcome_evidence');
    if (result.outcome_evidence.length > MAX_EVIDENCE) throw new Error(`outcome_evidence exceeds bound ${MAX_EVIDENCE}`);
    turn.outcome_evidence = result.outcome_evidence.map((ref, i) => evidenceRef(ref, `outcome_evidence[${i}]`));
  }
  return Object.freeze(turn);
}

// Resolves cited evidence against the real workspace/store. This verifies facts;
// it does not authorize completion or promote a done claim.
export async function verifyTurnEvidenceIntegrity(turn, { workspaceRoot, store } = {}) {
  const valid = validateObjectiveTurn(turn);
  if (valid.disposition !== 'done') throw new Error('only done turns carry outcome evidence');
  const verified = [];
  for (const ref of valid.outcome_evidence) {
    if (ref.kind === 'file') {
      if (!workspaceRoot) throw new Error('workspace root is required to verify file evidence');
      const root = await realpath(workspaceRoot);
      const absolute = path.resolve(root, ref.path);
      const resolved = await realpath(absolute);
      const relative = path.relative(root, resolved);
      if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error(`evidence escapes workspace: ${ref.path}`);
      const content = await readFile(resolved);
      const actual = createHash('sha256').update(content).digest('hex');
      if (actual !== ref.sha256) throw new Error(`evidence hash mismatch: ${ref.path}`);
      verified.push({ ...ref, bytes: content.length });
    } else if (ref.kind === 'manifest') {
      if (!store) throw new Error('store is required to verify manifest evidence');
      const manifest = await store.manifest(ref.execution_id);
      if (!manifest || manifest.execution.status !== 'success') throw new Error(`manifest evidence is not successful: ${ref.execution_id}`);
      verified.push({ ...ref, status: manifest.execution.status });
    }
  }
  return verified;
}

// Smallest useful human projection: meaningful progress, a genuine question,
// or an explicitly non-authoritative completion claim.
export function projectTurnReply(turn) {
  const valid = validateObjectiveTurn(turn);
  if (valid.disposition === 'done') return { status: 'Needs review', text: `Completion claim requires independent review: ${valid.summary}` };
  if (valid.disposition === 'waiting') {
    const ask = valid.question ? ` Question: ${valid.question}` : '';
    return { status: `Waiting: ${valid.continuation.condition.kind}`, text: `${valid.summary}${ask}` };
  }
  return { status: 'Working', text: `${valid.summary} Next: ${valid.continuation.next_action}` };
}
