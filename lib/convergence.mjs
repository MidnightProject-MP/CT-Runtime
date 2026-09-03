import { sha256 } from './config.mjs';

export const CONVERGENCE_SCHEMA = 'celestan-work-unit-convergence-v1';
export const CONVERGENCE_RESULTS = Object.freeze(['ready', 'not ready', 'indeterminate']);
export const CHECK_RESULTS = Object.freeze(['pass', 'fail', 'indeterminate']);

const sha = (value, field) => {
  if (typeof value !== 'string' || !/^[a-f0-9]{40,64}$/.test(value)) throw new Error(`${field} must be a full hexadecimal commit SHA`);
  return value;
};
const text = (value, field, max = 500) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\0\r\n]/.test(value)) throw new Error(`${field} must be a bounded safe string`);
  return value;
};
const list = (value, field) => {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !item.trim() || item.length > 500 || /[\0\r\n]/.test(item))) throw new Error(`${field} must be a list of bounded safe strings`);
  return [...value];
};
const object = (value, field) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${field} must be a JSON object`);
  return JSON.parse(JSON.stringify(value));
};

export function normalizeWorkUnit(input = {}) {
  const value = {
    schema: CONVERGENCE_SCHEMA,
    workUnitId: text(input.workUnitId, 'workUnitId'),
    workOrderId: text(input.workOrderId, 'workOrderId'),
    project: text(input.project, 'project'),
    intendedOutcome: object(input.intendedOutcome, 'intendedOutcome'),
    invariants: list(input.invariants || [], 'invariants'),
    branch: input.branch == null ? null : text(input.branch, 'branch'),
    baseCommit: input.baseCommit == null ? null : sha(input.baseCommit, 'baseCommit'),
    evidenceRequirements: list(input.evidenceRequirements || [], 'evidenceRequirements')
  };
  const intentDigest = sha256({ intendedOutcome: value.intendedOutcome, invariants: value.invariants, evidenceRequirements: value.evidenceRequirements });
  if (input.intentDigest !== undefined && input.intentDigest !== intentDigest) throw new Error('intent digest is invalid');
  return { ...value, intentDigest };
}

export function normalizeConvergenceSubject(input = {}) {
  if (input.pullRequestId == null) throw new Error('pullRequestId must be a bounded safe string');
  return {
    schema: CONVERGENCE_SCHEMA,
    workUnitId: text(input.workUnitId, 'workUnitId'),
    pullRequestId: text(String(input.pullRequestId), 'pullRequestId'),
    headSha: sha(input.headSha, 'headSha'),
    baseSha: input.baseSha == null ? null : sha(input.baseSha, 'baseSha'),
    branch: input.branch == null ? null : text(input.branch, 'branch')
  };
}

export function normalizeCheckResult(input = {}, workUnit, subject) {
  const unit = normalizeWorkUnit(workUnit);
  const pr = normalizeConvergenceSubject(subject);
  if (unit.workUnitId !== pr.workUnitId) throw new Error('check work unit does not match convergence subject');
  if (input.workUnitId !== undefined && input.workUnitId !== unit.workUnitId) throw new Error('check work unit binding is invalid');
  if (input.pullRequestId !== undefined && String(input.pullRequestId) !== pr.pullRequestId) throw new Error('check pull request binding is invalid');
  if (input.headSha !== undefined && input.headSha !== pr.headSha) throw new Error('check commit binding is invalid');
  if (input.intentDigest !== undefined && input.intentDigest !== unit.intentDigest) throw new Error('check intent binding is invalid');
  const result = input.result;
  if (!CHECK_RESULTS.includes(result)) throw new Error('check result is invalid');
  const check = {
    schema: CONVERGENCE_SCHEMA,
    workUnitId: unit.workUnitId,
    pullRequestId: pr.pullRequestId,
    headSha: pr.headSha,
    checkName: text(input.checkName, 'checkName', 160),
    implementationVersion: text(input.implementationVersion, 'implementationVersion', 160),
    intentDigest: unit.intentDigest,
    result,
    evidence: list(input.evidence || [], 'evidence')
  };
  const checkId = sha256(check);
  if (input.checkId !== undefined && input.checkId !== checkId) throw new Error('check identity is invalid');
  return { ...check, checkId };
}

export function reconcileConvergence({ workUnit, subject, checks = [] } = {}) {
  const unit = normalizeWorkUnit(workUnit);
  const pr = normalizeConvergenceSubject(subject);
  if (unit.workUnitId !== pr.workUnitId) throw new Error('work unit does not match convergence subject');
  const valid = checks.map((check) => normalizeCheckResult(check, unit, pr));
  const byIdentity = new Map();
  for (const check of valid) {
    const identity = `${check.checkName}\u0000${check.implementationVersion}`;
    const prior = byIdentity.get(identity);
    if (prior && prior.checkId !== check.checkId) throw Object.assign(new Error('duplicate check identity conflict'), { category: 'conflict' });
    byIdentity.set(identity, check);
  }
  const required = new Set(unit.evidenceRequirements);
  const names = new Set(valid.map((check) => check.checkName));
  const missing = [...required].filter((name) => !names.has(name));
  const requiredChecks = valid.filter((check) => required.has(check.checkName));
  const result = missing.length || requiredChecks.some((check) => check.result === 'indeterminate')
    ? 'indeterminate'
    : requiredChecks.some((check) => check.result === 'fail') ? 'not ready'
      : required.size === 0 || [...required].every((name) => valid.find((check) => check.checkName === name)?.result === 'pass') ? 'ready' : 'indeterminate';
  return { schema: CONVERGENCE_SCHEMA, workUnitId: unit.workUnitId, pullRequestId: pr.pullRequestId, headSha: pr.headSha, result, missing, checkIds: [...byIdentity.values()].map((check) => check.checkId), canonicalCommit: null };
}

export function canonicalizeMergedCommit(subject, mergedCommitSha) {
  const pr = normalizeConvergenceSubject(subject);
  return { schema: CONVERGENCE_SCHEMA, workUnitId: pr.workUnitId, pullRequestId: pr.pullRequestId, mergedCommitSha: sha(mergedCommitSha, 'mergedCommitSha'), sourceHeadSha: pr.headSha };
}
