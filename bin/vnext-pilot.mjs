#!/usr/bin/env node
import { readFile, realpath } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { Pool } from 'pg';
import { createPilotStore } from '../lib/vnext/pilot-store.mjs';
import { createCommandExecutor } from '../lib/vnext/command-executor.mjs';
import { runCoordinatorLoop, runCoordinatorPass, runMultiProjectPass, writePauseFile, removePauseFile } from '../lib/vnext/coordinator.mjs';
import { deriveCoordinatorStatus } from '../lib/vnext/coordinator-status.mjs';
import { deriveMultiProjectStatus } from '../lib/vnext/multi-project-status.mjs';
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
const compactMany = result => ({
  status: result.status,
  reason: result.reason,
  started_at: result.started_at,
  finished_at: result.finished_at,
  capacity: result.capacity,
  recovered: result.recovered,
  dispatches: result.dispatches,
  passes: (result.passes ?? []).map(pass => ({ project_id: pass.project_id, ...compact(pass),
    failure_phase: pass.failure_phase, diagnostic: pass.diagnostic })),
});

function configuredProjects(config) {
  const source = Array.isArray(config.projects)
    ? config.projects
    : [{ projectId: config.projectId, workspaceRoot: config.workspaceRoot, identityFiles: config.identityFiles }];
  if (source.length === 0) throw new Error('at least one project is required');
  if (source.length > 64) throw new Error('at most 64 projects are supported');
  const seen = new Set();
  return source.map(project => {
    if (!project || typeof project !== 'object') throw new Error('each project must be an object');
    if (typeof project.projectId !== 'string' || !project.projectId) throw new Error('each project requires projectId');
    if (seen.has(project.projectId)) throw new Error(`duplicate project ${project.projectId}`);
    seen.add(project.projectId);
    if (typeof project.workspaceRoot !== 'string' || !path.isAbsolute(project.workspaceRoot)) throw new Error(`project ${project.projectId} requires an absolute workspaceRoot`);
    if (!Array.isArray(project.identityFiles) || project.identityFiles.length === 0) throw new Error(`project ${project.projectId} requires identityFiles`);
    return {
      projectId: project.projectId,
      workspaceRoot: project.workspaceRoot,
      identityFiles: project.identityFiles,
      executorConfig: project.executor ?? config.executor,
      timeoutMs: project.timeoutMs ?? config.timeoutMs ?? 120000,
      maxNonProgress: project.maxNonProgress ?? config.maxNonProgress ?? 2,
    };
  });
}

function selectedProjects(projects, projectId, { allowAll = false } = {}) {
  if (projectId) {
    const selected = projects.filter(project => project.projectId === projectId);
    if (selected.length !== 1) throw new Error(`project ${projectId} is not configured`);
    return selected;
  }
  if (allowAll) return projects;
  if (projects.length !== 1) throw new Error('--project is required when more than one project is configured');
  return projects;
}

function recoveryFor(executorConfig) {
  if (typeof executorConfig?.stateDirectory !== 'string' || !path.isAbsolute(executorConfig.stateDirectory)) return null;
  return { stateDirectory: {
    execution: executorConfig.stateDirectory,
    review: executorConfig.purposeExecutors?.review?.stateDirectory ?? executorConfig.stateDirectory,
    diagnosis: executorConfig.purposeExecutors?.diagnosis?.stateDirectory ?? executorConfig.stateDirectory,
    stewardship: executorConfig.purposeExecutors?.stewardship?.stateDirectory ?? executorConfig.stateDirectory,
  } };
}

function executorFor(executorConfig) {
  if (!executorConfig || typeof executorConfig !== 'object') throw new Error('executor configuration is required');
  return createCommandExecutor(executorConfig);
}

function assertPilotEnabled(config) {
  if (config.enabled !== true || config.legacyExcluded !== true) throw new Error('pilot is disabled; qualify legacy exclusion before enabling');
  if (config.assignmentProfiles !== undefined) {
    if (!config.assignmentProfiles?.execution || !config.assignmentProfiles?.review || !config.assignmentProfiles?.diagnosis || !config.assignmentProfiles?.stewardship) throw new Error('explicit assignmentProfiles for execution, review, diagnosis and stewardship are required');
  }
}

