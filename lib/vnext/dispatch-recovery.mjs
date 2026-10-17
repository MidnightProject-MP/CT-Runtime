import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { applyTurn } from './kernel.mjs';
import { canonicalHandoff } from './operating-boundary.mjs';
import { verifyTurnEvidenceIntegrity } from '../objective-turn.mjs';
import { collectWorkerResult } from './command-executor.mjs';
import { probeRunIdentity, killProcessGroup } from './process-identity.mjs';

// Recoverable dispatch: a restarted coordinator classifies every in-doubt
// attempt from durable records (the recorded launch identity, the attempt
// directory, and a live process probe), never from timing assumptions. Only an
// attempt that provably never spawned may retry on its own; everything a
// worker could have touched settles conservatively into reconciliation.

export async function readAttemptArtifacts(directory) {
  const exists = async (name) => {
    try { await stat(path.join(directory, name)); return true; }
    catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  };
  return { request: await exists('request.json'), identity: await exists('identity.json'), result: await exists('result.json') };
}

export async function classifyAttempt({ execution, artifacts, probe = probeRunIdentity }) {
  if (!execution.launch) {
    // No spawn was ever confirmed. Local artifacts prove the executor entered
    // its spawn section, which is ambiguity, not absence: the process may be
    // alive with no recorded identity.
    return artifacts.request || artifacts.identity || artifacts.result ? 'launch-unconfirmed' : 'not-launched';
  }
  const status = await probe(execution.launch);
  if (status === 'live') return 'running';
  if (status === 'unavailable') return 'unknown';
  // A recorded identity that is provably gone: the outcome is whatever the
  // worker left behind, and the recorded result is the settlement source.
  return artifacts.result ? 'completed' : 'exited-without-result';
}

async function markUncertain({ store, attempt, reason }) {
  await store.recoverAttempt({ projectId: attempt.execution.project_id, workUnitId: attempt.work.work_unit_id, executionId: attempt.execution.execution_id, fence: attempt.execution.fence, resolution: 'uncertain', reason });
  return 'reconciliation-required';
}

async function settleCompleted({ store, attempt, directory }) {
  const request = JSON.parse(await readFile(path.join(directory, 'request.json'), 'utf8'));
  const rawTurn = await collectWorkerResult({ request, directory });
  const handoff = canonicalHandoff(rawTurn, attempt.execution.admission);
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
    throw error;
  }
}

export async function recoverDispatches({ store, projectId, stateDirectory, probe = probeRunIdentity, kill = killProcessGroup, artifacts = readAttemptArtifacts } = {}) {
  if (!store || typeof store.listInDoubtAttempts !== 'function' || typeof store.recoverAttempt !== 'function') throw new Error('store does not support dispatch recovery');
  if (typeof projectId !== 'string' || !projectId) throw new Error('projectId is required');
  if (typeof stateDirectory !== 'string' || !path.isAbsolute(stateDirectory)) throw new Error('an absolute executor stateDirectory is required for dispatch recovery');
  const attempts = await store.listInDoubtAttempts(projectId);
  const summaries = [];
  for (const attempt of attempts) {
    const directory = path.join(stateDirectory, attempt.execution.execution_id);
    const summary = { work_unit_id: attempt.work.work_unit_id, execution_id: attempt.execution.execution_id };
    try {
      let verdict = await classifyAttempt({ execution: attempt.execution, artifacts: await artifacts(directory), probe });
      if (verdict === 'running') {
        // The claim has provably expired: the runner responsible is gone. Stop
        // the orphaned process group, confirm it is gone, then settle from what
        // remains. A live attempt with an active claim is never touched —
        // listInDoubtAttempts only returns expired claims.
        await kill(attempt.execution.launch.pgid);
        const status = await probe(attempt.execution.launch);
        if (status === 'live') { summary.verdict = 'running'; summary.action = 'left-running'; summaries.push(summary); continue; }
        if (status === 'unavailable') { summary.verdict = 'unknown'; summary.action = await markUncertain({ store, attempt, reason: 'worker-state-unverifiable' }); summaries.push(summary); continue; }
        verdict = (await artifacts(directory)).result ? 'completed' : 'exited-without-result';
      }
      summary.verdict = verdict;
      if (verdict === 'not-launched') {
        await store.recoverAttempt({ projectId, workUnitId: attempt.work.work_unit_id, executionId: attempt.execution.execution_id, fence: attempt.execution.fence, resolution: 'not-launched' });
        summary.action = 'retry-eligible';
      } else if (verdict === 'completed') {
        summary.action = await settleCompleted({ store, attempt, directory });
      } else {
        const reason = verdict === 'launch-unconfirmed' ? 'launch-was-not-confirmed'
          : verdict === 'unknown' ? 'worker-state-unverifiable'
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
