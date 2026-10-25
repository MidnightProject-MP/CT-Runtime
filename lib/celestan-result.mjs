export const WAKE_REASONS = Object.freeze(['scheduled', 'user', 'webhook', 'github', 'retry', 'self_scheduled', 'observer', 'maintenance']);

const MAX_TEXT = 500;
const RESULT_KEYS = ['requested_next_wake', 'status', 'summary'];
const safeText = (value, field, max = MAX_TEXT) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\0\r\n]/.test(value)) throw new Error(`${field} must be a bounded safe string`);
  return value;
};

export function validateWakeReason(reason) {
  if (!WAKE_REASONS.includes(reason)) throw new Error(`wake_reason must be one of: ${WAKE_REASONS.join(', ')}`);
  return reason;
}

export function validateNextWake(value) {
  if (value === null || value === undefined) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('requested_next_wake must be an object or null');
  if (Object.keys(value).sort().join(',') !== 'priority,project,reason,time') throw new Error('requested_next_wake has unexpected fields');
  const time = safeText(value.time, 'requested_next_wake.time', 64);
  if (Number.isNaN(Date.parse(time))) throw new Error('requested_next_wake.time must be an ISO timestamp');
  return { time, reason: validateWakeReason(value.reason), priority: safeText(value.priority, 'requested_next_wake.priority', 32), project: safeText(value.project, 'requested_next_wake.project', 160) };
}

export function validateCelestanResult(value, secretValues = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== RESULT_KEYS.join(',')) throw new Error('Celestan result must contain exactly status, summary, requested_next_wake');
  const status = safeText(value.status, 'result.status', 32);
  if (!['complete', 'continue', 'failed'].includes(status)) throw new Error('result.status is invalid');
  const summary = safeText(value.summary, 'result.summary', 2000);
  const wake = validateNextWake(value.requested_next_wake);
  if (secretValues.some((s) => s && [summary, JSON.stringify(wake)].some((x) => x.includes(s)))) throw new Error('result contains a supplied secret');
  if (status === 'continue' && !wake) throw new Error('continue result must request next wake');
  return { status, summary, requested_next_wake: wake };
}
