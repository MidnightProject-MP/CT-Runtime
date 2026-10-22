#!/usr/bin/env node
import { readFile, realpath } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { Pool } from 'pg';
import { createPilotStore } from '../lib/vnext/pilot-store.mjs';
import { createCommandExecutor } from '../lib/vnext/command-executor.mjs';
import { runCoordinatorLoop, runCoordinatorPass, writePauseFile, removePauseFile } from '../lib/vnext/coordinator.mjs';
import { deriveCoordinatorStatus } from '../lib/vnext/coordinator-status.mjs';
import { migrateVNext } from '../lib/vnext/migration.mjs';

const ACTIONS = new Set(['migrate','submit','tick','status','inspect','accept','decide-assignment','cancel','reconcile','run','pause','resume']);
const [action, ...args] = process.argv.slice(2);
const option = (name) => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
const required = (name) => { const value = option(name); if (!value) throw new Error(`${name} is required`); return value; };
const jsonFile = async file => JSON.parse(await readFile(file, 'utf8'));
const compact = result => ({
  status: result.status,
  reason: result.reason,
  recovered: result.recovered,
  dispatch: result.dispatch,
  next_action: result.next_action,
  pending_decisions: result.pending_decisions,
});
let pool;
let loopController = null;
try {
  if (!ACTIONS.has(action)) throw new Error('usage: vnext-pilot migrate|submit|tick|status|inspect|accept|cancel|reconcile|run|pause|resume --config /absolute/config.json');
  const configPath = option('--config');
  if (!configPath || !path.isAbsolute(configPath)) throw new Error('--config must be an absolute path outside the repository');
  const config = JSON.parse(await readFile(configPath,'utf8'));
  if (action === 'pause' || action === 'resume') {
    const pauseFile = config.pauseFile ?? option('--pause-file');
    if (!pauseFile) throw new Error('pauseFile must be configured or supplied with --pause-file');
    if (action === 'pause') {
      const file = await writePauseFile(pauseFile, { coordinatorId: config.coordinatorId ?? 'pilot-coordinator', reason: option('--reason') ?? 'operator-pause' });
      console.log(JSON.stringify({ status: 'paused', pause_file: file }));
    } else {
      const removed = await removePauseFile(pauseFile);
      console.log(JSON.stringify({ status: removed ? 'resumed' : 'already-running', pause_file: pauseFile }));
    }
  } else {
    const connectionString = process.env.CT_PILOT_DATABASE_URL;
    if (!connectionString) throw new Error('CT_PILOT_DATABASE_URL is required');
    pool = new Pool({ connectionString, max: 3, connectionTimeoutMillis: 10000, statement_timeout: 15000, application_name: 'ct-runtime-vnext-pilot' });
    if (action === 'migrate') {
      console.log(JSON.stringify(await migrateVNext({ pool, directory: path.join(import.meta.dirname,'../vnext-migrations') })));
    } else {
      const needsAuthority = ['tick','run','accept','decide-assignment','cancel'].includes(action);
      const authority = needsAuthority ? await import(pathToFileURL(await realpath(config.authorityModule)).href) : {};
      const store = createPilotStore({
        pool,
        authorizationVerifier: authority.verifyExecution,
        // The store independently re-evaluates the acceptance decision for this
        // exact work, execution and turn, and requires the same decision identity
        // the outer loop was granted. A reference the authority will not confirm
        // here cannot settle work as terminal.
        acceptanceVerifier: authority.verifyAcceptance,
        cancellationVerifier: authority.verifyCancellation,
        assignmentDecisionVerifier: authority.verifyAssignmentDecision,
        intervalMs: config.intervalMs ?? 60000,
        // Coordinator-configured global pool capacity; null keeps accounting
        // on with no cap.
        maxConcurrency: config.maxConcurrency ?? null
      });
      if (action === 'submit') {
        const file = required('--message-file');
        console.log(JSON.stringify(await store.submit({ projectId: config.projectId, threadId: required('--thread'), receiptId: required('--receipt'), message: await readFile(file,'utf8') })));
      } else if (action === 'status') {
        console.log(JSON.stringify(await store.status(config.projectId),null,2));
      } else if (action === 'inspect') {
        console.log(JSON.stringify(deriveCoordinatorStatus(await store.coordinatorLedger(config.projectId), { maxNonProgress: config.maxNonProgress ?? 2 }),null,2));
      } else if (action === 'accept') {
        const workUnitId = required('--work');
        const work = await store.reconstruct({ work_unit_id: workUnitId });
        if (!work || work.project_id !== config.projectId) throw new Error('Work Unit does not belong to configured project');
        let decision;
        if (option('--decision-file')) {
          decision = await jsonFile(required('--decision-file'));
        } else {
          const context = await store.getAcceptanceContext(workUnitId);
          decision = await authority.authorizeTerminal({ ...context, evidence: context.evidence });
        }
        if (!decision) throw new Error('acceptance authority did not issue a decision');
        console.log(JSON.stringify(await store.acceptWork(workUnitId, decision)));
      } else if (action === 'decide-assignment') {
        const target = await store.assignmentDecisionTarget(config.projectId, required('--assignment'));
        if (!target) throw new Error('assignment report is not recorded for this project');
        const decision = await jsonFile(required('--decision-file'));
        console.log(JSON.stringify(await store.recordAssignmentDecision({ ...target, decision })));
      } else if (action === 'cancel') {
        const workUnitId = required('--work');
        const decision = await jsonFile(required('--decision-file'));
        if (!decision?.ref) throw new Error('cancellation decision requires a ref');
        const work = await store.reconstruct({ work_unit_id: workUnitId });
        if (!work) throw new Error('Work Unit does not exist');
        console.log(JSON.stringify(await store.recordCancellation({ projectId: config.projectId, workUnitId, expectedRevision: Number(work.work_revision), decision })));
      } else if (action === 'reconcile') {
        const decision = await jsonFile(required('--decision-file'));
        if (!decision?.ref) throw new Error('reconciliation decision requires a ref');
        if (decision.project_id !== config.projectId) throw new Error('reconciliation decision project does not match configured project');
        if (typeof decision.work_unit_id !== 'string' || !decision.work_unit_id
          || typeof decision.execution_id !== 'string' || !decision.execution_id
          || !Number.isInteger(decision.fence) || decision.fence < 1) {
          throw new Error('reconciliation decision requires exact project, Work Unit, execution, and fence identity');
        }
        if (!['no_effect','effect_applied'].includes(decision.resolution)) throw new Error('reconciliation decision resolution must be no_effect or effect_applied');
        console.log(JSON.stringify(await store.reconcileFailure({
          projectId: decision.project_id,
          workUnitId: decision.work_unit_id,
          executionId: decision.execution_id,
          fence: decision.fence,
          resolution: decision.resolution,
          decisionRef: decision.ref,
        })));
      } else if (action === 'run') {
        if (config.enabled !== true || config.legacyExcluded !== true) throw new Error('pilot is disabled; qualify legacy exclusion before enabling');
        if (config.assignmentProfiles !== undefined) {
          if (!config.assignmentProfiles?.execution || !config.assignmentProfiles?.review || !config.assignmentProfiles?.diagnosis || !config.assignmentProfiles?.stewardship) throw new Error('explicit assignmentProfiles for execution, review, diagnosis and stewardship are required');
          if (!config.executor?.purposeExecutors?.review || !config.executor?.purposeExecutors?.diagnosis || !config.executor?.purposeExecutors?.stewardship) throw new Error('purpose-specific isolated executor profiles are required for review, diagnosis and stewardship');
        }
        if (typeof config.executor?.stateDirectory !== 'string' || !path.isAbsolute(config.executor.stateDirectory)) throw new Error('an absolute executor.stateDirectory is required for dispatch recovery');
        loopController = new AbortController();
        const stop = () => loopController.abort();
        process.once('SIGINT', stop);
        process.once('SIGTERM', stop);
        const maxPasses = option('--max-passes') ? Number(option('--max-passes')) : Number.POSITIVE_INFINITY;
        const pauseFile = config.pauseFile ?? option('--pause-file') ?? null;
        const recoveryDirectories = { execution: config.executor.stateDirectory,
          review: config.executor.purposeExecutors?.review?.stateDirectory ?? config.executor.stateDirectory,
          diagnosis: config.executor.purposeExecutors?.diagnosis?.stateDirectory ?? config.executor.stateDirectory,
          stewardship: config.executor.purposeExecutors?.stewardship?.stateDirectory ?? config.executor.stateDirectory };
        const runPass = async ({ signal }) => runCoordinatorPass({
          store, projectId: config.projectId, workspaceRoot: await realpath(config.workspaceRoot), identityFiles: config.identityFiles, authority,
          assignmentProfiles: config.assignmentProfiles, maxNonProgress: config.maxNonProgress ?? 2,
          timeoutMs: config.timeoutMs ?? 120000, executor: createCommandExecutor(config.executor),
          recovery: typeof config.executor?.stateDirectory === 'string' ? { stateDirectory: recoveryDirectories } : null,
          coordinatorId: config.coordinatorId ?? 'pilot-coordinator', pauseFile, signal,
        });
        const result = await runCoordinatorLoop({
          intervalMs: config.scanIntervalMs ?? config.intervalMs ?? 60000,
          maxPasses,
          signal: loopController.signal,
          pauseFile,
          runPass,
          onPass: pass => console.log(JSON.stringify(compact(pass))),
        });
        console.log(JSON.stringify({ status: result.stopped ? 'stopped' : result.paused ? 'paused' : 'completed', passes: result.passes }));
      } else {
        if (config.enabled !== true || config.legacyExcluded !== true) throw new Error('pilot is disabled; qualify legacy exclusion before enabling');
        if (config.assignmentProfiles !== undefined) {
          if (!config.assignmentProfiles?.execution || !config.assignmentProfiles?.review || !config.assignmentProfiles?.diagnosis || !config.assignmentProfiles?.stewardship) throw new Error('explicit assignmentProfiles for execution, review, diagnosis and stewardship are required');
          if (!config.executor?.purposeExecutors?.review || !config.executor?.purposeExecutors?.diagnosis || !config.executor?.purposeExecutors?.stewardship) throw new Error('purpose-specific isolated executor profiles are required for review, diagnosis and stewardship');
        }
        if (typeof config.executor?.stateDirectory !== 'string' || !path.isAbsolute(config.executor.stateDirectory)) throw new Error('an absolute executor.stateDirectory is required for dispatch recovery');
        // This is an operator assertion, not proof of deployment/exclusion.
        const recoveryDirectories = { execution: config.executor.stateDirectory,
          review: config.executor.purposeExecutors?.review?.stateDirectory ?? config.executor.stateDirectory,
          diagnosis: config.executor.purposeExecutors?.diagnosis?.stateDirectory ?? config.executor.stateDirectory,
          stewardship: config.executor.purposeExecutors?.stewardship?.stateDirectory ?? config.executor.stateDirectory };
        const result = await runCoordinatorPass({
          store, projectId: config.projectId, workspaceRoot: await realpath(config.workspaceRoot), identityFiles: config.identityFiles, authority,
          assignmentProfiles: config.assignmentProfiles, maxNonProgress: config.maxNonProgress ?? 2,
          timeoutMs: config.timeoutMs ?? 120000, executor: createCommandExecutor(config.executor),
          recovery: typeof config.executor?.stateDirectory === 'string' ? { stateDirectory: recoveryDirectories } : null,
          coordinatorId: config.coordinatorId ?? 'pilot-coordinator', pauseFile: config.pauseFile ?? null,
        });
        console.log(JSON.stringify(compact(result)));
      }
    }
  }
} catch (error) {
  // Provider and database errors may contain credentials or source text.
  console.error(JSON.stringify({ status: 'failed', code: error.code || 'PILOT_FAILED', message: 'Pilot stopped. Check configuration and durable status; do not blindly repeat uncertain effects.' }));
  process.exitCode = 1;
} finally {
  loopController?.abort();
  await pool?.end();
}
