#!/usr/bin/env node
import { access, copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { Pool } from 'pg';
import { applyCleanupResults } from './vnext-first-launch-cleanup.mjs';

const root = path.resolve(import.meta.dirname, '..');
const node = process.execPath;
const adminUrl = process.env.POSTGRES_URL;
const keep = process.argv.includes('--keep');
const worker = path.join(root, 'test/fixtures/vnext-first-launch-worker.mjs');
const authorityFixture = path.join(root, 'test/fixtures/vnext-first-launch-authority.mjs');
const readOnlyExecutor = path.join(root, 'test/fixtures/vnext-read-only-exec.sh');
const expectedMigrationVersions = (await readdir(path.join(root, 'vnext-migrations')))
  .filter(file => /^\d+_.*\.sql$/.test(file))
  .map(file => Number(file.match(/^\d+/)[0]))
  .sort((a, b) => a - b);

function fail(message) {
  throw new Error(message);
}

function requireLocalAdminUrl(value) {
  if (!value) fail('POSTGRES_URL is required for an isolated local qualification database');
  const url = new URL(value);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.pathname !== '/ctruntime') {
    fail('POSTGRES_URL must target the local disposable ctruntime database');
  }
  return url;
}

function run(command, args, { cwd = root, env = process.env, timeoutMs = 30000 } = {}) {
  const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  let timedOut = false;
  child.stdout?.on('data', chunk => { stdout += chunk; });
  child.stderr?.on('data', chunk => { stderr += chunk; });
  const done = new Promise(resolve => {
    let settled = false;
    child.once('error', () => { settled = true; resolve({ code: 127, stdout, stderr, timedOut }); });
    child.once('close', code => { if (!settled) resolve({ code: code ?? 1, stdout, stderr, timedOut }); });
  });
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill('SIGKILL');
  }, timeoutMs);
  return done.finally(() => clearTimeout(timer));
}

function start(command, args, { cwd = root, env = process.env } = {}) {
  const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  let result = null;
  child.stdout?.on('data', chunk => { stdout += chunk; });
  child.stderr?.on('data', chunk => { stderr += chunk; });
  const done = new Promise(resolve => {
    let settled = false;
    child.once('error', () => { settled = true; result = { code: 127, stdout, stderr }; resolve(result); });
    child.once('close', code => { if (!settled) { result = { code: code ?? 1, stdout, stderr }; resolve(result); } });
  });
  return { child, done, result: () => result };
}

function parseJson(result, action) {
  if (result.code !== 0 || result.timedOut) fail(`${action} failed with exit ${result.code}${result.timedOut ? ' (timeout)' : ''}`);
  try { return JSON.parse(result.stdout.trim()); }
  catch { fail(`${action} did not return valid JSON`); }
}

async function waitFor(predicate, label, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await sleep(25);
  }
  fail(`timed out waiting for ${label}`);
}

