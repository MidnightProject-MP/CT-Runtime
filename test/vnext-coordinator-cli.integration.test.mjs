import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { Pool } from 'pg';
import { createPilotStore } from '../lib/vnext/pilot-store.mjs';

const enabled = process.platform === 'linux' && typeof process.env.TEST_DATABASE_URL === 'string';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const passLines = output => output.split(/\r?\n/).filter(line => line.includes('"status":')).length;

async function exists(file) {
  try { await access(file); return true; } catch { return false; }
}

async function waitFor(predicate, label, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(20);
  }
  throw new Error(`timed out waiting for ${label}`);
}

function startCli(cliPath, action, configPath, databaseUrl, args = []) {
  const child = spawn(process.execPath, [cliPath, action, '--config', configPath, ...args], {
    env: { ...process.env, CT_PILOT_DATABASE_URL: databaseUrl },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', value => { stdout += value; });
  child.stderr.setEncoding('utf8').on('data', value => { stderr += value; });
  const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  return { child, exited, output: () => ({ stdout, stderr }) };
}

async function invoke(cliPath, action, configPath, databaseUrl, args = [], expectedCode = 0) {
  const running = startCli(cliPath, action, configPath, databaseUrl, args);
  const exit = await running.exited;
  const output = running.output();
  assert.equal(exit.code, expectedCode, `${action} exit; stdout=${output.stdout}; stderr=${output.stderr}`);
  const stdout = output.stdout.trim();
  if (stdout) {
    try { return JSON.parse(stdout); }
    catch { return JSON.parse(stdout.split(/\r?\n/).at(-1)); }
  }
  const stderr = output.stderr.trim();
  return stderr ? JSON.parse(stderr.split(/\r?\n/).at(-1)) : null;
}

function signalAndWait(child, signal, timeoutMs = 2000) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  const exited = new Promise(resolve => child.once('exit', (code, exitSignal) => resolve({ code, signal: exitSignal })));
  child.kill(signal);
  return Promise.race([
    exited,
    delay(timeoutMs).then(() => null),
  ]);
}

test('coordinator abort-registration race does not retain an idle timer', { skip: process.platform !== 'linux', timeout: 10000 }, async () => {
  const moduleUrl = pathToFileURL(path.resolve(import.meta.dirname, '../lib/vnext/coordinator.mjs')).href;
  const source = `
    import { runCoordinatorLoop } from ${JSON.stringify(moduleUrl)};
    const signal = {
      aborted: false,
      addEventListener(_type, listener) { this.aborted = true; listener(); },
      removeEventListener() {},
    };
    await runCoordinatorLoop({ intervalMs: 8000, signal, runPass: async () => ({ status: 'quiesced' }) });
    console.log('LOOP_RETURNED');
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', source], { stdio: ['ignore', 'pipe', 'ignore'] });
  let stdout = '';
  child.stdout.setEncoding('utf8').on('data', value => { stdout += value; });
  const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  try { await waitFor(() => stdout.includes('LOOP_RETURNED'), 'abort-race child loop return', 5000); }
  catch (error) { child.kill('SIGKILL'); throw error; }
  const exit = await Promise.race([
    exited,
    delay(2500).then(() => null),
  ]);
  if (!exit) {
    child.kill('SIGKILL');
    await exited;
  }
  assert.ok(exit, 'abort between the initial check and listener registration should not retain a timeout');
  assert.equal(exit.code, 0);
});

test('native coordinator CLI survives restart, recovers real worker, binds decisions, and shuts down promptly', {
  skip: !enabled,
  timeout: 180000,
}, async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'vnext-coordinator-cli-'));
  const workspace = path.join(directory, 'project');
  const stateDirectory = path.join(directory, 'attempts');
  const controlDirectory = path.join(directory, 'control');
  await mkdir(workspace, { recursive: true });
  await mkdir(controlDirectory, { recursive: true });
  const identityPath = path.join(directory, 'identity.md');
  const workerPath = path.join(directory, 'worker.mjs');
  const authorityPath = path.join(directory, 'authority.mjs');
  const configPath = path.join(directory, 'pilot.json');
  const messagePath = path.join(directory, 'message.txt');
  const proofPath = path.join(workspace, 'proof.txt');
  const gatePath = path.join(controlDirectory, 'release-first-worker');
  const cliPath = path.resolve(import.meta.dirname, '../bin/vnext-pilot.mjs');
  const projectId = `coordinator-cli-${randomUUID()}`;
  const threadId = 'integrated-lifecycle';
  const receipt = `input-${randomUUID()}`;
  const proof = 'the local command executor retained this verified output';
  const proofHash = createHash('sha256').update(proof).digest('hex');
  const connectionString = process.env.TEST_DATABASE_URL;
  const pool = new Pool({ connectionString, max: 4 });
  const children = new Set();
  let workerPids = [];
  let lifecycleCompleted = false;
  let acceptedAWorkId = null;

  const workerSource = `
    import { access, readFile, writeFile } from 'node:fs/promises';
    import { createHash } from 'node:crypto';
    import path from 'node:path';
    const request = JSON.parse(await readFile(process.env.CT_VNEXT_REQUEST_FILE, 'utf8'));
    const control = process.argv[2];
    const attempt = Number(request.execution.attempt);
    const executionId = request.execution.execution_id;
    const marker = path.join(control, 'started-' + attempt + '.json');
    await writeFile(marker, JSON.stringify({ pid: process.pid, execution_id: executionId }), { flag: 'wx' });
    if (process.env.CT_PILOT_DATABASE_URL || process.env.POSTGRES_URL || process.env.TEST_DATABASE_URL) process.exit(91);
    if (attempt === 1) {
      const gate = path.join(control, 'release-first-worker');
      for (;;) {
        try { await access(gate); break; } catch { await new Promise(resolve => setTimeout(resolve, 10)); }
      }
    }
    if (attempt >= 4) process.exit(17);
    const disposition = attempt === 1 ? 'continue' : 'done';
    const result = {
      objective_id: request.workUnit.objective_ref,
      disposition,
      summary: attempt === 1 ? 'First bounded increment completed.' : 'Verified objective completion.',
      ...(attempt === 1 ? { continuation: { mode: 'immediate', next_action: 'Verify the bounded successor.' } } : {
        outcome_evidence: [{ kind: 'file', path: 'proof.txt', sha256: createHash('sha256').update('the local command executor retained this verified output').digest('hex') }],
      }),
    };
    await writeFile(process.env.CT_VNEXT_RESULT_FILE, JSON.stringify(result));
    await writeFile(path.join(control, 'done-' + attempt), executionId);
  `;
  const authoritySource = `
    export async function authorizeExecution({ execution }) { return { ref: 'worker:' + execution.execution_id }; }
    export async function verifyExecution(decision, { execution }) { return decision?.ref === 'worker:' + execution.execution_id; }
    export async function authorizeTerminal() { return false; }
    export async function verifyAcceptance(decision, context) {
      return decision?.ref?.startsWith('operator-accept:') === true
        && decision.snapshotDigest === context.snapshotDigest;
    }
    export async function verifyCancellation(decision) { return decision?.ref?.startsWith('operator-cancel:') === true; }
  `;
  const baseConfig = {
    enabled: true,
    legacyExcluded: true,
    projectId,
    workspaceRoot: workspace,
    identityFiles: [identityPath],
    authorityModule: authorityPath,
    coordinatorId: 'native-integrated-test',
    intervalMs: 1000,
    scanIntervalMs: 150,
    pauseFile: path.join(directory, 'PAUSED'),
    timeoutMs: 60000,
    executor: { command: process.execPath, args: [workerPath, controlDirectory], stateDirectory, envNames: [] },
  };
  const writeConfig = async overrides => writeFile(configPath, JSON.stringify({ ...baseConfig, ...overrides }, null, 2));
  const startRun = (pathToConfig = configPath) => {
    const running = startCli(cliPath, 'run', pathToConfig, connectionString);
    children.add(running.child);
    running.child.once('exit', () => children.delete(running.child));
    return running;
  };
  const inspect = () => invoke(cliPath, 'inspect', configPath, connectionString);
  const countExecutions = async () => Number((await pool.query(`SELECT count(*)::int AS count FROM vnext_executions e
    JOIN vnext_work_units w USING(work_unit_id) WHERE w.project_id=$1`, [projectId])).rows[0].count);
  const countWorkExecutions = async workUnitId => Number((await pool.query('SELECT count(*)::int AS count FROM vnext_executions WHERE work_unit_id=$1', [workUnitId])).rows[0].count);
  const setClaimExpired = async workUnitId => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows: [{ expiry }] } = await client.query("SELECT clock_timestamp()-interval '1 second' AS expiry");
      await client.query('UPDATE vnext_work_units SET claim_expires_at=$2 WHERE work_unit_id=$1', [workUnitId, expiry]);
      await client.query("UPDATE vnext_executions SET claim_expires_at=$2 WHERE work_unit_id=$1 AND state IN ('created','running')", [workUnitId, expiry]);
      await client.query('UPDATE vnext_project_mutation_authority SET claim_expires_at=$2 WHERE work_unit_id=$1', [workUnitId, expiry]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally { client.release(); }
  };
  const decisionForBlock = async (ref, resolution = 'no_effect') => {
    const block = (await pool.query('SELECT * FROM vnext_project_reconciliation_blocks WHERE project_id=$1', [projectId])).rows[0];
    assert.ok(block, 'expected a durable reconciliation block');
    return {
      ref,
      project_id: projectId,
      work_unit_id: block.work_unit_id,
      execution_id: block.execution_id,
      fence: Number(block.fence),
      resolution,
    };
  };
  const writeDecision = async (name, value) => {
    const file = path.join(directory, `${name}.json`);
    await writeFile(file, JSON.stringify(value));
    return file;
  };

  try {
    await writeFile(identityPath, 'Use only the explicitly granted local fixture.');
    await writeFile(messagePath, 'Run the bounded native CLI lifecycle proof.');
    await writeFile(proofPath, proof);
    await writeFile(workerPath, workerSource);
    await writeFile(authorityPath, authoritySource);
    await writeConfig({});

    await t.test('real CLI submits, pauses/resumes, restarts around a surviving worker, and independently accepts a bounded successor', async () => {
      await invoke(cliPath, 'migrate', configPath, connectionString);
      const submitted = await invoke(cliPath, 'submit', configPath, connectionString, ['--thread', threadId, '--receipt', receipt, '--message-file', messagePath]);
      assert.equal(submitted.created, true);
      acceptedAWorkId = submitted.work_unit_id;
      await invoke(cliPath, 'pause', configPath, connectionString, ['--reason', 'startup-test']);
      const firstCoordinator = startRun();
      await delay(300);
      assert.equal(await exists(path.join(controlDirectory, 'started-1.json')), false, 'paused coordinator must not dispatch');

      await invoke(cliPath, 'resume', configPath, connectionString);
      await waitFor(() => exists(path.join(controlDirectory, 'started-1.json')), 'first real worker launch', 30000);
      const firstMarker = JSON.parse(await readFile(path.join(controlDirectory, 'started-1.json'), 'utf8'));
      workerPids.push(firstMarker.pid);
      assert.equal(await countExecutions(), 1);

      await invoke(cliPath, 'pause', configPath, connectionString, ['--reason', 'restart-test']);
      const killed = await signalAndWait(firstCoordinator.child, 'SIGKILL');
      assert.ok(killed, 'first coordinator process should terminate');
      assert.equal(process.kill(firstMarker.pid, 0), true, 'detached local worker must survive coordinator termination');

      const restartedCoordinator = startRun();
      await delay(250);
      assert.equal(process.kill(firstMarker.pid, 0), true, 'worker remains live while restarted coordinator is paused');
      assert.equal(await countExecutions(), 1, 'restart must not duplicate an active claim');
      await invoke(cliPath, 'resume', configPath, connectionString);
      await waitFor(() => restartedCoordinator.output().stdout.includes('"status":"paused"') || restartedCoordinator.output().stdout.includes('"status":"quiesced"'), 'restarted coordinator pass');
      assert.equal(await countExecutions(), 1, 'recovery scan must not dispatch while the original worker is still active');

      await writeFile(gatePath, 'release');
      await waitFor(() => exists(path.join(controlDirectory, 'done-1')), 'first worker completion');
      await setClaimExpired(submitted.work_unit_id);
      try {
        await waitFor(async () => (await countExecutions()) === 2 && await exists(path.join(controlDirectory, 'done-2')), 'recovered settlement and continuation worker');
      } catch (error) {
        const clock = (await pool.query('SELECT clock_timestamp() AS db_now')).rows[0].db_now;
        const work = (await pool.query('SELECT state,claim_execution_id,last_execution_id,failure,retry_after FROM vnext_work_units WHERE project_id=$1', [projectId])).rows;
        const executions = (await pool.query('SELECT execution_id,state,failure,claim_expires_at FROM vnext_executions WHERE project_id=$1 ORDER BY started_at', [projectId])).rows;
        throw new Error(`${error.message}; db_now=${clock.toISOString()}; scan=${baseConfig.scanIntervalMs}; child_exit=${restartedCoordinator.child.exitCode}/${restartedCoordinator.child.signalCode}; work=${JSON.stringify(work)}; executions=${JSON.stringify(executions)}; coordinator=${restartedCoordinator.output().stdout}; stderr=${restartedCoordinator.output().stderr}`);
      }
      await waitFor(async () => (await pool.query('SELECT state FROM vnext_work_units WHERE project_id=$1', [projectId])).rows[0]?.state === 'review', 'review after bounded completion');
      assert.equal(await countExecutions(), 2, 'the recovered first attempt must settle once and dispatch one successor');
      assert.equal((await pool.query('SELECT count(*)::int AS count FROM vnext_pilot_results pr JOIN vnext_work_units w USING(work_unit_id) WHERE w.project_id=$1', [projectId])).rows[0].count, 2);

      const firstContext = await createPilotStore({ pool }).getAcceptanceContext(submitted.work_unit_id);
      const firstDecision = { ref: `operator-accept:${randomUUID()}`, snapshotDigest: firstContext.snapshotDigest };
      const firstDecisionFile = await writeDecision('accept-revision-1', firstDecision);
      const acceptedFirst = await invoke(cliPath, 'accept', configPath, connectionString, ['--work', submitted.work_unit_id, '--decision-file', firstDecisionFile]);
      assert.equal(acceptedFirst.state, 'terminal');
      const firstAcceptedStatus = (await inspect());
      assert.equal(firstAcceptedStatus.objectives[0].accepted_completion.execution_id, firstContext.execution.execution_id);
      assert.equal(firstAcceptedStatus.next_action.kind, 'none');
      const quietPassCount = passLines(restartedCoordinator.output().stdout);
      await waitFor(() => passLines(restartedCoordinator.output().stdout) > quietPassCount, 'coordinator quiet pass after acceptance');
      assert.equal(await countExecutions(), 2, 'accepted work remains quiet under the running coordinator');
      const stoppedAfterAcceptance = await signalAndWait(restartedCoordinator.child, 'SIGTERM', 3000);
      assert.ok(stoppedAfterAcceptance, 'coordinator should stop after acceptance without waiting for the scan interval');

      const store = createPilotStore({ pool });
      await store.reviseWorkRequirements(submitted.work_unit_id, { expectedRevision: 1, requirements: { finish: 'Complete and independently accept revision two.' } });
      const reopened = (await inspect()).objectives[0];
      assert.equal(reopened.work_revision, 2);
      assert.equal(reopened.accepted_completion, null);
      assert.equal(reopened.acceptance_history.length, 1);

      const replayFirst = await invoke(cliPath, 'accept', configPath, connectionString, ['--work', submitted.work_unit_id, '--decision-file', firstDecisionFile]);
      assert.deepEqual(replayFirst, acceptedFirst, 'historical acceptance replay should return its exact receipt after revision change');
      assert.equal((await pool.query('SELECT state,work_revision FROM vnext_work_units WHERE work_unit_id=$1', [submitted.work_unit_id])).rows[0].state, 'actionable');
      assert.equal((await inspect()).objectives[0].accepted_completion, null, 'replaying the old receipt must not label revised work complete');

      const successor = await invoke(cliPath, 'tick', configPath, connectionString);
      assert.equal(successor.status, 'needs-review');
      const secondContext = await store.getAcceptanceContext(submitted.work_unit_id);
      const secondDecision = { ref: `operator-accept:${randomUUID()}`, snapshotDigest: secondContext.snapshotDigest };
      const secondDecisionFile = await writeDecision('accept-revision-2', secondDecision);
      const acceptedSecond = await invoke(cliPath, 'accept', configPath, connectionString, ['--work', submitted.work_unit_id, '--decision-file', secondDecisionFile]);
      assert.equal(acceptedSecond.state, 'terminal');
      const successorView = await inspect();
      const successorStatus = successorView.objectives[0];
      assert.equal(successorStatus.accepted_completion.execution_id, secondContext.execution.execution_id);
      assert.equal(successorStatus.accepted_completion.work_revision, 2);
      assert.equal(successorStatus.accepted_completion.acceptance_ref, secondDecision.ref);
      assert.equal(successorStatus.accepted_completion.snapshot_digest, secondContext.snapshotDigest);
      assert.equal(successorView.next_action.kind, 'none');
      assert.equal(successorStatus.acceptance_history.length, 2);
      assert.equal(successorStatus.acceptance_history[0].execution_id, firstContext.execution.execution_id);

      lifecycleCompleted = true;
    });

    await t.test('real reconcile CLI binds exact attempt identity, replays history, rejects reference reuse, and leaves successor block intact', async t => {
      if (!lifecycleCompleted) return t.skip('the integrated worker/restart/acceptance lifecycle did not complete');
      const store = createPilotStore({ pool });
      const blockerControl = path.join(directory, 'blocker-control');
      const blockerState = path.join(directory, 'blocker-attempts');
      const blockerConfigPath = path.join(directory, 'blocker-pilot.json');
      await mkdir(blockerControl, { recursive: true });
      const blockerConfig = {
        ...baseConfig,
        coordinatorId: 'native-status-blocker',
        pauseFile: path.join(directory, 'PAUSED-BLOCKER'),
        executor: { command: process.execPath, args: [workerPath, blockerControl], stateDirectory: blockerState, envNames: [] },
      };
      await writeFile(blockerConfigPath, JSON.stringify(blockerConfig, null, 2));
      const blockerSubmitted = await invoke(cliPath, 'submit', configPath, connectionString, [
        '--thread', 'status-blocker', '--receipt', `blocker-${randomUUID()}`, '--message-file', messagePath,
      ]);
      const blockerRun = startRun(blockerConfigPath);
      await waitFor(() => exists(path.join(blockerControl, 'started-1.json')), 'second Work Unit worker launch');
      const blockerMarker = JSON.parse(await readFile(path.join(blockerControl, 'started-1.json'), 'utf8'));
      workerPids.push(blockerMarker.pid);
      const runningView = await inspect();
      const acceptedA = runningView.objectives.find(objective => objective.work_unit_id === acceptedAWorkId);
      const runningB = runningView.objectives.find(objective => objective.work_unit_id === blockerSubmitted.work_unit_id);
      assert.equal(acceptedA.accepted_completion.accepted, true, 'accepted Work Unit A remains current while B runs');
      assert.equal(runningB.active_attempts.length, 1);
      assert.equal(runningB.next_eligible_action.reason, 'attempt-running');
      assert.equal((await invoke(cliPath, 'tick', blockerConfigPath, connectionString)).status, 'quiesced');
      assert.equal(await countWorkExecutions(blockerSubmitted.work_unit_id), 1, 'another coordinator pass must not duplicate B');

      const blockerStopped = await signalAndWait(blockerRun.child, 'SIGKILL');
      assert.ok(blockerStopped);
      assert.equal(process.kill(blockerMarker.pid, 0), true, 'B worker must survive its coordinator interruption');
      try { process.kill(-blockerMarker.pid, 'SIGKILL'); } catch { /* worker has already exited */ }
      await setClaimExpired(blockerSubmitted.work_unit_id);
      const recoveryPass = await invoke(cliPath, 'tick', blockerConfigPath, connectionString);
      assert.equal(recoveryPass.status, 'blocked', 'recovery records uncertainty instead of retrying B');
      const blockedView = await inspect();
      const acceptedAWhileBlocked = blockedView.objectives.find(objective => objective.work_unit_id === acceptedAWorkId);
      const blockedB = blockedView.objectives.find(objective => objective.work_unit_id === blockerSubmitted.work_unit_id);
      assert.equal(acceptedAWhileBlocked.accepted_completion.accepted, true, 'project uncertainty must not erase A acceptance');
      assert.equal(blockedB.uncertain_reason, 'external-effect-uncertain');
      assert.equal(blockedView.next_action.kind, 'reconcile');
      assert.equal((await invoke(cliPath, 'tick', blockerConfigPath, connectionString)).status, 'blocked');
      assert.equal(await countWorkExecutions(blockerSubmitted.work_unit_id), 1, 'blocked coordinator passes must not duplicate B');

      const blockedCoordinator = startRun(blockerConfigPath);
      await waitFor(() => blockedCoordinator.output().stdout.includes('"status":"blocked"'), 'recurring coordinator pass while project is blocked');
      assert.equal(blockedCoordinator.child.exitCode, null, 'recurring coordinator remains alive while status reports the block');
      const stoppedBlockedCoordinator = await signalAndWait(blockedCoordinator.child, 'SIGTERM', 3000);
      assert.ok(stoppedBlockedCoordinator, 'blocked coordinator remains stoppable');

      const blockerDecision = await decisionForBlock(`operator-reconcile:${randomUUID()}`, 'effect_applied');
      const blockerDecisionFile = await writeDecision('reconcile-status-blocker', blockerDecision);
      await invoke(cliPath, 'reconcile', blockerConfigPath, connectionString, ['--decision-file', blockerDecisionFile]);
      assert.equal((await inspect()).objectives.find(objective => objective.work_unit_id === acceptedAWorkId).accepted_completion.accepted, true);

      await store.reviseWorkRequirements(acceptedAWorkId,
        { expectedRevision: 2, requirements: { finish: 'Resolve each uncertain attempt only with its bound decision.' } });
      const firstFailure = await invoke(cliPath, 'tick', configPath, connectionString, [], 1);
      assert.equal(firstFailure.status, 'failed');
      const decisionA = await decisionForBlock(`operator-reconcile:${randomUUID()}`);
      const fileA = await writeDecision('reconcile-a', decisionA);
      const resolvedA = await invoke(cliPath, 'reconcile', configPath, connectionString, ['--decision-file', fileA]);
      assert.equal(resolvedA.executionId, decisionA.execution_id);
      const replayA = await invoke(cliPath, 'reconcile', configPath, connectionString, ['--decision-file', fileA]);
      assert.deepEqual(replayA, resolvedA, 'successful reconciliation replay must return its exact historical receipt without a live block');

      const secondFailure = await invoke(cliPath, 'tick', configPath, connectionString, [], 1);
      assert.equal(secondFailure.status, 'failed');
      const decisionB = await decisionForBlock(`operator-reconcile:${randomUUID()}`);
      assert.notEqual(decisionB.execution_id, decisionA.execution_id);
      const fileB = await writeDecision('reconcile-b', decisionB);

      const replayWhileBBlocked = await invoke(cliPath, 'reconcile', configPath, connectionString, ['--decision-file', fileA]);
      assert.deepEqual(replayWhileBBlocked, resolvedA);
      let block = (await pool.query('SELECT execution_id FROM vnext_project_reconciliation_blocks WHERE project_id=$1', [projectId])).rows[0];
      assert.equal(block.execution_id, decisionB.execution_id, 'replaying A must not clear B');

      const reusedReference = await writeDecision('reconcile-reused-reference', { ...decisionB, ref: decisionA.ref });
      const rejected = await invoke(cliPath, 'reconcile', configPath, connectionString, ['--decision-file', reusedReference], 1);
      assert.equal(rejected.status, 'failed');
      block = (await pool.query('SELECT execution_id FROM vnext_project_reconciliation_blocks WHERE project_id=$1', [projectId])).rows[0];
      assert.equal(block.execution_id, decisionB.execution_id, 'divergent decision-reference reuse must leave B blocked');
      const resolvedB = await invoke(cliPath, 'reconcile', configPath, connectionString, ['--decision-file', fileB]);
      assert.equal(resolvedB.executionId, decisionB.execution_id);

      const wrongProject = await writeDecision('reconcile-wrong-project', { ...decisionB, ref: `operator-reconcile:${randomUUID()}`, project_id: `${projectId}-other` });
      assert.equal((await invoke(cliPath, 'reconcile', configPath, connectionString, ['--decision-file', wrongProject], 1)).status, 'failed');
    });

    await t.test('CLI run exits promptly from real idle sleep after SIGTERM', async t => {
      if (!lifecycleCompleted) return t.skip('the integrated worker/restart/acceptance lifecycle did not complete');
      await writeConfig({ projectId: `coordinator-cli-idle-${randomUUID()}`, scanIntervalMs: 5000, pauseFile: path.join(directory, 'IDLE-PAUSED') });
      const idleRun = startRun();
      await waitFor(() => idleRun.output().stdout.includes('"status":"quiesced"') || idleRun.child.exitCode !== null, 'idle coordinator pass');
      assert.equal(idleRun.child.exitCode, null, `idle coordinator exited early: ${idleRun.output().stderr}`);
      const exited = await signalAndWait(idleRun.child, 'SIGTERM', 750);
      if (!exited) idleRun.child.kill('SIGKILL');
      assert.ok(exited, 'abort must clear the referenced scan timer and exit promptly');
    });
  } finally {
    await writeFile(gatePath, 'cleanup').catch(() => {});
    const runningChildren = [...children];
    for (const child of runningChildren) child.kill('SIGKILL');
    await Promise.all(runningChildren.map(child => child.exitCode !== null || child.signalCode !== null
      ? Promise.resolve()
      : new Promise(resolve => child.once('exit', resolve))));
    for (const pid of workerPids) {
      try { process.kill(-pid, 'SIGKILL'); } catch { /* the worker already exited */ }
    }
    await pool.end();
    await rm(directory, { recursive: true, force: true });
  }
});

test('native CLI subprocess loop separates execution, review, Celestan decision, and acceptance', {
  skip: !enabled,
  timeout: 120000,
}, async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'vnext-assignment-cli-'));
  const workspace = path.join(directory, 'project');
  const stateDirectory = path.join(directory, 'attempts');
  const controlDirectory = path.join(directory, 'control');
  await mkdir(workspace, { recursive: true });
  await mkdir(controlDirectory, { recursive: true });
  const identityPath = path.join(directory, 'identity.md');
  const workerPath = path.join(directory, 'worker.mjs');
  const authorityPath = path.join(directory, 'authority.mjs');
  const configPath = path.join(directory, 'pilot.json');
  const messagePath = path.join(directory, 'message.txt');
  const proof = 'native CLI assignment proof';
  const proofHash = createHash('sha256').update(proof).digest('hex');
  const projectId = `assignment-cli-${randomUUID()}`;
  const threadId = 'separate-purpose-lifecycle';
  const cliPath = path.resolve(import.meta.dirname, '../bin/vnext-pilot.mjs');
  const connectionString = process.env.TEST_DATABASE_URL;
  const pool = new Pool({ connectionString, max: 3 });
  const gatePath = path.join(controlDirectory, 'release-stewardship');
  const launchPath = path.join(controlDirectory, 'stewardship-started');
  const donePath = path.join(controlDirectory, 'stewardship-done');
  let firstCoordinator = null;
  let workerPid = null;
  const digestModule = pathToFileURL(path.resolve(import.meta.dirname, '../lib/vnext/operating-boundary.mjs')).href;
  await writeFile(identityPath, 'Purpose-bound native subprocess test.');
  await writeFile(path.join(workspace, 'proof.txt'), proof);
  await writeFile(messagePath, 'Complete the bound objective.');
  await writeFile(workerPath, `
    import { readFile, writeFile } from 'node:fs/promises';
    import { createHash } from 'node:crypto';
    const request = JSON.parse(await readFile(process.env.CT_VNEXT_REQUEST_FILE, 'utf8'));
    const purpose = request.assignment.purpose;
    const result = purpose === 'stewardship'
      ? { proposal: 'Complete the objective and verify its evidence.' }
      : purpose === 'review'
        ? { outcome: 'recommend_accept', summary: 'The completion and exact file evidence satisfy this review.' }
        : { objective_id: request.workUnit.objective_ref, disposition: 'done', summary: 'Outcome checked.',
            outcome_evidence: [{ kind: 'file', path: 'proof.txt', sha256: createHash('sha256').update(${JSON.stringify(proof)}).digest('hex') }] };
    await writeFile(process.env.CT_VNEXT_RESULT_FILE, JSON.stringify(result));
    if (purpose === 'stewardship' && process.argv[4]) {
      await writeFile(${JSON.stringify(launchPath)}, String(process.pid));
      for (;;) { try { await readFile(${JSON.stringify(gatePath)}); break; } catch { await new Promise(resolve => setTimeout(resolve, 10)); } }
      await writeFile(${JSON.stringify(donePath)}, request.execution.execution_id);
    }
  `);
  await writeFile(authorityPath, `
    import { digest } from ${JSON.stringify(digestModule)};
    export async function authorizeExecution({ execution }) { return { ref: 'execution:' + execution.execution_id }; }
    export async function verifyExecution(decision, { execution }) { return decision?.ref === 'execution:' + execution.execution_id; }
    export async function authorizeAssignmentDecision({ assignment, report }) {
      const report_digest = digest(report);
      return { ref: 'celestan:' + assignment.assignment_id + ':' + report_digest.slice(0,12),
        outcome: assignment.purpose === 'stewardship' ? 'propose' : 'recommend_accept',
        assignment_id: assignment.assignment_id, assignment_digest: assignment.assignment_digest,
        report_digest, subject_digest: assignment.subject_digest };
    }
    export async function verifyAssignmentDecision(decision, { assignment, report }) {
      return decision?.assignment_id === assignment.assignment_id && decision.assignment_digest === assignment.assignment_digest
        && decision.report_digest === digest(report) && decision.subject_digest === assignment.subject_digest;
    }
    export async function authorizeTerminal(context) {
      return { ref: 'acceptance:' + context.snapshotDigest, snapshotDigest: context.snapshotDigest };
    }
    export async function verifyAcceptance(decision, context) {
      return decision?.snapshotDigest === context.snapshotDigest && decision.ref === 'acceptance:' + context.snapshotDigest;
    }
  `);
  const profiles = {
    execution: { model: 'execution-model', agent: 'builder', access_class: 'bounded-mutation', permissions: ['project:write'] },
    review: { model: 'review-model', agent: 'readonly-reviewer', access_class: 'read-only', permissions: ['project:read'] },
    diagnosis: { model: 'diagnosis-model', agent: 'readonly-diagnostician', access_class: 'read-only', permissions: ['project:read'] },
    stewardship: { model: 'stewardship-model', agent: 'readonly-steward', access_class: 'read-only', permissions: ['project:read'] },
  };
  const executor = (profileDirectory) => ({ command: process.execPath,
    args: [workerPath, '{assignment.model}', '{assignment.agent}', controlDirectory], stateDirectory: profileDirectory, envNames: [] });
  const config = {
    enabled: true, legacyExcluded: true, projectId, workspaceRoot: workspace, identityFiles: [identityPath], authorityModule: authorityPath,
    coordinatorId: 'assignment-subprocess-test', intervalMs: 1000, timeoutMs: 15000, assignmentProfiles: profiles,
    executor: { ...executor(stateDirectory), purposeExecutors: {
      review: executor(path.join(directory, 'review-attempts')),
      diagnosis: executor(path.join(directory, 'diagnosis-attempts')),
      stewardship: executor(path.join(directory, 'stewardship-attempts')),
    } },
  };
  await writeFile(configPath, JSON.stringify(config));
  const tick = () => invoke(cliPath, 'tick', configPath, connectionString);
  try {
    await invoke(cliPath, 'migrate', configPath, connectionString);
    const submitted = await invoke(cliPath, 'submit', configPath, connectionString, ['--thread', threadId, '--receipt', `receipt-${randomUUID()}`, '--message-file', messagePath]);
    firstCoordinator = startCli(cliPath, 'tick', configPath, connectionString);
    await waitFor(() => exists(launchPath), 'stewardship subprocess launch');
    workerPid = Number(await readFile(launchPath, 'utf8'));
    const interrupted = await signalAndWait(firstCoordinator.child, 'SIGKILL');
    assert.ok(interrupted, 'coordinator process interruption should complete');
    assert.equal(process.kill(workerPid, 0), true, 'purpose-bound worker survives coordinator interruption');
    await writeFile(gatePath, 'release');
    await waitFor(() => exists(donePath), 'retained stewardship report completion');
    const assignmentTask = (await pool.query(`SELECT a.assignment_work_unit_id FROM vnext_assignments a
      WHERE a.project_id=$1 AND a.purpose='stewardship' AND a.status='queued'`, [projectId])).rows[0].assignment_work_unit_id;
    const { rows: [{ expiry }] } = await pool.query("SELECT clock_timestamp()-interval '1 second' AS expiry");
    const expiryClient = await pool.connect();
    try {
      await expiryClient.query('BEGIN');
      await expiryClient.query('UPDATE vnext_work_units SET claim_expires_at=$2 WHERE work_unit_id=$1', [assignmentTask, expiry]);
      await expiryClient.query("UPDATE vnext_executions SET claim_expires_at=$2 WHERE work_unit_id=$1 AND state IN ('created','running')", [assignmentTask, expiry]);
      await expiryClient.query('UPDATE vnext_project_mutation_authority SET claim_expires_at=$2 WHERE work_unit_id=$1', [assignmentTask, expiry]);
      await expiryClient.query('COMMIT');
    } catch (error) { await expiryClient.query('ROLLBACK').catch(() => {}); throw error; }
    finally { expiryClient.release(); }
    const recoveredPass = await tick();
    assert.equal(recoveredPass.status, 'dispatched', `restart should settle and decide the retained assignment report: ${JSON.stringify(recoveredPass)}`);
    assert.equal((await tick()).status, 'needs-review', 'the recovered stewardship decision enables execution, which cannot accept its own completion');
    assert.equal((await tick()).status, 'dispatched', 'independent reviewer runs as a real subprocess');
    assert.equal((await tick()).status, 'dispatched', 'review recommendation is recorded separately');
    assert.equal((await tick()).status, 'accepted', 'authorized snapshot-bound acceptance follows review');
    const status = await invoke(cliPath, 'inspect', configPath, connectionString);
    assert.equal(status.objectives.length, 1);
    const objective = status.objectives[0];
    assert.equal(objective.state, 'terminal');
    assert.equal(objective.accepted_completion?.accepted, true);
    assert.equal(objective.assignments.filter(row => row.purpose === 'review').length, 1);
    assert.equal(objective.assignments.find(row => row.purpose === 'review').decision?.outcome, 'recommend_accept');
  } finally {
    await writeFile(gatePath, 'release').catch(() => {});
    if (workerPid) { try { process.kill(workerPid, 'SIGKILL'); } catch { /* worker already exited */ } }
    if (firstCoordinator?.child.exitCode === null) await signalAndWait(firstCoordinator.child, 'SIGKILL');
    await pool.end();
    await rm(directory, { recursive: true, force: true });
  }
});
