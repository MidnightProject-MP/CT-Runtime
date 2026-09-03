import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalizeMergedCommit, normalizeCheckResult, normalizeConvergenceSubject, normalizeWorkUnit, reconcileConvergence } from '../lib/convergence.mjs';

const base = 'a'.repeat(40);
const head = 'b'.repeat(40);
const merged = 'c'.repeat(40);
const unit = { workUnitId: 'wu-1', workOrderId: 'wo-1', project: 'project', intendedOutcome: { outcome: 'ship' }, invariants: ['tests pass'], evidenceRequirements: ['tests'] };
const subject = { workUnitId: 'wu-1', pullRequestId: 'pr-1', headSha: head, baseSha: base };

test('work unit and checks bind convergence to intent and exact PR head', () => {
  const normalized = normalizeWorkUnit(unit);
  const check = normalizeCheckResult({ checkName: 'tests', implementationVersion: 'tests-v1', result: 'pass', evidence: ['run-1'] }, unit, subject);
  assert.match(normalized.intentDigest, /^[a-f0-9]{64}$/);
  assert.equal(check.intentDigest, normalized.intentDigest);
  assert.equal(check.headSha, head);
  assert.match(check.checkId, /^[a-f0-9]{64}$/);
});

test('reconciliation returns the minimal three-state result', () => {
  assert.equal(reconcileConvergence({ workUnit: unit, subject, checks: [{ checkName: 'tests', implementationVersion: 'v1', result: 'pass' }] }).result, 'ready');
  assert.equal(reconcileConvergence({ workUnit: unit, subject, checks: [{ checkName: 'tests', implementationVersion: 'v1', result: 'fail' }] }).result, 'not ready');
  assert.equal(reconcileConvergence({ workUnit: unit, subject, checks: [] }).result, 'indeterminate');
  assert.equal(reconcileConvergence({ workUnit: unit, subject, checks: [{ checkName: 'tests', implementationVersion: 'v1', result: 'indeterminate' }] }).result, 'indeterminate');
});

test('merge canonicalization records the actual merged commit, not branch cognition', () => {
  const result = canonicalizeMergedCommit(normalizeConvergenceSubject(subject), merged);
  assert.equal(result.mergedCommitSha, merged);
  assert.equal(result.sourceHeadSha, head);
  assert.equal(result.canonicalCommit, undefined);
});

test('commit subjects require full hexadecimal SHAs', () => {
  assert.throws(() => normalizeConvergenceSubject({ ...subject, headSha: 'abc123' }), /full hexadecimal commit SHA/);
  assert.throws(() => normalizeConvergenceSubject({ ...subject, pullRequestId: undefined }), /pullRequestId/);
  assert.throws(() => normalizeCheckResult({ checkName: 'tests', implementationVersion: 'v1', result: 'pass', headSha: base }, unit, subject), /commit binding/);
});