function assertExecutorProfiles(config) {
  const executors = [
    ...(config.executor ? [config.executor] : []),
    ...(Array.isArray(config.projects) ? config.projects.map(project => project?.executor).filter(Boolean) : []),
  ];
  if (executors.length === 0) throw new Error('an executor configuration is required');
  for (const executor of executors) {
    if (config.assignmentProfiles !== undefined) {
      if (!executor?.purposeExecutors?.review || !executor?.purposeExecutors?.diagnosis || !executor?.purposeExecutors?.stewardship) throw new Error('purpose-specific isolated executor profiles are required for review, diagnosis and stewardship');
    }
    if (typeof executor?.stateDirectory !== 'string' || !path.isAbsolute(executor.stateDirectory)) throw new Error('an absolute executor.stateDirectory is required for dispatch recovery');
  }
}

let pool;
let loopController = null;
try {
  if (!ACTIONS.has(action)) throw new Error('usage: vnext-pilot migrate|submit|tick|status|inspect|accept|decide-assignment|cancel|reconcile|run|pause|resume --config /absolute/config.json');
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
    const projects = action === 'migrate' ? [] : configuredProjects(config);
    const connectionString = process.env.CT_PILOT_DATABASE_URL;
    if (!connectionString) throw new Error('CT_PILOT_DATABASE_URL is required');
    pool = new Pool({ connectionString, max: 3, connectionTimeoutMillis: 10000, statement_timeout: 15000, application_name: 'ct-runtime-vnext-pilot' });
    if (action === 'migrate') {
      console.log(JSON.stringify(await migrateVNext({ pool, directory: path.join(import.meta.dirname,'../vnext-migrations') })));
    } else {
      const needsAuthority = ['tick','run','accept','decide-assignment','cancel','reconcile'].includes(action);
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
        reconciliationVerifier: authority.verifyReconciliation,
        intervalMs: config.intervalMs ?? 60000,
        // Coordinator-configured global pool capacity; null keeps accounting
        // on with no cap.
        maxConcurrency: config.maxConcurrency ?? null
      });
      if (action === 'submit') {
        const [project] = selectedProjects(projects, option('--project'));
        const file = required('--message-file');
        console.log(JSON.stringify(await store.submit({ projectId: project.projectId, threadId: required('--thread'), receiptId: required('--receipt'), message: await readFile(file,'utf8') })));
      } else if (action === 'status') {
        const selected = selectedProjects(projects, option('--project'), { allowAll: true });
        if (selected.length === 1) {
          console.log(JSON.stringify(await store.status(selected[0].projectId),null,2));
        } else {
          const status = deriveMultiProjectStatus(await Promise.all(selected.map(async project => ({
            project_id: project.projectId,
            ledger: await store.coordinatorLedger(project.projectId),
          }))), { maxNonProgress: config.maxNonProgress ?? 2, capacity: await store.poolStatus() });
          console.log(JSON.stringify(status,null,2));
        }
      } else if (action === 'inspect') {
        const selected = selectedProjects(projects, option('--project'), { allowAll: true });
        if (selected.length === 1) {
          console.log(JSON.stringify(deriveCoordinatorStatus(await store.coordinatorLedger(selected[0].projectId), { maxNonProgress: config.maxNonProgress ?? 2 }),null,2));
        } else {
          const status = deriveMultiProjectStatus(await Promise.all(selected.map(async project => ({
            project_id: project.projectId,
            ledger: await store.coordinatorLedger(project.projectId),
          }))), { maxNonProgress: config.maxNonProgress ?? 2, capacity: await store.poolStatus() });
          console.log(JSON.stringify(status,null,2));
        }
      } else if (action === 'accept') {
        const [project] = selectedProjects(projects, option('--project'));
        const workUnitId = required('--work');
        const work = await store.reconstruct({ work_unit_id: workUnitId });
        if (!work || work.project_id !== project.projectId) throw new Error('Work Unit does not belong to configured project');
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
        const [project] = selectedProjects(projects, option('--project'));
        const target = await store.assignmentDecisionTarget(project.projectId, required('--assignment'));
        if (!target) throw new Error('assignment report is not recorded for this project');
        const decision = await jsonFile(required('--decision-file'));
        console.log(JSON.stringify(await store.recordAssignmentDecision({ ...target, decision })));
      } else if (action === 'cancel') {
        const [project] = selectedProjects(projects, option('--project'));
        const workUnitId = required('--work');
        const decision = await jsonFile(required('--decision-file'));
        if (!decision?.ref) throw new Error('cancellation decision requires a ref');
        const work = await store.reconstruct({ work_unit_id: workUnitId });
        if (!work) throw new Error('Work Unit does not exist');
        console.log(JSON.stringify(await store.recordCancellation({ projectId: project.projectId, workUnitId, expectedRevision: Number(work.work_revision), decision })));
      } else if (action === 'reconcile') {
        const decision = await jsonFile(required('--decision-file'));
        if (typeof authority.verifyReconciliation !== 'function') throw new Error('authority.verifyReconciliation is required for reconciliation');
        if (!decision?.ref) throw new Error('reconciliation decision requires a ref');
        if (!projects.some(project => project.projectId === decision.project_id)) throw new Error('reconciliation decision project is not configured');
        if (typeof decision.work_unit_id !== 'string' || !decision.work_unit_id
          || typeof decision.execution_id !== 'string' || !decision.execution_id
          || !Number.isInteger(decision.fence) || decision.fence < 1) {
          throw new Error('reconciliation decision requires exact project, Work Unit, execution, and fence identity');
        }
        if (!['no_effect','effect_applied'].includes(decision.resolution)) throw new Error('reconciliation decision resolution must be no_effect or effect_applied');
        console.log(JSON.stringify(await store.reconcileFailure({ decision })));
      } else if (action === 'run') {
        assertPilotEnabled(config);
        assertExecutorProfiles(config);
        loopController = new AbortController();
        const stop = () => loopController.abort();
        process.once('SIGINT', stop);
        process.once('SIGTERM', stop);
        const maxPasses = option('--max-passes') ? Number(option('--max-passes')) : Number.POSITIVE_INFINITY;
        const pauseFile = config.pauseFile ?? option('--pause-file') ?? null;
        const selected = selectedProjects(projects, option('--project'), { allowAll: true });
        const intervalMs = config.scanIntervalMs ?? config.intervalMs ?? 60000;
        if (selected.length === 1) {
          const [project] = selected;
          const executorConfig = project.executorConfig;
          if (typeof executorConfig?.stateDirectory !== 'string' || !path.isAbsolute(executorConfig.stateDirectory)) throw new Error('an absolute executor.stateDirectory is required for dispatch recovery');
          const runPass = async ({ signal }) => runCoordinatorPass({
            store, projectId: project.projectId, workspaceRoot: await realpath(project.workspaceRoot), identityFiles: project.identityFiles, authority,
            assignmentProfiles: config.assignmentProfiles, maxNonProgress: project.maxNonProgress,
            timeoutMs: project.timeoutMs, executor: executorFor(executorConfig),
            recovery: recoveryFor(executorConfig),
            coordinatorId: config.coordinatorId ?? 'pilot-coordinator', pauseFile, signal,
          });
          const result = await runCoordinatorLoop({
            intervalMs,
            maxPasses,
            signal: loopController.signal,
            pauseFile,
            runPass,
            onPass: pass => console.log(JSON.stringify(compact(pass))),
          });
          console.log(JSON.stringify({ status: result.stopped ? 'stopped' : result.paused ? 'paused' : 'completed', passes: result.passes }));
        } else {
          const executors = new Map();
          for (const project of selected) {
            const executorConfig = project.executorConfig;
            if (typeof executorConfig?.stateDirectory !== 'string' || !path.isAbsolute(executorConfig.stateDirectory)) throw new Error('an absolute executor.stateDirectory is required for dispatch recovery');
            executors.set(project.projectId, executorFor(executorConfig));
          }
          const executor = (request, hooks) => {
            const projectExecutor = executors.get(request.workUnit.project_id);
            if (!projectExecutor) throw new Error(`no executor for project ${request.workUnit.project_id}`);
            return projectExecutor(request, hooks);
          };
          const runPass = async ({ signal }) => runMultiProjectPass({
            store,
            projects: await Promise.all(selected.map(async project => ({
              projectId: project.projectId,
              workspaceRoot: await realpath(project.workspaceRoot),
              identityFiles: project.identityFiles,
              timeoutMs: project.timeoutMs,
              maxNonProgress: project.maxNonProgress,
              recovery: recoveryFor(project.executorConfig),
            }))),
            executor,
            authority,
            assignmentProfiles: config.assignmentProfiles,
            maxNonProgress: config.maxNonProgress ?? 2,
            timeoutMs: config.timeoutMs ?? 120000,
            coordinatorId: config.coordinatorId ?? 'pilot-coordinator',
            pauseFile,
            signal,
          });
          const result = await runCoordinatorLoop({
            intervalMs,
            maxPasses,
            signal: loopController.signal,
            pauseFile,
            runPass,
            onPass: pass => console.log(JSON.stringify(compactMany(pass))),
          });
          console.log(JSON.stringify({ status: result.stopped ? 'stopped' : result.paused ? 'paused' : 'completed', passes: result.passes }));
        }
      } else {
        assertPilotEnabled(config);
        assertExecutorProfiles(config);
        const selected = selectedProjects(projects, option('--project'), { allowAll: true });
        if (selected.length === 1) {
          const [project] = selected;
          const executorConfig = project.executorConfig;
          if (typeof executorConfig?.stateDirectory !== 'string' || !path.isAbsolute(executorConfig.stateDirectory)) throw new Error('an absolute executor.stateDirectory is required for dispatch recovery');
          const result = await runCoordinatorPass({
            store, projectId: project.projectId, workspaceRoot: await realpath(project.workspaceRoot), identityFiles: project.identityFiles, authority,
            assignmentProfiles: config.assignmentProfiles, maxNonProgress: project.maxNonProgress,
            timeoutMs: project.timeoutMs, executor: executorFor(executorConfig),
            recovery: recoveryFor(executorConfig),
            coordinatorId: config.coordinatorId ?? 'pilot-coordinator', pauseFile: config.pauseFile ?? null,
          });
          console.log(JSON.stringify(compact(result)));
        } else {
          const executors = new Map();
          for (const project of selected) {
            const executorConfig = project.executorConfig;
            if (typeof executorConfig?.stateDirectory !== 'string' || !path.isAbsolute(executorConfig.stateDirectory)) throw new Error('an absolute executor.stateDirectory is required for dispatch recovery');
            executors.set(project.projectId, executorFor(executorConfig));
          }
          const executor = (request, hooks) => {
            const projectExecutor = executors.get(request.workUnit.project_id);
            if (!projectExecutor) throw new Error(`no executor for project ${request.workUnit.project_id}`);
            return projectExecutor(request, hooks);
          };
          const result = await runMultiProjectPass({
            store,
            projects: await Promise.all(selected.map(async project => ({
              projectId: project.projectId,
              workspaceRoot: await realpath(project.workspaceRoot),
              identityFiles: project.identityFiles,
              timeoutMs: project.timeoutMs,
              maxNonProgress: project.maxNonProgress,
              recovery: recoveryFor(project.executorConfig),
            }))),
            executor,
            authority,
            assignmentProfiles: config.assignmentProfiles,
            maxNonProgress: config.maxNonProgress ?? 2,
            timeoutMs: config.timeoutMs ?? 120000,
            coordinatorId: config.coordinatorId ?? 'pilot-coordinator',
            pauseFile: config.pauseFile ?? null,
          });
          console.log(JSON.stringify(compactMany(result)));
        }
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
