import { mkdir, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { runPilotOnce } from './pilot.mjs';
import { deriveCoordinatorStatus } from './coordinator-status.mjs';

const DEFAULT_INTERVAL_MS = 60_000;
const CONTROL_REFUSALS = new Set([
  'E_CONCURRENCY_LIMIT',
  'E_PROJECT_AUTH_HELD',
  'E_RECONCILIATION_REQUIRED',
  'E_CANCELLED',
  'E_POOL_POLICY_CONFLICT',
  'E_STALE_REVISION',
  'E_AUTHORITY_UNAVAILABLE',
  'E_AUTHORITY_EXPIRED',
  'E_CLAIM_EXPIRED',
  'E_WORK_NOT_FOUND',
]);

function validateInterval(value) {
  if (!Number.isInteger(value) || value < 100 || value > 3_600_000) throw new RangeError('coordinator intervalMs must be an integer between 100 and 3600000');
}

export function controllerPausePath(pauseFile) {
  if (pauseFile == null) return null;
  if (!isAbsolute(pauseFile)) throw new Error('coordinator pauseFile must be absolute');
  return resolve(pauseFile);
}

export async function coordinatorPaused(pauseFile) {
  const path = controllerPausePath(pauseFile);
  if (!path) return false;
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

export async function writePauseFile(pauseFile, { coordinatorId, reason } = {}) {
  const path = controllerPausePath(pauseFile);
  if (!path) throw new Error('coordinator pauseFile is required');
  await mkdir(dirname(path), { recursive: true });
  const payload = JSON.stringify({ coordinator_id: coordinatorId ?? null, reason: reason ?? 'operator-pause', paused_at: new Date().toISOString() });
  await writeFile(path, `${payload}\n`, { encoding: 'utf8', mode: 0o600 });
  return path;
}

export async function removePauseFile(pauseFile) {
  const path = controllerPausePath(pauseFile);
  if (!path) throw new Error('coordinator pauseFile is required');
  try {
    await unlink(path);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

function dispatchView(result) {
  if (!result?.execution_id) return null;
  return {
    disposition: result.disposition ?? null,
    work_unit_id: result.work_unit_id ?? null,
    execution_id: result.execution_id ?? null,
    reason: result.reason ?? null,
    turn: result.turn ? {
      disposition: result.turn.disposition ?? null,
      summary: result.turn.summary ?? null,
    } : null,
  };
}

function recoveredView(recovered) {
  return (recovered ?? []).map(row => ({
    execution_id: row.execution_id ?? null,
    work_unit_id: row.work_unit_id ?? null,
    action: row.action ?? row.disposition ?? null,
    reason: row.reason ?? null,
  }));
}

function isControlRefusal(error) {
  if (!error) return false;
  if (CONTROL_REFUSALS.has(error.code)) return true;
  return /already claimed|changed before execution|admission snapshot changed|not justified|no longer actionable|cancellation intent/i.test(String(error.message ?? ''));
}

async function appendPass(store, payload) {
  if (typeof store.appendEvent !== 'function') return;
  await store.appendEvent({ event_id: `coordinator:${payload.project_id}:${randomUUID()}`, type: 'coordinator.pass', ...payload });
}

export async function runCoordinatorPass({
  store,
  projectId,
  workspaceRoot,
  identityFiles,
  executor,
  authority,
  timeoutMs,
  recovery,
  coordinatorId = 'coordinator',
  pauseFile = null,
  signal = null,
  now = Date.now,
  appendPassEvent = true,
}) {
  if (!store || typeof store.coordinatorLedger !== 'function') throw new TypeError('coordinator requires store.coordinatorLedger');
  if (typeof projectId !== 'string' || !projectId) throw new TypeError('coordinator projectId is required');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 3_600_000) throw new RangeError('coordinator timeoutMs must be an integer between 100 and 3600000');
  if (typeof now !== 'function') throw new TypeError('coordinator now must be a function');
  const startedAt = now();
  if (signal?.aborted) {
    return { status: 'stopped', reason: 'aborted-before-pass', started_at: new Date(startedAt).toISOString(), finished_at: new Date(startedAt).toISOString(), recovered: [], dispatch: null, status_view: null };
  }
  if (await coordinatorPaused(pauseFile)) {
    return { status: 'paused', reason: 'pause-file-present', started_at: new Date(startedAt).toISOString(), finished_at: new Date(startedAt).toISOString(), recovered: [], dispatch: null, status_view: null };
  }

  let pilotResult = null;
  let failureCode = null;
  try {
    pilotResult = await runPilotOnce({
      store,
      projectId,
      workspaceRoot,
      identityFiles,
      executor,
      authority,
      timeoutMs,
      recovery,
      now,
    });
  } catch (error) {
    if (!isControlRefusal(error)) throw error;
    failureCode = error.code ?? 'E_CONTROL_REFUSAL';
  }
  const ledger = await store.coordinatorLedger(projectId);
  const statusView = deriveCoordinatorStatus(ledger, { now: typeof now === 'function' ? now() : Date.now() });
  const finishedAt = typeof now === 'function' ? now() : Date.now();
  const recovered = recoveredView(pilotResult?.recovered);
  const dispatch = dispatchView(pilotResult);
  const passStatus = failureCode ? 'blocked'
    : pilotResult?.execution_id && pilotResult?.disposition === 'terminal' ? 'accepted'
    : pilotResult?.execution_id && pilotResult?.disposition === 'needs-review' ? 'needs-review'
    : pilotResult?.execution_id && pilotResult?.disposition === 'cancelled' ? 'cancelled'
    : pilotResult?.execution_id ? 'dispatched'
    : pilotResult?.disposition === 'blocked' ? 'blocked'
    : 'quiesced';
  const payload = {
    project_id: projectId,
    coordinator_id: coordinatorId,
    status: passStatus,
    reason: failureCode ?? pilotResult?.reason ?? statusView.next_action.reason,
    started_at: new Date(startedAt).toISOString(),
    finished_at: new Date(finishedAt).toISOString(),
    recovered,
    dispatch,
    next_action: statusView.next_action,
    pending_decisions: statusView.pending_decisions,
  };
  if (appendPassEvent) await appendPass(store, payload);
  return {
    ...payload,
    status_view: statusView,
  };
}

function wait(ms, signal) {
  if (signal?.aborted) return Promise.resolve();
  return new Promise(resolveWait => {
    let timer = null;
    let settled = false;
    const cleanup = () => {
      if (timer !== null) clearTimeout(timer);
      signal?.removeEventListener?.('abort', done);
    };
    function done() {
      if (settled) return;
      settled = true;
      cleanup();
      resolveWait();
    }
    signal?.addEventListener?.('abort', done, { once: true });
    // Abort may happen between the initial check and listener registration.
    if (signal?.aborted) done();
    else timer = setTimeout(done, ms);
  });
}

export async function runCoordinatorLoop({
  intervalMs = DEFAULT_INTERVAL_MS,
  maxPasses = Number.POSITIVE_INFINITY,
  signal = null,
  pauseFile = null,
  runPass,
  onPass = null,
  sleep = wait,
} = {}) {
  validateInterval(intervalMs);
  if (typeof maxPasses !== 'number' || Number.isNaN(maxPasses) || maxPasses < 0) throw new RangeError('coordinator maxPasses must be non-negative');
  if (typeof runPass !== 'function') throw new TypeError('coordinator loop requires runPass');
  let passes = 0;
  let paused = false;
  while (passes < maxPasses && !signal?.aborted) {
    if (await coordinatorPaused(pauseFile)) {
      paused = true;
      await sleep(intervalMs, signal);
      continue;
    }
    paused = false;
    const result = await runPass({ signal });
    passes += 1;
    if (typeof onPass === 'function') await onPass(result);
    if (passes >= maxPasses || signal?.aborted || result?.status === 'stopped') break;
    await sleep(intervalMs, signal);
  }
  return { passes, paused, stopped: Boolean(signal?.aborted) };
}
