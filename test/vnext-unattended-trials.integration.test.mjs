import test from 'node:test';
import assert from 'node:assert/strict';
import { access, appendFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { Pool } from 'pg';
import { createPilotStore } from '../lib/vnext/pilot-store.mjs';
import { deriveCoordinatorStatus } from '../lib/vnext/coordinator-status.mjs';

const enabled = process.platform === 'linux' && typeof process.env.TEST_DATABASE_URL === 'string' && process.env.TEST_DATABASE_URL.length > 0;
const profiles = {
  execution: { model: 'scripted-no-model-execution', agent: 'offline-scripted-worker', access_class: 'bounded-mutation', permissions: ['project:write'] },
  review: { model: 'scripted-no-model-review', agent: 'offline-scripted-reviewer', access_class: 'read-only', permissions: ['project:read'] },
  diagnosis: { model: 'scripted-no-model-diagnosis', agent: 'offline-scripted-diagnostician', access_class: 'read-only', permissions: ['project:read'] },
  stewardship: { model: 'scripted-no-model-stewardship', agent: 'offline-scripted-steward', access_class: 'read-only', permissions: ['project:read'] },
};

// Frozen before the campaign starts. A repeat gets a new campaign ID and new
// project/work identities; this harness never retries or resets a failed trial.
const PLAN = Object.freeze({
  name: 'milestone-3c-offline-v1',
  maxDurationMs: 220000,
  maxProjects: 4,
  maxGlobalConcurrency: 2,
  maxPassesPerTrial: 12,
  maxCliCommandMs: 30000,
  maxConcurrentCliProcesses: 3,
  workerTimeoutMs: 5000,
  scanIntervalMs: 1000,
  interruptionRecoveryWaitMs: 80000,
  maxCoordinatorRestarts: 1,
  maxOverlappingWakes: 2,
  automaticTrialRetries: 0,
  externalProviders: false,
  realModelCalls: 0,
  effectMode: 'simulated local artifact write only',
  executorBoundaryFaultInjections: 0,
  actualProcessInterruption: 'coordinator process SIGKILL with detached scripted worker observed alive',
  trials: [
    { id: 'normal-completion', attempt: 1, expected: 'terminal-and-accepted', maxObjectiveExecutions: 1, maxNonProgress: 2,
      finish_condition: 'deliverable.txt hash matches durable evidence; acceptance receipt exists; two later CLI passes dispatch nothing' },
    { id: 'fresh-input', attempt: 1, expected: 'terminal-and-accepted-with-latest-input', maxObjectiveExecutions: 2, maxNonProgress: 2,
      finish_condition: 'accepted artifact contains scripted input 2; durable consumed_input_seq equals latest_input_seq equals 2' },
    { id: 'bounded-non-progress', attempt: 1, expected: 'reconsideration-required-without-blind-retry', maxObjectiveExecutions: 2, maxNonProgress: 2,
      finish_condition: 'exactly two review request_changes decisions; next action is reconsideration-exhausted; no acceptance or further dispatch' },
    { id: 'surviving-worker', attempt: 1, expected: 'retained-result-recovered-and-accepted', maxObjectiveExecutions: 1, maxNonProgress: 2,
      finish_condition: 'actual coordinator SIGKILL while worker survives; overlapping wakes do not duplicate; restart settles retained result and accepts artifact' },
  ],
});

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function exists(file) {
  try { await access(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

async function waitFor(predicate, label, timeoutMs) {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    if (await predicate()) return;
    await delay(25);
  }
  throw new Error(`timed out waiting for ${label}`);
}

function processAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}

async function processStopped(pid) {
  try {
    const text = await readFile(`/proc/${pid}/stat`, 'utf8');
    const state = text.slice(text.lastIndexOf(')') + 2).trim().split(/\s+/)[0];
    return state === 'Z' || state === 'X';
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ESRCH') return true;
    throw error;
  }
}

async function readJsonLines(file) {
  try { return (await readFile(file, 'utf8')).split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line)); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}

function compareEffects(rows) {
  const seen = new Map();
  let duplicates = 0;
  let conflicts = 0;
  for (const row of rows) {
    const prior = seen.get(row.effect_key);
    if (prior) {
      duplicates += 1;
      if (prior !== row.effect_digest) conflicts += 1;
    } else seen.set(row.effect_key, row.effect_digest);
  }
  return { records: rows.length, duplicate_effects: duplicates, conflicting_effects: conflicts };
}

test('bounded offline Milestone 3C trial campaign records outcomes and recovery evidence', {
  skip: !enabled,
  timeout: 240000,
}, async t => {
  const campaignId = randomUUID();
  const suppliedOutputRoot = process.env.CT_VNEXT_TRIAL_ARTIFACTS_DIR;
  const campaignDirectory = suppliedOutputRoot
    ? path.join(path.resolve(suppliedOutputRoot), `campaign-${campaignId}`)
    : await mkdtemp(path.join(tmpdir(), `vnext-3c-${campaignId.slice(0, 8)}-`));
  await mkdir(campaignDirectory, { recursive: true, mode: 0o700 });
  const planPath = path.join(campaignDirectory, 'plan.json');
  const journalPath = path.join(campaignDirectory, 'journal.jsonl');
  const reportPath = path.join(campaignDirectory, 'report.json');
  const workerPath = path.resolve(import.meta.dirname, 'fixtures/vnext-unattended-scripted-worker.mjs');
  const cliPath = path.resolve(import.meta.dirname, '../bin/vnext-pilot.mjs');
  const configPath = path.join(campaignDirectory, 'pilot.json');
  const authorityPath = path.join(campaignDirectory, 'authority.mjs');
  const messagePath = path.join(campaignDirectory, 'initial-input.txt');
  const freshMessagePath = path.join(campaignDirectory, 'fresh-input.txt');
  const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 8, application_name: 'ct-runtime-vnext-3c-trials' });
  const store = createPilotStore({ pool });
  const projects = [];
  const controls = new Map();
  const workIds = new Map();
  const children = new Set();
  const workerPids = new Set();
  const journal = [];
  const artifactDigests = new Map();
  const campaignStarted = performance.now();
  const campaignWallStarted = Date.now();
  let maxAuthorityOccupancy = 0;
  let completed = false;
  let failure = null;

  const record = async (event, details = {}) => {
    const entry = { campaign_id: campaignId, at_ms: Date.now(), event, ...details };
    journal.push(entry);
    await appendFile(journalPath, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
  };
  const assertBudget = () => {
    assert.ok(performance.now() - campaignStarted < PLAN.maxDurationMs, `campaign exceeded ${PLAN.maxDurationMs}ms`);
  };
  const startCli = (action, args = []) => {
    const child = spawn(process.execPath, [cliPath, action, '--config', configPath, ...args], {
      env: { ...process.env, CT_PILOT_DATABASE_URL: process.env.TEST_DATABASE_URL },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.add(child);
    child.once('exit', () => children.delete(child));
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', value => { stdout += value; });
    child.stderr.setEncoding('utf8').on('data', value => { stderr += value; });
    const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
    return { child, exited, output: () => ({ stdout, stderr }) };
  };
  const invoke = async (action, args = [], timeoutMs = PLAN.maxCliCommandMs) => {
    const running = startCli(action, args);
    const exit = await Promise.race([running.exited, delay(timeoutMs).then(() => null)]);
    if (!exit) {
      running.child.kill('SIGKILL');
      await running.exited;
      throw new Error(`${action} exceeded the ${timeoutMs}ms CLI command budget`);
    }
    if (exit.code !== 0) throw new Error(`${action} exited with code ${exit.code ?? exit.signal}`);
    const output = running.output().stdout.trim();
    const lines = output.split(/\r?\n/).filter(Boolean);
    const jsonLines = lines.map(line => JSON.parse(line));
    return { value: jsonLines.at(-1) ?? null, jsonLines };
  };
  const observeAuthorityOccupancy = async () => {
    const count = Number((await pool.query('SELECT count(*)::int AS count FROM vnext_project_mutation_authority')).rows[0].count);
    maxAuthorityOccupancy = Math.max(maxAuthorityOccupancy, count);
    assert.ok(count <= PLAN.maxGlobalConcurrency, 'durable authority occupancy must remain within the declared global cap');
    return count;
  };
  const tick = async projectId => {
    const result = await invoke('tick', projectId ? ['--project', projectId] : []);
    await observeAuthorityOccupancy();
    return result;
  };
  const queryWork = async projectId => (await pool.query(`SELECT w.work_unit_id,w.state,w.work_revision,
      p.consumed_input_seq,COALESCE((SELECT max(i.input_seq) FROM vnext_pilot_inputs i WHERE i.work_unit_id=w.work_unit_id),0) AS latest_input_seq,
      (SELECT count(*)::int FROM vnext_pilot_results r WHERE r.work_unit_id=w.work_unit_id) AS result_count
    FROM vnext_work_units w JOIN vnext_pilot_progress p USING(work_unit_id)
    WHERE w.project_id=$1 ORDER BY w.created_at`, [projectId])).rows;
  const accepted = async workId => Number((await pool.query(`SELECT count(*)::int AS count FROM vnext_events
    WHERE event_type='work.accepted' AND payload->'result'->>'work_unit_id'=$1`, [workId])).rows[0].count) > 0;
  const objectiveExecutions = async workId => Number((await pool.query('SELECT count(*)::int AS count FROM vnext_executions WHERE work_unit_id=$1', [workId])).rows[0].count);
  const verifyArtifact = async (trialId, projectId, workId) => {
    const rows = await pool.query(`SELECT turn->'outcome_evidence'->0->>'sha256' AS sha256
      FROM vnext_pilot_results WHERE work_unit_id=$1 AND jsonb_typeof(turn->'outcome_evidence')='array'
        AND jsonb_array_length(turn->'outcome_evidence')>0 ORDER BY recorded_at DESC LIMIT 1`, [workId]);
    assert.equal(rows.rowCount, 1, `${trialId} must have one latest objective result with concrete file evidence`);
    const bytes = await readFile(path.join(controls.get(trialId).workspace, 'deliverable.txt'));
    const actual = createHash('sha256').update(bytes).digest('hex');
    assert.equal(actual, rows.rows[0].sha256, `${trialId} artifact digest must match the durable result record`);
    artifactDigests.set(trialId, actual);
    return actual;
  };
  const submit = async (projectId, slug, receipt, file) => {
    const result = await invoke('submit', ['--project', projectId, '--thread', `3c-${slug}`, '--receipt', receipt, '--message-file', file]);
    workIds.set(slug, result.value.work_unit_id);
    await record('input-submitted', { trial_id: slug, project_id: projectId, work_unit_id: result.value.work_unit_id, input_kind: receipt.includes('fresh') ? 'scripted-fresh-input' : 'initial-scripted-input' });
    return result.value;
  };
  const driveUntil = async (slug, projectId, predicate, label, maxPasses = PLAN.maxPassesPerTrial) => {
    for (let pass = 0; pass < maxPasses; pass += 1) {
      if (await predicate()) return pass;
      await tick(projectId);
      assertBudget();
    }
    assert.equal(await predicate(), true, `${slug} did not reach ${label} within ${maxPasses} passes`);
    return maxPasses;
  };

  try {
    const gitRoot = path.resolve(import.meta.dirname, '..');
    const testedCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: gitRoot, encoding: 'utf8' }).trim();
    const worktreeDirty = execFileSync('git', ['status', '--porcelain'], { cwd: gitRoot, encoding: 'utf8' }).trim().length > 0;
    const pgVersion = (await pool.query('SHOW server_version')).rows[0].server_version;
    const planRecord = {
      ...PLAN,
      campaign_id: campaignId,
      tested_commit: testedCommit,
      worktree_dirty: worktreeDirty,
      environment: { node: process.versions.node, platform: process.platform, arch: process.arch, postgresql: pgVersion },
      classification: { workers: 'deterministic scripted fixture', effects: 'simulated local artifacts only', authority: 'scripted offline test authority', real_model_calls: 0, human_rescues: 'none expected' },
      qualification_gaps: ['one isolated PostgreSQL instance and host', 'scripted workers and authority; no real model/provider calls', 'four bounded trials only; no long-duration soak or commissioning'],
      expected_native_test_skips: 0,
      failure_policy: 'append-only journal; zero automatic retries; each later campaign gets a distinct campaign and trial identity',
    };
    await writeFile(planPath, `${JSON.stringify(planRecord, null, 2)}\n`, { mode: 0o600 });
    await record('plan-written-before-trials', { plan: planRecord });
    await writeFile(messagePath, 'Improve one concrete local artifact and check its digest.\n');
    await writeFile(freshMessagePath, 'Use this newer scripted input in the checked artifact.\n');
    await pool.query("DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF; IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anonymous') THEN CREATE ROLE anonymous NOLOGIN; END IF; END $$");

    const digestUrl = new URL('../lib/vnext/operating-boundary.mjs', import.meta.url).href;
    const authoritySource = `import { digest } from ${JSON.stringify(digestUrl)};
export async function authorizeExecution({ execution }) { return { ref: '3c-scripted-execution:' + execution.execution_id }; }
export async function verifyExecution(decision, { execution }) { return decision?.ref === '3c-scripted-execution:' + execution.execution_id; }
export async function authorizeAssignmentDecision({ assignment, report }) {
  return { ref: '3c-scripted-decision:' + assignment.assignment_id, outcome: report.outcome,
    assignment_id: assignment.assignment_id, assignment_digest: assignment.assignment_digest,
    report_digest: digest(report), subject_digest: assignment.subject_digest,
    ...(report.outcome === 'request_changes' ? { requested_changes: report.requested_changes } : {}) };
}
export async function verifyAssignmentDecision(decision, { assignment, report }) {
  return decision?.assignment_id === assignment.assignment_id && decision.report_digest === digest(report);
}
export async function authorizeTerminal({ snapshotDigest }) { return { ref: '3c-scripted-accept:' + snapshotDigest, snapshotDigest }; }
export async function verifyAcceptance(decision, context) { return decision?.ref === '3c-scripted-accept:' + context.snapshotDigest && decision?.snapshotDigest === context.snapshotDigest; }
`;
    await writeFile(authorityPath, authoritySource, { mode: 0o600 });

    for (const trial of PLAN.trials) {
      const projectId = `vnext-3c-${campaignId.slice(0, 12)}-${trial.id}`;
      const workspace = path.join(campaignDirectory, 'workspaces', trial.id);
      const controlDirectory = path.join(campaignDirectory, 'control', trial.id);
      const stateDirectory = path.join(campaignDirectory, 'attempts', trial.id, 'execution');
      await mkdir(workspace, { recursive: true, mode: 0o700 });
      await mkdir(controlDirectory, { recursive: true, mode: 0o700 });
      await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
      await writeFile(path.join(workspace, 'identity.md'), `Offline trial ${trial.id}. Worker and effects are scripted test fixtures.\n`, { mode: 0o600 });
      controls.set(trial.id, { projectId, workspace, controlDirectory, stateDirectory, gate: path.join(controlDirectory, 'release-worker') });
      projects.push({
        projectId,
        workspaceRoot: workspace,
        identityFiles: [path.join(workspace, 'identity.md')],
        timeoutMs: PLAN.workerTimeoutMs,
        maxNonProgress: trial.maxNonProgress,
        executor: {
          command: process.execPath,
          args: [workerPath, trial.id, controlDirectory, `${campaignId}:${trial.id}`],
          stateDirectory,
          envNames: [],
          purposeExecutors: Object.fromEntries(['review','diagnosis','stewardship'].map(purpose => [purpose, {
            command: process.execPath,
            args: [workerPath, trial.id, controlDirectory, `${campaignId}:${trial.id}`],
            stateDirectory: path.join(campaignDirectory, 'attempts', trial.id, purpose),
            envNames: [],
          }])),
        },
      });
    }
    assert.equal(new Set(projects.map(project => project.workspaceRoot)).size, PLAN.maxProjects, 'every trial uses a distinct project workspace');
    await writeFile(configPath, JSON.stringify({
      enabled: true,
      legacyExcluded: true,
      projects,
      authorityModule: authorityPath,
      coordinatorId: `3c-${campaignId.slice(0, 12)}`,
      intervalMs: 1000,
      scanIntervalMs: PLAN.scanIntervalMs,
      timeoutMs: PLAN.workerTimeoutMs,
      maxConcurrency: PLAN.maxGlobalConcurrency,
      assignmentProfiles: profiles,
    }, null, 2), { mode: 0o600 });

    await invoke('migrate');
    for (const trial of PLAN.trials) {
      const { projectId } = controls.get(trial.id);
      await submit(projectId, trial.id, `3c-${campaignId}-${trial.id}-initial`, messagePath);
    }

    // Exercise the multi-project coordinator through the CLI before isolating
    // each planned scenario; global capacity remains at the predeclared bound.
    const aggregatePass = await tick(null);
    await record('aggregate-cli-pass', { status: aggregatePass.value?.status, dispatch_count: aggregatePass.value?.dispatches?.length ?? 0,
      capacity_limit: PLAN.maxGlobalConcurrency });

    const normal = controls.get('normal-completion');
    const normalWork = workIds.get('normal-completion');
    await driveUntil('normal-completion', normal.projectId, () => accepted(normalWork), 'accepted terminal completion');
    const quietBefore = await objectiveExecutions(normalWork);
    await tick(normal.projectId);
    await tick(normal.projectId);
    assert.equal(await objectiveExecutions(normalWork), quietBefore, 'two post-acceptance CLI passes must remain quiet');
    await record('accepted-and-quiet', { trial_id: 'normal-completion', quiet_passes: 2, objective_executions: quietBefore });

    const fresh = controls.get('fresh-input');
    const freshWork = workIds.get('fresh-input');
    await driveUntil('fresh-input', fresh.projectId, async () => Number((await pool.query(`SELECT count(*)::int AS count FROM vnext_assignments
      WHERE project_id=$1 AND purpose='review' AND decision->>'outcome'='request_changes'`, [fresh.projectId])).rows[0].count) === 1,
    'first review request-changes decision');
    const freshInput = await submit(fresh.projectId, 'fresh-input', `3c-${campaignId}-fresh-input-fresh`, freshMessagePath);
    await record('scripted-fresh-input-injected', { trial_id: 'fresh-input', work_unit_id: freshInput.work_unit_id, classified_as_human_intervention: false });
    await driveUntil('fresh-input', fresh.projectId, () => accepted(freshWork), 'accepted completion consuming the newest input');
    const freshArtifact = await readFile(path.join(fresh.workspace, 'deliverable.txt'), 'utf8');
    assert.match(freshArtifact, /Use this newer scripted input/);

    const nonProgress = controls.get('bounded-non-progress');
    const nonProgressWork = workIds.get('bounded-non-progress');
    await driveUntil('bounded-non-progress', nonProgress.projectId, async () => {
      const ledger = await store.coordinatorLedger(nonProgress.projectId);
      return deriveCoordinatorStatus(ledger, { maxNonProgress: 2 }).next_action.reason === 'reconsideration-exhausted';
    }, 'bounded reconsideration stop');
    assert.equal(await accepted(nonProgressWork), false, 'bounded non-progress must not be counted as accepted success');
    await record('bounded-non-progress-stopped', { trial_id: 'bounded-non-progress', max_non_progress: 2, human_followup_required: true });

    const interrupted = controls.get('surviving-worker');
    const interruptedWork = workIds.get('surviving-worker');
    const coordinator = startCli('run', ['--project', interrupted.projectId]);
    let workerMarker;
    await waitFor(async () => {
      if (!await exists(path.join(interrupted.controlDirectory, 'worker-started.json'))) return false;
      workerMarker = JSON.parse(await readFile(path.join(interrupted.controlDirectory, 'worker-started.json'), 'utf8'));
      const launch = await pool.query(`SELECT 1 FROM vnext_executions WHERE execution_id=$1 AND launch->>'pid'=$2`,
        [workerMarker.execution_id, String(workerMarker.pid)]);
      return launch.rowCount === 1;
    }, 'worker launch identity persisted before interruption', 30000);
    workerPids.add(workerMarker.pid);
    assert.equal(await objectiveExecutions(interruptedWork), 1);
    const overlapping = await Promise.all([
      tick(interrupted.projectId),
      tick(interrupted.projectId),
    ]);
    assert.equal(await objectiveExecutions(interruptedWork), 1, 'overlapping CLI wakes must not start a duplicate objective execution');
    const liveAuthorities = Number((await pool.query('SELECT count(*)::int AS count FROM vnext_project_mutation_authority WHERE project_id=$1', [interrupted.projectId])).rows[0].count);
    assert.equal(liveAuthorities, 1, 'one durable project authority remains while the original worker is alive');
    maxAuthorityOccupancy = Math.max(maxAuthorityOccupancy, liveAuthorities);
    assert.ok(maxAuthorityOccupancy <= PLAN.maxGlobalConcurrency);
    await record('overlapping-cli-wakes', { trial_id: 'surviving-worker', wake_count: PLAN.maxOverlappingWakes,
      resulting_statuses: overlapping.map(row => row.value?.status), objective_execution_count: 1 });

    const processExit = new Promise(resolve => coordinator.child.once('exit', (code, signal) => resolve({ code, signal })));
    coordinator.child.kill('SIGKILL');
    const killed = await Promise.race([processExit, delay(3000).then(() => null)]);
    assert.ok(killed, 'coordinator process must terminate within the interruption budget');
    assert.equal(killed.signal, 'SIGKILL', 'the campaign records an actual coordinator-process kill');
    assert.equal(processAlive(workerMarker.pid), true, 'the detached scripted worker must survive coordinator SIGKILL');
    const interruptedAt = Date.now();
    await record('coordinator-interrupted', { trial_id: 'surviving-worker', coordinator_pid: coordinator.child.pid,
      worker_pid: workerMarker.pid, execution_id: workerMarker.execution_id, interruption: 'actual coordinator process SIGKILL; worker remained live' });

    await writeFile(interrupted.gate, 'release-scripted-worker\n', { mode: 0o600 });
    await waitFor(() => exists(path.join(interrupted.controlDirectory, 'worker-finished.json')), 'surviving worker writes its retained result', 15000);
    await waitFor(() => processStopped(workerMarker.pid), 'scripted worker exits after writing its result', 10000);
    const expiry = await waitFor(async () => {
      const row = (await pool.query('SELECT claim_expires_at<=clock_timestamp() AS expired FROM vnext_work_units WHERE work_unit_id=$1', [interruptedWork])).rows[0];
      return row?.expired ? row : false;
    }, 'durable claim expiry for restart recovery', PLAN.interruptionRecoveryWaitMs);
    assert.ok(expiry.expired);

    const restartStarted = Date.now();
    const restarted = await invoke('run', ['--project', interrupted.projectId, '--max-passes', '1'], 30000);
    const recoveryPass = restarted.jsonLines.find(row => Array.isArray(row.recovered)
      && row.recovered.some(entry => entry.execution_id === workerMarker.execution_id));
    assert.ok(recoveryPass, 'restart pass must report recovery of the interrupted execution');
    const recoveryRow = recoveryPass.recovered.find(entry => entry.execution_id === workerMarker.execution_id);
    assert.equal(recoveryRow.action, 'settled-from-retained-result');
    const recoveryCompletedAt = Date.now();
    await record('coordinator-restarted-and-recovered', { trial_id: 'surviving-worker', execution_id: workerMarker.execution_id,
      action: recoveryRow.action, recovery_started_at_ms: restartStarted, recovery_completed_at_ms: recoveryCompletedAt,
      interruption_to_recovery_ms: recoveryCompletedAt - interruptedAt });
    assert.equal(await objectiveExecutions(interruptedWork), 1, 'recovery must settle the retained result without relaunching the objective execution');
    await driveUntil('surviving-worker', interrupted.projectId, () => accepted(interruptedWork), 'accepted recovered completion');
    const interruptedQuietCount = await objectiveExecutions(interruptedWork);
    await tick(interrupted.projectId);
    assert.equal(await objectiveExecutions(interruptedWork), interruptedQuietCount, 'recovered accepted work must remain quiet');
    await record('accepted-and-quiet', { trial_id: 'surviving-worker', quiet_passes: 1, objective_executions: interruptedQuietCount });

    assert.equal(await observeAuthorityOccupancy(), 0, 'all completed/reconsidered trials must release project authorities');

    for (const [control, workId] of [[normal, normalWork], [fresh, freshWork], [interrupted, interruptedWork]]) {
      assert.equal(await accepted(workId), true, `${control.projectId} must have a durable accepted completion`);
    }
    assert.equal(await accepted(nonProgressWork), false, 'reconsideration-exhausted work is not an unattended success');
    const freshWorkRow = (await queryWork(fresh.projectId)).find(row => row.work_unit_id === freshWork);
    assert.equal(Number(freshWorkRow.latest_input_seq), 2);
    assert.equal(Number(freshWorkRow.consumed_input_seq), 2, 'the accepted artifact must consume the newest input');
    const nonProgressStatus = deriveCoordinatorStatus(await store.coordinatorLedger(nonProgress.projectId), { maxNonProgress: 2 });
    assert.equal(nonProgressStatus.next_action.kind, 'reconsider');
    assert.equal(nonProgressStatus.next_action.reason, 'reconsideration-exhausted');
    const freshChanges = Number((await pool.query(`SELECT count(*)::int AS count FROM vnext_assignments
      WHERE work_unit_id=$1 AND purpose='review' AND decision->>'outcome'='request_changes'`, [freshWork])).rows[0].count);
    const nonProgressChanges = Number((await pool.query(`SELECT count(*)::int AS count FROM vnext_assignments
      WHERE work_unit_id=$1 AND purpose='review' AND decision->>'outcome'='request_changes'`, [nonProgressWork])).rows[0].count);
    assert.equal(freshChanges, 1, 'fresh-input trial contains exactly one requested-change cycle');
    assert.equal(nonProgressChanges, 2, 'non-progress trial stops exactly at its declared bound');
    await verifyArtifact('normal-completion', normal.projectId, normalWork);
    await verifyArtifact('fresh-input', fresh.projectId, freshWork);
    await verifyArtifact('bounded-non-progress', nonProgress.projectId, nonProgressWork);
    await verifyArtifact('surviving-worker', interrupted.projectId, interruptedWork);
    assert.equal(journal.filter(row => row.event === 'human-intervention').length, 0, 'no trial contains an unrecorded human intervention');
    assert.equal(journal.filter(row => row.event === 'human-rescue').length, 0, 'no unattended success is human-rescued');
    for (const trial of PLAN.trials) {
      assert.ok(await objectiveExecutions(workIds.get(trial.id)) <= trial.maxObjectiveExecutions,
        `${trial.id} stayed within its declared objective-execution bound`);
      const ledger = await store.coordinatorLedger(controls.get(trial.id).projectId);
      const status = deriveCoordinatorStatus(ledger, { maxNonProgress: trial.maxNonProgress });
      const work = (await queryWork(controls.get(trial.id).projectId)).find(row => row.work_unit_id === workIds.get(trial.id));
      const isAccepted = await accepted(workIds.get(trial.id));
      const pendingAction = !['none', undefined].includes(status.next_action?.kind);
      const stranded = !isAccepted && !pendingAction && !ledger.block && !ledger.authority && work?.state !== 'terminal';
      assert.equal(stranded, false, `${trial.id} remains durably eligible, accepted, reconsiderable, or blocked with an explicit reason`);
    }
    const scriptedEffects = [];
    for (const control of controls.values()) scriptedEffects.push(...await readJsonLines(path.join(control.controlDirectory, 'simulated-effects.jsonl')));
    const effectSummary = compareEffects(scriptedEffects);
    assert.equal(effectSummary.duplicate_effects, 0);
    assert.equal(effectSummary.conflicting_effects, 0);
    for (const trial of PLAN.trials) {
      assert.ok(await objectiveExecutions(workIds.get(trial.id)) <= trial.maxObjectiveExecutions,
        `${trial.id} stayed within its declared objective-execution bound`);
    }

    completed = true;
  } catch (error) {
    const safeMessage = String(error?.message ?? error).replace(/postgres(?:ql)?:\/\/[^\s'"`]+/gi, '[redacted-database-url]');
    failure = { name: error?.name ?? 'Error', code: typeof error?.code === 'string' ? error.code : null, message: safeMessage.slice(0, 500) };
    throw error;
  } finally {
    for (const control of controls.values()) await writeFile(control.gate, 'campaign-cleanup-release\n', { mode: 0o600 }).catch(() => {});
    const running = [...children].filter(child => child.exitCode === null && child.signalCode === null);
    for (const child of running) child.kill('SIGKILL');
    await Promise.all(running.map(child => new Promise(resolve => child.once('exit', resolve))));
    for (const pid of workerPids) { try { process.kill(-pid, 'SIGKILL'); } catch { /* worker group already exited */ } }

    const trials = [];
    for (const trial of PLAN.trials) {
      const control = controls.get(trial.id);
      const workId = workIds.get(trial.id);
      if (!control || !workId) continue;
      try {
        const ledger = await store.coordinatorLedger(control.projectId);
        const status = deriveCoordinatorStatus(ledger, { maxNonProgress: trial.maxNonProgress });
        const work = (await queryWork(control.projectId)).find(row => row.work_unit_id === workId);
        const executions = (await pool.query('SELECT count(*)::int AS total FROM vnext_executions WHERE work_unit_id=$1 OR work_unit_id IN (SELECT assignment_work_unit_id FROM vnext_assignments WHERE work_unit_id=$1)', [workId])).rows[0];
        const assignments = (await pool.query(`SELECT purpose,status,decision->>'outcome' AS outcome FROM vnext_assignments
          WHERE work_unit_id=$1 ORDER BY created_at,assignment_id`, [workId])).rows;
        const invocations = await readJsonLines(path.join(control.controlDirectory, 'worker-invocations.jsonl'));
        const effects = await readJsonLines(path.join(control.controlDirectory, 'simulated-effects.jsonl'));
        const acceptanceCount = await accepted(workId);
        const journalRows = journal.filter(row => row.trial_id === trial.id);
        const interruption = journalRows.find(row => row.event === 'coordinator-interrupted');
        const recovered = journalRows.find(row => row.event === 'coordinator-restarted-and-recovered');
        const effectSummary = compareEffects(effects);
        const nextAction = status.next_action ?? {};
        const isPendingWithAction = !acceptanceCount && !['none', undefined].includes(nextAction.kind);
        trials.push({
          trial_id: trial.id,
          trial_instance_id: `${campaignId}:${trial.id}`,
          project_id: control.projectId,
          work_unit_id: workId,
          expected: trial.expected,
          work_state: work?.state ?? null,
          accepted_outcome: acceptanceCount,
          artifact_sha256: artifactDigests.get(trial.id) ?? null,
          latest_input_seq: Number(work?.latest_input_seq ?? 0),
          consumed_input_seq: Number(work?.consumed_input_seq ?? 0),
          executions: Number(executions.total),
          objective_executions: Number(await objectiveExecutions(workId)),
          scripted_worker_invocations: invocations.length,
          real_model_calls: 0,
          review_request_changes: assignments.filter(row => row.purpose === 'review' && row.outcome === 'request_changes').length,
          review_non_progress: assignments.filter(row => row.purpose === 'review' && row.outcome === 'non_progress').length,
          reconsideration_required: nextAction.kind === 'reconsider',
          human_interventions: journalRows.filter(row => row.event === 'human-intervention'),
          human_rescued: journalRows.some(row => row.event === 'human-rescue'),
          scripted_input_events: journalRows.filter(row => row.event === 'scripted-fresh-input-injected').length,
          quiet_passes: journalRows.filter(row => row.event === 'accepted-and-quiet').reduce((total, row) => total + Number(row.quiet_passes ?? 0), 0),
          human_followup_required: nextAction.kind === 'reconsider',
          stranded_work: !acceptanceCount && !isPendingWithAction && !ledger.block && !ledger.authority ? 1 : 0,
          simulated_effects: { records: effects.length, duplicate_effects: effectSummary.duplicate_effects, conflicting_effects: effectSummary.conflicting_effects },
          actual_coordinator_interruption: Boolean(interruption),
          recovered_execution_id: recovered ? recovered.execution_id : null,
          interruption_to_recovery_ms: recovered ? recovered.interruption_to_recovery_ms : null,
          next_action: nextAction,
        });
      } catch (reportError) {
        trials.push({ trial_id: trial.id, expected: trial.expected, report_error: String(reportError?.message ?? reportError).slice(0, 300) });
      }
    }
    const allEffects = [];
    for (const entry of controls.values()) allEffects.push(...await readJsonLines(path.join(entry.controlDirectory, 'simulated-effects.jsonl')));
    const effectSummary = compareEffects(allEffects);
    const report = {
      campaign_id: campaignId,
      plan: PLAN,
      completed,
      elapsed_ms: Date.now() - campaignWallStarted,
      effects: effectSummary,
      totals: {
        trials: trials.length,
        accepted_outcomes: trials.filter(row => row.accepted_outcome).length,
        objective_executions: trials.reduce((total, row) => total + (row.objective_executions ?? 0), 0),
        scripted_worker_invocations: trials.reduce((total, row) => total + (row.scripted_worker_invocations ?? 0), 0),
        real_model_calls: 0,
        stranded_work: trials.reduce((total, row) => total + (row.stranded_work ?? 0), 0),
        human_interventions: trials.flatMap(row => row.human_interventions ?? []),
        human_rescued_trials: trials.filter(row => row.human_rescued).map(row => row.trial_id),
        sampled_peak_authority_occupancy: maxAuthorityOccupancy,
        executor_boundary_fault_injections: PLAN.executorBoundaryFaultInjections,
      },
      trials,
      verification: { native_test_skips: 0, local_test_failures: failure ? 1 : 0 },
      failures: failure ? [failure] : [],
      verification: { native_test_skips: 0, failures: failure ? 1 : 0 },
      report_source: 'PostgreSQL durable work/execution/input/result/assignment/acceptance records plus append-only scripted-worker/effect and interruption journal files; no raw process output or credentials.',
      artifact_directory: campaignDirectory,
    };
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 }).catch(() => {});
    t.diagnostic(`milestone-3c-offline-report ${JSON.stringify(report)}`);
    await pool.end();
  }
});
