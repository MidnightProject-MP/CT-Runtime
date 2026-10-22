import { mkdir, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { executePilotPlan, preparePilotOnce, runPilotOnce } from './pilot.mjs';
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
  const message = String(error.message ?? '');
  const coded = message.match(/^(E_[A-Z_]+):/);
  if (coded && CONTROL_REFUSALS.has(coded[1])) return true;
  return /already claimed|changed before execution|admission snapshot changed|not justified|no longer actionable|cancellation intent/i.test(message);
}

function controlRefusalCode(error) {
  if (CONTROL_REFUSALS.has(error?.code)) return error.code;
  const coded = String(error?.message ?? '').match(/^(E_[A-Z_]+):/);
  return coded && CONTROL_REFUSALS.has(coded[1]) ? coded[1] : 'E_CONTROL_REFUSAL';
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
  assignmentProfiles,
  maxNonProgress = 2,
  timeoutMs,
  recovery,
  prepared = null,
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
  const pilotOptions = {
    store,
    projectId,
    workspaceRoot,
    identityFiles,
    executor,
    authority,
    assignmentProfiles,
    maxNonProgress,
    timeoutMs,
    recovery,
    now,
  };
  try {
    pilotResult = prepared
      ? await executePilotPlan({ ...pilotOptions, prepared })
      : await runPilotOnce(pilotOptions);
  } catch (error) {
    if (!isControlRefusal(error)) throw error;
    failureCode = controlRefusalCode(error);
  }
  const ledger = await store.coordinatorLedger(projectId);
  const statusView = deriveCoordinatorStatus(ledger, { now: typeof now === 'function' ? now() : Date.now(), maxNonProgress });
  const finishedAt = typeof now === 'function' ? now() : Date.now();
  const recovered = recoveredView(pilotResult?.recovered);
  const dispatch = dispatchView(pilotResult);
  const passStatus = failureCode ? 'blocked'
    : pilotResult?.disposition === 'pending-decision' ? 'needs-review'
    : pilotResult?.disposition === 'assignment-decided' ? 'dispatched'
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

function normalizeProjects(projects) {
  if (!Array.isArray(projects) || projects.length === 0) throw new TypeError('multi-project coordinator requires at least one project');
  if (projects.length > 64) throw new RangeError('multi-project coordinator supports at most 64 projects');
  const seen = new Set();
  const normalized = projects.map(project => {
    if (!project || typeof project !== 'object') throw new TypeError('multi-project entries must be objects');
    const projectId = project.projectId;
    if (typeof projectId !== 'string' || !projectId.trim()) throw new TypeError('multi-project projectId is required');
    if (seen.has(projectId)) throw new TypeError(`duplicate project ${projectId}`);
    seen.add(projectId);
    if (typeof project.workspaceRoot !== 'string' || !project.workspaceRoot) throw new TypeError(`workspaceRoot is required for ${projectId}`);
    if (!Array.isArray(project.identityFiles) || project.identityFiles.length === 0) throw new TypeError(`identityFiles are required for ${projectId}`);
    if (project.recovery != null && (typeof project.recovery.stateDirectory !== 'string' || !project.recovery.stateDirectory)) {
      throw new TypeError(`recovery.stateDirectory is required for ${projectId}`);
    }
    return {
      projectId,
      workspaceRoot: project.workspaceRoot,
      identityFiles: project.identityFiles,
      recovery: project.recovery ?? null,
      timeoutMs: project.timeoutMs ?? null,
      maxNonProgress: project.maxNonProgress ?? null,
    };
  });
  return normalized.sort((a, b) => a.projectId.localeCompare(b.projectId));
}

async function fairOrder(store, projects) {
  if (typeof store.recentProjectPasses !== 'function' || projects.length < 2) return projects;
  const history = await store.recentProjectPasses(projects.map(project => project.projectId), 512);
  const lastPass = new Map();
  for (const row of history) {
    if (!row?.project_id || lastPass.has(row.project_id)) continue;
    // A capacity deferral is not service. Prioritize the deferred project on
    // the next pass instead of letting a busy project keep the slot.
    if (row.reason === 'capacity-deferred') continue;
    const at = Date.parse(row.created_at);
    lastPass.set(row.project_id, Number.isNaN(at) ? -Infinity : at);
  }
  return [...projects].sort((a, b) => {
    const left = lastPass.get(a.projectId) ?? -Infinity;
    const right = lastPass.get(b.projectId) ?? -Infinity;
    if (left !== right) return left - right;
    return a.projectId.localeCompare(b.projectId);
  });
}

async function capacitySnapshot(store) {
  const pool = typeof store.poolStatus === 'function' ? await store.poolStatus() : null;
  const max = pool?.max_concurrency == null ? null : Number(pool.max_concurrency);
  const used = pool?.used == null ? null : Number(pool.used);
  const available = pool?.available == null ? null : Number(pool.available);
  return {
    pool,
    max_concurrency: Number.isFinite(max) ? max : null,
    used: Number.isFinite(used) ? used : null,
    available: Number.isFinite(available) ? Math.max(0, available) : null,
    free: Number.isFinite(max) ? Math.max(0, available ?? max - (used ?? 0)) : Number.POSITIVE_INFINITY,
  };
}

function deferredPass({ project, plan, coordinatorId, startedAt, finishedAt, recovered }) {
  return {
    project_id: project.projectId,
    coordinator_id: coordinatorId,
    status: 'blocked',
    reason: 'capacity-deferred',
    started_at: new Date(startedAt).toISOString(),
    finished_at: new Date(finishedAt).toISOString(),
    recovered: recoveredView(recovered),
    dispatch: null,
    next_action: { kind: 'dispatch', work_unit_id: plan.workUnitId ?? null, reason: 'capacity-deferred' },
    pending_decisions: [],
    status_view: null,
  };
}

export async function runMultiProjectPass({
  store,
  projects,
  executor,
  authority,
  assignmentProfiles,
  maxNonProgress = 2,
  timeoutMs = 120_000,
  recovery = null,
  coordinatorId = 'coordinator',
  pauseFile = null,
  signal = null,
  now = Date.now,
  appendPassEvent = true,
}) {
  if (!store || typeof store.coordinatorLedger !== 'function') throw new TypeError('multi-project coordinator requires store.coordinatorLedger');
  if (typeof executor !== 'function') throw new TypeError('multi-project coordinator requires executor');
  if (typeof now !== 'function') throw new TypeError('multi-project coordinator now must be a function');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 3_600_000) throw new RangeError('coordinator timeoutMs must be an integer between 100 and 3600000');
  const normalized = normalizeProjects(projects);
  const startedAt = now();
  if (signal?.aborted) {
    return { status: 'stopped', reason: 'aborted-before-pass', started_at: new Date(startedAt).toISOString(), finished_at: new Date(startedAt).toISOString(), capacity: null, passes: [], recovered: [] };
  }
  if (await coordinatorPaused(pauseFile)) {
    return { status: 'paused', reason: 'pause-file-present', started_at: new Date(startedAt).toISOString(), finished_at: new Date(startedAt).toISOString(), capacity: null, passes: [], recovered: [] };
  }

  const prepared = [];
  for (const project of normalized) {
    const preparedForProject = await preparePilotOnce({
      store,
      projectId: project.projectId,
      assignmentProfiles,
      maxNonProgress: project.maxNonProgress ?? maxNonProgress,
      recovery: project.recovery ?? recovery,
    });
    prepared.push({ project, ...preparedForProject });
  }

  const orderedProjects = await fairOrder(store, prepared.map(item => item.project));
  const preparedByProject = new Map(prepared.map(item => [item.project.projectId, item]));
  const ordered = orderedProjects.map(project => preparedByProject.get(project.projectId));
  const capacity = await capacitySnapshot(store);
  const selected = [];
  const deferred = [];
  let free = capacity.free;
  for (const item of ordered) {
    const dispatchable = item.plan?.kind === 'dispatch' && item.plan.workUnitId;
    if (dispatchable && free <= 0) {
      deferred.push(item);
      continue;
    }
    if (dispatchable) free -= 1;
    selected.push(item);
  }

  const selectedResults = await Promise.allSettled(selected.map(item => runCoordinatorPass({
    store,
    projectId: item.project.projectId,
    workspaceRoot: item.project.workspaceRoot,
    identityFiles: item.project.identityFiles,
    executor,
    authority,
    assignmentProfiles,
    maxNonProgress: item.project.maxNonProgress ?? maxNonProgress,
    timeoutMs: item.project.timeoutMs ?? timeoutMs,
    recovery: item.project.recovery ?? recovery,
    prepared: { recovered: item.recovered, plan: item.plan },
    coordinatorId,
    pauseFile,
    signal,
    now,
    appendPassEvent,
  })));

  const finishedAt = now();
  const byProject = new Map();
  for (const [index, settled] of selectedResults.entries()) {
    const item = selected[index];
    if (settled.status === 'fulfilled') {
      byProject.set(item.project.projectId, settled.value);
      continue;
    }
    const error = settled.reason;
    const failed = {
      project_id: item.project.projectId,
      coordinator_id: coordinatorId,
      status: 'failed',
      reason: error?.code ?? 'pass-failed',
      started_at: new Date(startedAt).toISOString(),
      finished_at: new Date(finishedAt).toISOString(),
      recovered: recoveredView(item.recovered),
      dispatch: null,
      next_action: null,
      pending_decisions: [],
      status_view: null,
    };
    byProject.set(item.project.projectId, failed);
    if (appendPassEvent) {
      try {
        await appendPass(store, failed);
      } catch {
        // The failed pass remains visible in the aggregate even if the event
        // ledger is temporarily unavailable; the next wake can reconcile it.
      }
    }
  }
  for (const item of deferred) {
    const skipped = deferredPass({ project: item.project, plan: item.plan, coordinatorId, startedAt, finishedAt, recovered: item.recovered });
    byProject.set(item.project.projectId, skipped);
    if (appendPassEvent) await appendPass(store, skipped);
  }

  const passes = normalized.map(project => byProject.get(project.projectId));
  const statuses = new Set(passes.map(pass => pass.status));
  const status = statuses.has('failed') ? 'blocked'
    : statuses.has('dispatched') || statuses.has('accepted') || statuses.has('cancelled') ? 'dispatched'
    : statuses.has('needs-review') ? 'needs-review'
    : statuses.has('blocked') ? 'blocked'
    : 'quiesced';
  return {
    status,
    started_at: new Date(startedAt).toISOString(),
    finished_at: new Date(finishedAt).toISOString(),
    capacity: {
      max_concurrency: capacity.max_concurrency,
      used: capacity.used,
      available: capacity.available,
      deferred: deferred.map(item => item.project.projectId),
    },
    passes,
    recovered: passes.flatMap(pass => pass.recovered ?? []),
    dispatches: passes.filter(pass => pass.dispatch).map(pass => ({ project_id: pass.project_id, ...pass.dispatch })),
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
