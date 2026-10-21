import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { applyTurn } from './kernel.mjs';
import { canonicalHandoff } from './operating-boundary.mjs';
import { verifyTurnEvidenceIntegrity } from '../objective-turn.mjs';
import { collectWorkerResult } from './command-executor.mjs';
import { probeRunIdentity, probeProcessGroup, killProcessGroup } from './process-identity.mjs';
import { validateAssignment, validateAssignmentReport } from './assignment-contract.mjs';
import { digest } from './operating-boundary.mjs';

// Recoverable dispatch: a restarted coordinator classifies every in-doubt
// attempt from durable records (the recorded launch identity, the attempt
// directory, and a live process probe), never from timing assumptions. Only an
// attempt that provably never spawned may retry on its own; everything a
// worker could have touched settles conservatively into reconciliation.

export async function readAttemptArtifacts(directory) {
  let state = 'intact';
  try { if (!(await stat(directory)).isDirectory()) state = 'unreadable'; }
  catch (error) { state = error.code === 'ENOENT' ? 'missing' : 'unreadable'; }
  if (state !== 'intact') return { directory: state, request: false, identity: false, result: false };
  const exists = async (name) => {
    try { await stat(path.join(directory, name)); return true; }
    catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  };
  return { directory: 'intact', request: await exists('request.json'), identity: await exists('identity.json'), result: await exists('result.json') };
}

export async function classifyAttempt({ execution, artifacts, probe = probeRunIdentity, groupProbe = probeProcessGroup }) {
  const integrity = artifacts?.directory ?? 'intact';
  if (!execution.launch) {
    // No spawn was ever confirmed. Without a readable attempt directory the
    // absence of artifacts cannot be proved, so there is no provable never-
    // launched state: missing or unreadable storage is ambiguity, not absence.
    if (integrity !== 'intact') return 'unknown';
    // An intact directory with no files proves the executor never entered its
    // spawn section; with files, the process may be alive with no recorded
    // identity, which is ambiguity rather than absence.
    return artifacts.request || artifacts.identity || artifacts.result ? 'launch-unconfirmed' : 'not-launched';
  }
  const status = await probe(execution.launch);
  if (status === 'live') return 'running';
  if (status === 'unavailable') return 'unknown';
  // The launcher pid is provably gone, but descendants can outlive their
  // launcher inside the same process group: the group must also be gone.
  const group = await groupProbe(execution.launch.pgid);
  if (group === 'live') return 'running';
  if (group === 'unavailable') return 'unknown';
  if (integrity !== 'intact') return 'unknown';
  // Group and identity provably gone with readable storage: the outcome is
  // whatever the worker left behind, and the recorded result is the source.
  return artifacts.result ? 'completed' : 'exited-without-result';
}

async function markUncertain({ store, attempt, reason }) {
  await store.recoverAttempt({ projectId: attempt.execution.project_id, workUnitId: attempt.work.work_unit_id, executionId: attempt.execution.execution_id, fence: attempt.execution.fence, resolution: 'uncertain', reason });
  return 'reconciliation-required';
}

async function settleCompleted({ store, attempt, directory }) {
  let request;
  let handoff;
  let assignmentSettlementStarted = false;
  try {
    request = JSON.parse(await readFile(path.join(directory, 'request.json'), 'utf8'));
    const rawTurn = await collectWorkerResult({ request, directory });
    const assignment = attempt.execution.admission?.assignment;
    if (assignment && assignment.purpose !== 'execution') {
      validateAssignment(assignment);
      if (!request.assignment || digest(request.assignment) !== digest(assignment)) throw new Error('recovered assignment binding mismatch');
      const report = validateAssignmentReport(assignment, rawTurn);
      if (typeof store.persistAssignmentReport !== 'function') throw new Error('store does not support recovered assignment report settlement');
      assignmentSettlementStarted = true;
      const persisted = await store.persistAssignmentReport({ workUnit: attempt.work, execution: attempt.execution, assignment, report }, { recovery: true });
      return persisted.status === 'superseded' ? 'settled-stale-assignment-report' : 'settled-assignment-report';
    }
    handoff = canonicalHandoff(rawTurn, attempt.execution.admission);
  } catch (error) {
    if (assignmentSettlementStarted) throw error;
    // A retained result that cannot be read, parsed, collected, or normalized
    // is a permanent condition: it must become durable uncertainty with an
    // operator path, never a silent state that keeps the attempt in doubt.
    const reason = /evidence|hash/i.test(String(error?.message)) ? 'recovered-evidence-invalid' : 'recovered-result-invalid';
    return markUncertain({ store, attempt, reason });
  }
  if (handoff.outcome === 'failure') return markUncertain({ store, attempt, reason: 'worker-declared-failure' });
  const turn = handoff.validated_result;
  if (turn.objective_id !== attempt.work.objective_ref) return markUncertain({ store, attempt, reason: 'recovered-turn-mismatch' });
  if (turn.outcome_evidence?.length) {
    try { await verifyTurnEvidenceIntegrity(turn, { workspaceRoot: request.wake?.workspace_root, store }); }
    catch { return markUncertain({ store, attempt, reason: 'recovered-evidence-invalid' }); }
  }
  const result = applyTurn(attempt.work, attempt.execution, turn);
  result.handoff = handoff;
  try {
    await store.persistTurn(result, { recovery: true });
    return 'settled-from-retained-result';
  } catch (error) {
    if (error?.code === 'E_STALE_REVISION' && typeof store.persistSuperseded === 'function') {
      await store.persistSuperseded({ workUnit: attempt.work, execution: attempt.execution }, { recovery: true });
      return 'superseded-by-revision';
    }
    // Transient store failures leave the attempt in doubt for the next tick.
    throw error;
  }
}