async function exists(file) {
  try { await access(file); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

async function isAbsent(file) {
  try { await lstat(file); return false; }
  catch (error) { if (error.code === 'ENOENT') return true; throw error; }
}

async function countCoordinatorPasses(pool, coordinatorId) {
  const result = await pool.query(`SELECT count(*)::int AS count FROM vnext_events
    WHERE event_type='coordinator.pass' AND payload->>'coordinator_id'=$1`, [coordinatorId]);
  return Number(result.rows[0].count);
}

async function workState(pool, workUnitId) {
  const result = await pool.query('SELECT state,claim_execution_id FROM vnext_work_units WHERE work_unit_id=$1', [workUnitId]);
  if (!result.rows[0]) fail('qualification Work Unit disappeared');
  return result.rows[0];
}

async function unitExecutionCount(pool, projectId, workUnitId) {
  const result = await pool.query(`SELECT count(*)::int AS count FROM vnext_executions e
    WHERE e.project_id=$1 AND (e.work_unit_id=$2 OR e.work_unit_id IN
      (SELECT assignment_work_unit_id FROM vnext_assignments WHERE work_unit_id=$2))`, [projectId, workUnitId]);
  return Number(result.rows[0].count);
}

async function localDiagnostics(stateRoot) {
  const attemptsRoot = path.join(stateRoot, 'attempts');
  const attempts = [];
  for (const purpose of ['execution', 'review', 'diagnosis', 'stewardship']) {
    const directory = path.join(attemptsRoot, purpose);
    let entries = [];
    try { entries = await readdir(directory); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    for (const entry of entries) {
      const attemptDirectory = path.join(directory, entry);
      let request = null;
      try { request = JSON.parse(await readFile(path.join(attemptDirectory, 'request.json'), 'utf8')); }
      catch {}
      attempts.push({
        purpose_directory: purpose,
        assignment_purpose: request?.assignment?.purpose ?? 'execution',
        execution_id: request?.execution?.execution_id ?? null,
        attempt: request?.execution?.attempt ?? null,
        identity_recorded: await exists(path.join(attemptDirectory, 'identity.json')),
        result_written: await exists(path.join(attemptDirectory, 'result.json')),
      });
    }
  }
  let invocations = [];
  try {
    invocations = (await readFile(path.join(stateRoot, 'control', 'worker-invocations.jsonl'), 'utf8'))
      .split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line).purpose);
  } catch {}
  return {
    attempts,
    worker_invocation_purposes: invocations,
    control_markers: {
      worker_started: await exists(path.join(stateRoot, 'control', 'worker-started.json')),
      worker_finished: await exists(path.join(stateRoot, 'control', 'worker-finished.json')),
      release_gate: await exists(path.join(stateRoot, 'control', 'release-worker')),
    },
  };
}

async function stopUnit(unit) {
  if (!unit) return { ok: true, details: { status: 'not-created' } };
  const configHome = process.env.XDG_CONFIG_HOME || path.join(process.env.HOME, '.config');
  const unitDirectory = path.join(configHome, 'systemd', 'user');
  const serviceLink = path.join(unitDirectory, `${unit}.service`);
  const timerLink = path.join(unitDirectory, `${unit}.timer`);
  const linksBefore = { service: !(await isAbsent(serviceLink)), timer: !(await isAbsent(timerLink)) };
  if (!linksBefore.service && !linksBefore.timer) return { ok: true, details: { status: 'not-created' } };
  const timerStateBefore = await systemdProperties(`${unit}.timer`, ['LoadState', 'ActiveState']);
  const serviceStateBefore = await systemdProperties(`${unit}.service`, ['LoadState', 'ActiveState']);
  const timerStopNeeded = ['active', 'activating', 'reloading'].includes(timerStateBefore.ActiveState);
  const serviceStopNeeded = ['active', 'activating', 'reloading'].includes(serviceStateBefore.ActiveState);
  const timerStop = timerStopNeeded
    ? await run('systemctl', ['--user', 'stop', `${unit}.timer`], { timeoutMs: 10000 })
    : { code: 0 };
  const serviceStop = serviceStopNeeded
    ? await run('systemctl', ['--user', 'stop', `${unit}.service`], { timeoutMs: 10000 })
    : { code: 0 };
  const timerStateAfter = await systemdProperties(`${unit}.timer`, ['LoadState', 'ActiveState']);
  const serviceStateAfter = await systemdProperties(`${unit}.service`, ['LoadState', 'ActiveState']);
  const timerInactive = timerStateAfter.LoadState === 'not-found' || timerStateAfter.ActiveState === 'inactive';
  const serviceInactive = serviceStateAfter.LoadState === 'not-found' || serviceStateAfter.ActiveState === 'inactive';
  const reset = await run('systemctl', ['--user', 'reset-failed', `${unit}.timer`, `${unit}.service`], { timeoutMs: 10000 });
  let timerLinkRemoved = false;
  let serviceLinkRemoved = false;
  try {
    for (const extension of ['service', 'timer']) {
      const link = path.join(unitDirectory, `${unit}.${extension}`);
      try {
        if ((await lstat(link)).isSymbolicLink()) await rm(link, { force: true });
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    serviceLinkRemoved = await isAbsent(serviceLink);
    timerLinkRemoved = await isAbsent(timerLink);
  } catch {}
  const reloaded = await run('systemctl', ['--user', 'daemon-reload'], { timeoutMs: 10000 });
  const details = {
    timer_stop: timerStopNeeded ? timerStop.code === 0 : 'not-needed',
    service_stop: serviceStopNeeded ? serviceStop.code === 0 : 'not-needed',
    service_inactive: serviceInactive,
    timer_inactive: timerInactive,
    service_link_removed: serviceLinkRemoved,
    timer_link_removed: timerLinkRemoved,
    daemon_reload: reloaded.code === 0,
    reset_failed: reset.code === 0,
  };
  const required = Object.values(details).filter(value => value !== 'not-needed');
  return { ok: required.every(value => value === true), details };
}

async function cleanupSystemdUnit(unit) {
  const attempts = [];
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const result = await stopUnit(unit);
    attempts.push(result);
    if (result.ok) return { ok: true, attempts };
  }
  return { ok: false, attempts };
}

async function systemdProperties(unit, properties) {
  const result = await run('systemctl', ['--user', 'show', unit, `--property=${properties.join(',')}`], { timeoutMs: 10000 });
  if (result.code !== 0) return { available: false };
  return Object.fromEntries(result.stdout.trim().split(/\r?\n/).filter(Boolean).map(line => {
    const separator = line.indexOf('=');
    return [line.slice(0, separator), line.slice(separator + 1)];
  }));
}

const report = {
  result: 'failed',
  qualification: 'local offline mechanics only',
  operationally_qualified: false,
  worker: 'scripted fixture; zero model calls',
  evidence: {},
  gaps: [
    'The deterministic local authority is not the real Celestan assignment-decision authority.',
    'The systemd user unit runs as the current WSL account, not the target celestan-runtime service account.',
    'The WSL read-only user-namespace boundary is not yet qualified on the target production host.',
    'This run proves pause and fresh-process timer behavior, not a coordinator crash after spawn; retain the separate 3C crash-recovery evidence.',
    'Only one local timer invocation is observed; periodic re-trigger and host reboot behavior remain unqualified.',
    'No production database, live model, GAS effect, or observed legacy-exclusion state is exercised.'
  ]
};

let basePool;
let freshAdminPool;
let runtimePool;
let databaseName;
let roleName;
let stateRoot;
let timerUnit;
let liveTick;
let releaseGate;
let databaseCreated = false;
let roleCreated = false;
let stageDiagnostics = null;
const cleanupOutcomes = {
  systemd_cleanup_verified: 'not-created',
  database: 'not-created',
  runtime_role: 'not-created',
  runtime_pool: 'not-created',
  fresh_admin_pool: 'not-created',
  base_pool: 'not-created',
  temporary_state: 'not-created',
};

try {
  if (process.platform !== 'linux') fail('qualification must run on Linux');
  requireLocalAdminUrl(adminUrl);
  for (const command of ['unshare', 'systemctl']) {
    if (spawnSync('which', [command], { encoding: 'utf8' }).status !== 0) fail(`required local command is unavailable: ${command}`);
  }
  const userSystemd = await run('systemctl', ['--user', 'is-system-running'], { timeoutMs: 10000 });
  if (userSystemd.code !== 0 || !userSystemd.stdout.trim().startsWith('running')) fail('the WSL user systemd manager is not running');

  const adminUrlObject = requireLocalAdminUrl(adminUrl);
  basePool = new Pool({ connectionString: adminUrlObject.href, max: 2, connectionTimeoutMillis: 5000 });
  const postgresVersion = (await basePool.query('SELECT version() AS version')).rows[0].version;
  const admin = await basePool.query(`SELECT current_user AS role, r.rolsuper AS superuser
    FROM pg_roles r WHERE r.rolname=current_user`);
  if (!admin.rows[0]?.superuser) fail('POSTGRES_URL must use the local disposable database administrator');
  await basePool.query("DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF; IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anonymous') THEN CREATE ROLE anonymous NOLOGIN; END IF; END $$");

  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  databaseName = `ct_first_launch_${suffix}`;
  roleName = `ct_fl_runtime_${suffix}`;
  const password = randomBytes(24).toString('base64url');
  await basePool.query(`CREATE ROLE "${roleName}" LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS CONNECTION LIMIT 5`);
  roleCreated = true;
  await basePool.query(`CREATE DATABASE "${databaseName}"`);
  databaseCreated = true;

  const adminDatabaseUrl = new URL(adminUrlObject.href);
  adminDatabaseUrl.pathname = `/${databaseName}`;
  const runtimeDatabaseUrl = new URL(adminDatabaseUrl.href);
  runtimeDatabaseUrl.username = roleName;
  runtimeDatabaseUrl.password = password;
  freshAdminPool = new Pool({ connectionString: adminDatabaseUrl.href, max: 4, connectionTimeoutMillis: 5000 });

  stateRoot = await mkdtemp(path.join(tmpdir(), 'ct-runtime-first-launch-'));
  const workspace = path.join(stateRoot, 'project');
  const controlDirectory = path.join(stateRoot, 'control');
  const authorityDirectory = path.join(stateRoot, 'authority');
  await Promise.all([mkdir(workspace, { mode: 0o700 }), mkdir(controlDirectory, { mode: 0o700 }), mkdir(authorityDirectory, { mode: 0o700 })]);
  const identityFile = path.join(workspace, 'identity.md');
  await writeFile(identityFile, 'Local first-launch qualification project. Runtime enforces execution boundaries.\n', { mode: 0o600 });
  await copyFile(authorityFixture, path.join(authorityDirectory, 'authority.mjs'));

  const projectId = `first-launch-${suffix}`;
  const trialId = `milestone-3d-${suffix}`;
  const coordinatorId = `local-first-launch-${suffix}`;
  const pauseFile = path.join(stateRoot, 'PAUSED');
  const configPath = path.join(stateRoot, 'pilot.json');
  const executionProfiles = {
    execution: { model: 'local-scripted-execution', agent: 'bounded-worker', access_class: 'bounded-mutation', permissions: ['project:write'] },
    review: { model: 'local-scripted-review', agent: 'independent-reviewer', access_class: 'read-only', permissions: ['project:read'] },
    diagnosis: { model: 'local-scripted-diagnosis', agent: 'diagnostician', access_class: 'read-only', permissions: ['project:read'] },
    stewardship: { model: 'local-scripted-stewardship', agent: 'steward', access_class: 'read-only', permissions: ['project:read'] },
  };
  const executor = {
    command: node,
    args: [worker, controlDirectory, trialId],
    stateDirectory: path.join(stateRoot, 'attempts', 'execution'),
    envNames: [],
    purposeExecutors: Object.fromEntries(['review', 'diagnosis', 'stewardship'].map(purpose => [purpose, {
      command: '/bin/sh',
      args: [readOnlyExecutor, workspace, node, worker, controlDirectory, trialId],
      stateDirectory: path.join(stateRoot, 'attempts', purpose),
      envNames: [],
    }])),
  };
  const config = {
    enabled: false,
    legacyExcluded: false,
    projectId,
    workspaceRoot: workspace,
    identityFiles: [identityFile],
    authorityModule: path.join(authorityDirectory, 'authority.mjs'),
    coordinatorId,
    intervalMs: 1000,
    scanIntervalMs: 1000,
    maxNonProgress: 2,
    timeoutMs: 20000,
    assignmentProfiles: executionProfiles,
    pauseFile,
    executor,
  };
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });

  const pilotEnvironment = {
    ...process.env,
    CT_PILOT_DATABASE_URL: runtimeDatabaseUrl.href,
    CT_QUALIFY_RUNTIME_ROOT: root,
    CT_QUALIFY_PROJECT_ID: projectId,
    CT_QUALIFY_WORKSPACE: workspace,
    CT_QUALIFY_TRIAL_ID: trialId,
  };
  delete pilotEnvironment.POSTGRES_URL;
  delete pilotEnvironment.TEST_DATABASE_URL;

  const migrationResult = parseJson(await run(node, [path.join(root, 'bin/vnext-pilot.mjs'), 'migrate', '--config', configPath], {
    env: { ...pilotEnvironment, CT_PILOT_DATABASE_URL: adminDatabaseUrl.href },
  }), 'fresh database migration');
  const appliedVersions = (await freshAdminPool.query('SELECT version FROM vnext_schema_migrations ORDER BY version')).rows.map(row => Number(row.version));
  if (JSON.stringify(appliedVersions) !== JSON.stringify(expectedMigrationVersions)) fail('fresh database migration ledger does not match repository migrations');
  await freshAdminPool.query(`GRANT CONNECT ON DATABASE "${databaseName}" TO "${roleName}"`);
  await freshAdminPool.query(`GRANT USAGE ON SCHEMA public TO "${roleName}"`);
  await freshAdminPool.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO "${roleName}"`);
  await freshAdminPool.query(`GRANT USAGE,SELECT,UPDATE ON ALL SEQUENCES IN SCHEMA public TO "${roleName}"`);
  await freshAdminPool.query(`GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO "${roleName}"`);
  runtimePool = new Pool({ connectionString: runtimeDatabaseUrl.href, max: 4, connectionTimeoutMillis: 5000 });
  const runtimeCheck = await runtimePool.query(`SELECT current_user AS role, r.rolsuper AS superuser,
    r.rolcreatedb AS createdb, r.rolcreaterole AS createrole, r.rolbypassrls AS bypassrls
    FROM pg_roles r WHERE r.rolname=current_user`);
  const roleFacts = runtimeCheck.rows[0];
  if (!roleFacts || roleFacts.superuser || roleFacts.createdb || roleFacts.createrole || roleFacts.bypassrls) fail('runtime database role exceeds the local least-privilege profile');

  const probe = path.join(stateRoot, 'write-probe.mjs');
  const probeTarget = path.join(workspace, 'read-only-probe.txt');
  await writeFile(probe, `import { writeFile } from 'node:fs/promises';\ntry { await writeFile(process.argv[2], 'probe'); process.exit(0); } catch (error) { if (['EROFS','EACCES'].includes(error.code)) process.exit(42); throw error; }\n`, { mode: 0o600 });
  const deniedProbe = await run('/bin/sh', [readOnlyExecutor, workspace, node, probe, probeTarget], { cwd: workspace });
  if (deniedProbe.code !== 42 || await exists(probeTarget)) fail('read-only executor did not prevent a project write');
  const allowedProbe = await run(node, [probe, probeTarget], { cwd: workspace });
  if (allowedProbe.code !== 0 || !(await exists(probeTarget))) fail('bounded execution control could not write to its project workspace');
  await rm(probeTarget, { force: true });

  const firstMessage = path.join(stateRoot, 'input-a.txt');
  const secondMessage = path.join(stateRoot, 'input-b.txt');
  await writeFile(firstMessage, 'Qualify one bounded objective and preserve its evidence.\n', { mode: 0o600 });
  await writeFile(secondMessage, 'Verify pause blocks admission and resume restores it.\n', { mode: 0o600 });
  const firstInput = parseJson(await run(node, [path.join(root, 'bin/vnext-pilot.mjs'), 'submit', '--config', configPath,
    '--thread', 'first-launch-a', '--receipt', `receipt-a-${suffix}`, '--message-file', firstMessage], { env: pilotEnvironment }), 'submit first work');
  let secondInput;
  config.enabled = true;
  config.legacyExcluded = true;
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });

  const firstPass = parseJson(await run(node, [path.join(root, 'bin/vnext-pilot.mjs'), 'tick', '--config', configPath], { env: pilotEnvironment }), 'stewardship pass');
  parseJson(await run(node, [path.join(root, 'bin/vnext-pilot.mjs'), 'tick', '--config', configPath], { env: pilotEnvironment }), 'stewardship decision pass');
  const firstStewardship = await freshAdminPool.query("SELECT status,decision->>'outcome' AS outcome FROM vnext_assignments WHERE work_unit_id=$1 AND purpose='stewardship'", [firstInput.work_unit_id]);
  if (firstPass.dispatch?.disposition !== 'assignment-reported' || firstStewardship.rows[0]?.status !== 'decided' || firstStewardship.rows[0]?.outcome !== 'propose') fail('local authority did not complete the first stewardship decision');

  releaseGate = path.join(controlDirectory, 'release-worker');
  liveTick = start(node, [path.join(root, 'bin/vnext-pilot.mjs'), 'tick', '--config', configPath], { env: pilotEnvironment });
  await waitFor(async () => {
    if (await exists(path.join(controlDirectory, 'worker-started.json'))) return true;
    const ended = liveTick.result();
    if (ended) {
      let status = 'unavailable';
      try { status = JSON.parse(ended.stdout.trim()).status ?? status; } catch {}
      fail(`coordinator exited before worker spawn (exit ${ended.code}, status ${status})`);
    }
    return false;
  }, 'live scripted worker').catch(async error => {
    stageDiagnostics = await localDiagnostics(stateRoot);
    throw error;
  });
  secondInput = parseJson(await run(node, [path.join(root, 'bin/vnext-pilot.mjs'), 'submit', '--config', configPath,
    '--thread', 'first-launch-b', '--receipt', `receipt-b-${suffix}`, '--message-file', secondMessage], { env: pilotEnvironment }), 'submit second work');
  const pauseResult = parseJson(await run(node, [path.join(root, 'bin/vnext-pilot.mjs'), 'pause', '--config', configPath, '--reason', 'qualification-pause'], { env: pilotEnvironment }), 'pause command');
  if (pauseResult.status !== 'paused') fail('pause command did not install the pause marker');
  const pausedTick = parseJson(await run(node, [path.join(root, 'bin/vnext-pilot.mjs'), 'tick', '--config', configPath], { env: pilotEnvironment }), 'paused coordinator pass');
  if (pausedTick.status !== 'paused' || pausedTick.reason !== 'pause-file-present') fail('pause marker did not hold the next pass');
  const firstWhileLive = await workState(freshAdminPool, firstInput.work_unit_id);
  const secondWhilePaused = await workState(freshAdminPool, secondInput.work_unit_id);
  const secondAssignmentsWhilePaused = Number((await freshAdminPool.query('SELECT count(*)::int AS count FROM vnext_assignments WHERE work_unit_id=$1', [secondInput.work_unit_id])).rows[0].count);
  if (!firstWhileLive.claim_execution_id || secondWhilePaused.claim_execution_id || secondAssignmentsWhilePaused !== 0) fail('pause did not preserve the live worker while holding fresh admission');
  if (await exists(path.join(controlDirectory, 'worker-finished.json'))) fail('live worker finished before the operator released its gate');

  await writeFile(releaseGate, 'continue\n', { flag: 'wx', mode: 0o600 });
  const liveResult = await Promise.race([liveTick.done, sleep(25000).then(() => null)]);
  if (!liveResult || liveResult.code !== 0) fail('live worker pass did not settle after release');
  liveTick = null;
  if (!(await exists(path.join(controlDirectory, 'worker-finished.json')))) fail('live worker did not record completion');
  const resumeResult = parseJson(await run(node, [path.join(root, 'bin/vnext-pilot.mjs'), 'resume', '--config', configPath], { env: pilotEnvironment }), 'resume command');

  const firstExecutionsAfterResume = [];
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const state = await workState(freshAdminPool, firstInput.work_unit_id);
    if (state.state === 'terminal') break;
    const tick = parseJson(await run(node, [path.join(root, 'bin/vnext-pilot.mjs'), 'tick', '--config', configPath], { env: pilotEnvironment }), 'post-resume coordinator pass');
    firstExecutionsAfterResume.push(tick.status);
  }
  if ((await workState(freshAdminPool, firstInput.work_unit_id)).state !== 'terminal') fail('first Work Unit did not reach accepted terminal state');
  const acceptedCount = Number((await freshAdminPool.query(`SELECT count(*)::int AS count FROM vnext_events
    WHERE event_type='work.accepted' AND payload->'result'->>'work_unit_id'=$1`, [firstInput.work_unit_id])).rows[0].count);
  if (acceptedCount !== 1) fail('first Work Unit did not have exactly one acceptance receipt');
  const firstExecutionCount = await unitExecutionCount(freshAdminPool, projectId, firstInput.work_unit_id);
  if (firstExecutionCount !== 3) fail('first Work Unit did not complete exactly one stewardship, execution, and review worker');

  await rm(path.join(controlDirectory, 'worker-started.json'), { force: true });
  await rm(path.join(controlDirectory, 'worker-finished.json'), { force: true });
  const resumedAdmission = parseJson(await run(node, [path.join(root, 'bin/vnext-pilot.mjs'), 'tick', '--config', configPath], { env: pilotEnvironment }), 'resumed admission pass');
  if (resumedAdmission.dispatch?.disposition !== 'assignment-reported') fail('resume did not report the next stewardship assignment');
  const secondAssignmentsAfterResume = Number((await freshAdminPool.query('SELECT count(*)::int AS count FROM vnext_assignments WHERE work_unit_id=$1', [secondInput.work_unit_id])).rows[0].count);
  if (secondAssignmentsAfterResume < 1) fail('resume did not admit the next Work Unit');
  parseJson(await run(node, [path.join(root, 'bin/vnext-pilot.mjs'), 'tick', '--config', configPath], { env: pilotEnvironment }), 'resumed assignment decision pass');
  const secondStewardship = await freshAdminPool.query("SELECT status,decision->>'outcome' AS outcome FROM vnext_assignments WHERE work_unit_id=$1 AND purpose='stewardship'", [secondInput.work_unit_id]);
  if (secondStewardship.rows[0]?.status !== 'decided' || secondStewardship.rows[0]?.outcome !== 'propose') fail('resumed local authority did not approve the second Work Unit');

  const passCountBeforeTimer = await countCoordinatorPasses(freshAdminPool, coordinatorId);
  timerUnit = `ct-first-launch-${suffix}`;
  const environmentFile = path.join(stateRoot, 'pilot.env');
  const serviceFile = path.join(stateRoot, `${timerUnit}.service`);
  const timerFile = path.join(stateRoot, `${timerUnit}.timer`);
  await writeFile(environmentFile, [
    `CT_PILOT_DATABASE_URL=${runtimeDatabaseUrl.href}`,
    `CT_QUALIFY_RUNTIME_ROOT=${root}`,
    `CT_QUALIFY_PROJECT_ID=${projectId}`,
    `CT_QUALIFY_WORKSPACE=${workspace}`,
    `CT_QUALIFY_TRIAL_ID=${trialId}`,
    '',
  ].join('\n'), { mode: 0o600 });
  await writeFile(serviceFile, `[Unit]\nDescription=Local first-launch qualification pass\n[Service]\nType=oneshot\nWorkingDirectory=${root}\nEnvironmentFile=${environmentFile}\nExecStart=${node} ${path.join(root, 'bin/vnext-pilot.mjs')} tick --config ${configPath}\nTimeoutStartSec=30s\nKillMode=control-group\nNoNewPrivileges=yes\nUMask=0077\n`, { mode: 0o600 });
  await writeFile(timerFile, `[Unit]\nDescription=Local first-launch qualification pass\n[Timer]\nOnActiveSec=1s\nOnUnitInactiveSec=60s\nAccuracySec=1s\nUnit=${timerUnit}.service\n`, { mode: 0o600 });
  const linked = await run('systemctl', ['--user', 'link', serviceFile, timerFile], { timeoutMs: 15000 });
  if (linked.code !== 0) fail('systemd user units could not be linked');
  const reloaded = await run('systemctl', ['--user', 'daemon-reload'], { timeoutMs: 15000 });
  if (reloaded.code !== 0) fail('systemd user units could not be loaded');
  const timerStart = await run('systemctl', ['--user', 'start', `${timerUnit}.timer`], { timeoutMs: 15000 });
  if (timerStart.code !== 0) fail('systemd user timer could not be started');
  let timerPasses = 0;
  const timerDeadline = Date.now() + 25000;
  while (Date.now() < timerDeadline) {
    const count = await countCoordinatorPasses(freshAdminPool, coordinatorId);
    timerPasses = count - passCountBeforeTimer;
    if (timerPasses >= 1) break;
    await sleep(100);
  }
  if (timerPasses < 1) {
    stageDiagnostics = {
      timer_passes: timerPasses,
      service: await systemdProperties(`${timerUnit}.service`, ['ActiveState', 'Result', 'ExecMainCode', 'ExecMainStatus']),
      timer: await systemdProperties(`${timerUnit}.timer`, ['ActiveState', 'NextElapseUSecMonotonic']),
      workers: await localDiagnostics(stateRoot),
    };
    fail('systemd user timer did not produce its first coordinator pass');
  }
  await waitFor(async () => {
    const properties = await systemdProperties(`${timerUnit}.service`, ['ActiveState', 'Result', 'ExecMainStatus']);
    return properties.ActiveState === 'inactive' && properties.Result === 'success' ? properties : false;
  }, 'successful systemd timer service completion', 10000);
  if (!(await exists(path.join(controlDirectory, 'worker-finished.json')))) fail('systemd timer pass did not finish its bounded execution worker');
  const systemdCleanup = await cleanupSystemdUnit(timerUnit);
  cleanupOutcomes.systemd_cleanup_verified = systemdCleanup.ok;
  cleanupOutcomes.systemd_cleanup_attempts = systemdCleanup.attempts;
  if (!systemdCleanup.ok) fail('systemd user unit cleanup failed');
  timerUnit = null;

  const effects = (await readFile(path.join(controlDirectory, 'simulated-effects.jsonl'), 'utf8'))
    .split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
  const firstEffectCount = effects.filter(row => row.effect_key.startsWith(`${firstInput.work_unit_id}:`)).length;
  if (firstEffectCount !== 1) fail('fresh process/timer passes duplicated the first Work Unit effect');
  const runtimeLog = (await readFile(path.join(controlDirectory, 'worker-invocations.jsonl'), 'utf8'))
    .split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
  if (runtimeLog.some(row => row.model_calls !== 0)) fail('scripted qualification unexpectedly used a model');

  report.result = 'PASS';
  report.operationally_qualified = false;
  report.environment = {
    runtime_commit: spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim(),
    worktree: spawnSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).stdout.trim() ? 'dirty' : 'clean',
    node: process.version,
    platform: `${process.platform}/${process.arch}`,
    postgres: postgresVersion.split(',')[0],
    systemd_user_manager: 'running',
    runtime_database_role: { superuser: false, createdb: false, createrole: false, bypassrls: false },
  };
  report.evidence = {
    fresh_database: { created: true, migrations: appliedVersions, runtime_role: roleName },
    activation_gate: { both_flags_false_during_preparation: true, both_flags_true_before_first_tick: true },
    permission_boundary: { read_only_write_probe: 'blocked', execution_write_probe: 'allowed', database_credentials_in_worker: false },
    pause_recovery: {
      live_worker_survived_pause: true,
      next_tick: pausedTick.status,
      second_work_unclaimed_while_paused: true,
      resumed: resumeResult.status,
      first_work_terminal: true,
      first_work_worker_executions: firstExecutionCount,
      first_work_effects: firstEffectCount,
    },
    host_timer: {
      manager: 'systemd user manager',
      observed_passes: timerPasses,
      properties: ['OnActiveSec=1s', 'OnUnitInactiveSec=60s', 'AccuracySec=1s', 'TimeoutStartSec=30s', 'KillMode=control-group', 'NoNewPrivileges=yes', 'UMask=0077'],
      resumed_work_admitted: secondAssignmentsAfterResume >= 1,
    },
    model_calls: 0,
  };
} catch (error) {
  report.failure = String(error?.message ?? error).replace(/postgres(?:ql)?:\/\/[^\s'"`]+/gi, '[redacted-database-url]').slice(0, 300);
  if (stageDiagnostics) report.diagnostics = stageDiagnostics;
} finally {
  if (releaseGate) await writeFile(releaseGate, 'cleanup\n', { flag: 'w', mode: 0o600 }).catch(() => {});
  if (liveTick?.child && liveTick.child.exitCode == null) {
    liveTick.child.kill('SIGTERM');
    try {
      const started = JSON.parse(await readFile(path.join(stateRoot, 'control', 'worker-started.json'), 'utf8'));
      if (Number.isInteger(started.pid)) process.kill(-started.pid, 'SIGKILL');
    } catch {}
    await Promise.race([liveTick.done, sleep(5000)]);
  }
  if (timerUnit && cleanupOutcomes.systemd_cleanup_verified !== true) {
    const systemdCleanup = await cleanupSystemdUnit(timerUnit);
    if (cleanupOutcomes.systemd_cleanup_verified === 'not-created') cleanupOutcomes.systemd_cleanup_verified = systemdCleanup.ok;
    else cleanupOutcomes.systemd_cleanup_retry = systemdCleanup.ok;
    cleanupOutcomes.systemd_cleanup_attempts = [...(cleanupOutcomes.systemd_cleanup_attempts ?? []), ...systemdCleanup.attempts];
    timerUnit = null;
  }
  if (runtimePool) {
    try { await runtimePool.end(); cleanupOutcomes.runtime_pool = true; }
    catch { cleanupOutcomes.runtime_pool = false; }
  }
  if (freshAdminPool) {
    try { await freshAdminPool.end(); cleanupOutcomes.fresh_admin_pool = true; }
    catch { cleanupOutcomes.fresh_admin_pool = false; }
  }
  if (basePool && databaseCreated) {
    try {
      await basePool.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1', [databaseName]);
      await basePool.query(`DROP DATABASE "${databaseName}"`);
      cleanupOutcomes.database = (await basePool.query('SELECT 1 FROM pg_database WHERE datname=$1', [databaseName])).rowCount === 0;
    } catch { cleanupOutcomes.database = false; }
  }
  if (basePool && roleCreated) {
    try {
      await basePool.query(`DROP ROLE "${roleName}"`);
      cleanupOutcomes.runtime_role = (await basePool.query('SELECT 1 FROM pg_roles WHERE rolname=$1', [roleName])).rowCount === 0;
    } catch { cleanupOutcomes.runtime_role = false; }
  }
  if (basePool) {
    try { await basePool.end(); cleanupOutcomes.base_pool = true; }
    catch { cleanupOutcomes.base_pool = false; }
  }
  if (keep && stateRoot) {
    cleanupOutcomes.temporary_state = 'retained';
    report.retained_state = stateRoot;
  } else if (stateRoot) {
    try {
      await rm(stateRoot, { recursive: true, force: true });
      cleanupOutcomes.temporary_state = await isAbsent(stateRoot);
    } catch { cleanupOutcomes.temporary_state = false; }
  }
  if (cleanupOutcomes.database === false || cleanupOutcomes.runtime_role === false) {
    report.cleanup_resources = {
      ...(cleanupOutcomes.database === false ? { database: databaseName } : {}),
      ...(cleanupOutcomes.runtime_role === false ? { runtime_role: roleName } : {}),
    };
  }
  if (cleanupOutcomes.temporary_state === false) report.retained_state = stateRoot;
  applyCleanupResults(report, cleanupOutcomes);
}

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (report.result !== 'PASS') process.exitCode = 1;