export async function recoverDispatches({ store, projectId, stateDirectory, probe = probeRunIdentity, groupProbe = probeProcessGroup, kill = killProcessGroup, artifacts = readAttemptArtifacts, wait = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  if (!store || typeof store.listInDoubtAttempts !== 'function' || typeof store.recoverAttempt !== 'function') throw new Error('store does not support dispatch recovery');
  if (typeof projectId !== 'string' || !projectId) throw new Error('projectId is required');
  if (typeof stateDirectory === 'string') {
    if (!path.isAbsolute(stateDirectory)) throw new Error('an absolute executor stateDirectory is required for dispatch recovery');
  } else if (!stateDirectory || typeof stateDirectory !== 'object' || Array.isArray(stateDirectory)
    || Object.entries(stateDirectory).some(([purpose, directory]) => !['execution','review','diagnosis','stewardship'].includes(purpose) || typeof directory !== 'string' || !path.isAbsolute(directory))) {
    throw new Error('dispatch recovery requires absolute per-purpose executor state directories');
  }
  const attempts = await store.listInDoubtAttempts(projectId);
  const summaries = [];
  for (const attempt of attempts) {
    const purpose = attempt.execution.admission?.assignment?.purpose ?? 'execution';
    const root = typeof stateDirectory === 'string' ? stateDirectory : stateDirectory[purpose];
    if (!root) throw new Error(`no executor stateDirectory is configured for assignment purpose ${purpose}`);
    const directory = path.join(root, attempt.execution.execution_id);
    const summary = { work_unit_id: attempt.work.work_unit_id, execution_id: attempt.execution.execution_id };
    try {
      const attemptRevision = Number(attempt.execution.admission?.work_revision ?? attempt.work.work_revision ?? 1);
      const cancellation = typeof store.getCancellationIntent === 'function' ? await store.getCancellationIntent(attempt.work.work_unit_id) : null;
      const cancelPending = cancellation?.pending === true && Number(cancellation.work_revision) === attemptRevision;
      let observed;
      try { observed = await artifacts(directory); }
      catch { observed = { directory: 'unreadable', request: false, identity: false, result: false }; }
      let verdict = await classifyAttempt({ execution: attempt.execution, artifacts: observed, probe, groupProbe });
      if (verdict === 'running') {
        // The claim has provably expired: the runner responsible is gone. Stop
        // the orphaned process group, then poll a bounded window: SIGKILL
        // delivery is asynchronous, so a single immediate probe would race the
        // signal and misread a dying process as still running. A live attempt
        // with an active claim is never touched — listInDoubtAttempts only
        // returns expired claims.
        await kill(attempt.execution.launch.pgid);
        let status = await probe(attempt.execution.launch);
        let group = await groupProbe(attempt.execution.launch.pgid);
        for (let i = 0; i < 20 && (status === 'live' || group === 'live'); i += 1) {
          await wait(50);
          status = await probe(attempt.execution.launch);
          group = await groupProbe(attempt.execution.launch.pgid);
        }
        if (status === 'live' || group === 'live') { summary.verdict = 'running'; summary.action = 'left-running'; summaries.push(summary); continue; }
        if (status === 'unavailable' || group === 'unavailable') { summary.verdict = 'unknown'; summary.action = await markUncertain({ store, attempt, reason: 'worker-state-unverifiable' }); summaries.push(summary); continue; }
        if (cancelPending) {
          // Stopping the process proves no further effects, not the outcome of
          // effects it already performed. A killed attempt therefore always
          // preserves effect uncertainty for reconciliation.
          await store.persistCancelled({ workUnit: attempt.work, execution: attempt.execution, reconciliationRequired: true }, { recovery: true });
          summary.verdict = 'running';
          summary.action = 'settled-cancelled';
          summaries.push(summary);
          continue;
        }
        observed = await artifacts(directory);
        if (observed.directory !== 'intact') { summary.verdict = 'unknown'; summary.action = await markUncertain({ store, attempt, reason: 'attempt-artifacts-unreadable' }); summaries.push(summary); continue; }
        verdict = observed.result ? 'completed' : 'exited-without-result';
      }
      summary.verdict = verdict;
      if (cancelPending && ['not-launched', 'completed', 'exited-without-result'].includes(verdict)) {
        // The result is never accepted under a cancellation intent. A worker
        // that exited without a retained result may still have touched external
        // state, so its uncertainty is preserved as a reconciliation block.
        await store.persistCancelled({ workUnit: attempt.work, execution: attempt.execution, reconciliationRequired: verdict === 'exited-without-result' }, { recovery: true });
        summary.action = 'settled-cancelled';
      } else if (verdict === 'not-launched') {
        await store.recoverAttempt({ projectId, workUnitId: attempt.work.work_unit_id, executionId: attempt.execution.execution_id, fence: attempt.execution.fence, resolution: 'not-launched' });
        summary.action = 'retry-eligible';
      } else if (verdict === 'completed') {
        summary.action = await settleCompleted({ store, attempt, directory });
      } else {
        const reason = verdict === 'launch-unconfirmed' ? 'launch-was-not-confirmed'
          : verdict === 'unknown' ? (observed.directory === 'intact' ? 'worker-state-unverifiable' : 'attempt-artifacts-unreadable')
          : 'worker-exited-without-result';
        summary.action = await markUncertain({ store, attempt, reason });
      }
      summaries.push(summary);
    } catch (error) {
      summary.action = 'failed';
      summary.message = String(error?.message ?? error).slice(0, 200);
      summaries.push(summary);
    }
  }
  return summaries;
}
