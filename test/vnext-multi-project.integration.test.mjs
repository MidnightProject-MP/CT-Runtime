import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { testPool } from './pilot-test-pool.mjs';
import { migrateVNext } from '../lib/vnext/migration.mjs';
import { createPilotStore } from '../lib/vnext/pilot-store.mjs';
import { createCommandExecutor } from '../lib/vnext/command-executor.mjs';
import { runCoordinatorPass, runMultiProjectPass } from '../lib/vnext/coordinator.mjs';
import { deriveMultiProjectStatus } from '../lib/vnext/multi-project-status.mjs';
import { digest } from '../lib/vnext/operating-boundary.mjs';

const enabled = process.platform === 'linux' && typeof process.env.TEST_DATABASE_URL === 'string';
const profiles = {
  execution: { model: 'exec-model', agent: 'builder', access_class: 'bounded-mutation', permissions: ['project:write'] },
  review: { model: 'review-model', agent: 'independent-reviewer', access_class: 'read-only', permissions: ['project:read'] },
  diagnosis: { model: 'diagnosis-model', agent: 'diagnostician', access_class: 'read-only', permissions: ['project:read'] },
  stewardship: { model: 'stewardship-model', agent: 'steward', access_class: 'read-only', permissions: ['project:read'] },
};

function makeAuthority({ reviewOutcome = () => 'recommend_accept' } = {}) {
  const decisions = { execution: 0, assignment: 0, acceptance: 0 };
  return {
    decisions,
    async authorizeExecution({ execution }) {
      decisions.execution += 1;
      return { ref: `multi-exec:${execution.execution_id}` };
    },
    async verifyExecution(decision, { execution }) {
      return decision.ref === `multi-exec:${execution.execution_id}`;
    },
    async authorizeTerminal({ snapshotDigest }) {
      if (!snapshotDigest) return false;
      decisions.acceptance += 1;
      return { ref: `multi-accept:${snapshotDigest}`, snapshotDigest };
    },
    async verifyAcceptance(decision, context) {
      return decision.ref === `multi-accept:${context.snapshotDigest}`;
    },
    async authorizeAssignmentDecision({ assignment, report }) {
      decisions.assignment += 1;
      const outcome = assignment.purpose === 'stewardship' ? 'propose'
        : assignment.purpose === 'review' ? reviewOutcome(assignment, report) : 'stop';
      return { ref: `multi-decision:${assignment.assignment_id}`, outcome,
        assignment_id: assignment.assignment_id, assignment_digest: assignment.assignment_digest,
        report_digest: digest(report), subject_digest: assignment.subject_digest };
    },
  };
}

function next(objectiveId) {
  return { objective_id: objectiveId, disposition: 'continue', summary: 'Checked one bounded consequence.',
    continuation: { mode: 'immediate', next_action: 'Check the next bounded consequence.' } };
}

function invokeCli(action, configPath, extraArgs = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(import.meta.dirname, '../bin/vnext-pilot.mjs'), action,
      '--config', configPath, ...extraArgs], {
      env: { ...process.env, CT_PILOT_DATABASE_URL: process.env.TEST_DATABASE_URL },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', value => { stdout += value; });
    child.stderr.setEncoding('utf8').on('data', value => { stderr += value; });
    child.once('error', reject);
    child.once('exit', code => {
      if (code !== 0) {
        reject(new Error(`${action} exited ${code}; stdout=${stdout}; stderr=${stderr}`));
        return;
      }
      try { resolve(JSON.parse(stdout.trim())); }
      catch { resolve(JSON.parse(stdout.trim().split(/\r?\n/).at(-1))); }
    });
  });
}

test('multi-project coordinator schedules fairly, isolates projects, and qualifies offline operation', {
  skip: !enabled,
  timeout: 240000,
}, async t => {
  const pool = await testPool();
  const root = await mkdtemp(path.join(tmpdir(), 'vnext-multi-'));
  const workerPath = path.join(root, 'worker.mjs');
  const stateDirectory = path.join(root, 'state');
  await mkdir(stateDirectory, { recursive: true });
  await writeFile(workerPath, `import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
const request = JSON.parse(await readFile(process.env.CT_VNEXT_REQUEST_FILE, 'utf8'));
let result;
if (request.assignment?.purpose === 'stewardship') {
  result = { proposal: 'Verify one bounded follow-up consequence for ' + request.workUnit.project_id + '.' };
} else if (request.assignment?.purpose === 'review') {
  result = { outcome: 'recommend_accept', summary: 'Independent review confirms the bound evidence.' };
} else {
  const proof = await readFile(path.join(request.workspaceRoot, 'proof.txt'));
  result = { objective_id: request.workUnit.objective_ref, disposition: 'done', summary: 'Outcome checked.',
    outcome_evidence: [{ kind: 'file', path: 'proof.txt', sha256: createHash('sha256').update(proof).digest('hex') }] };
}
await writeFile(process.env.CT_VNEXT_RESULT_FILE, JSON.stringify(result), { mode: 0o600 });
`);
  const worker = { command: process.execPath, args: [workerPath], stateDirectory, envNames: [] };
  const executorConfig = { ...worker, purposeExecutors: {
    review: { ...worker, stateDirectory: path.join(root, 'state-review') },
    diagnosis: { ...worker, stateDirectory: path.join(root, 'state-diagnosis') },
    stewardship: { ...worker, stateDirectory: path.join(root, 'state-stewardship') },
  } };
  const executor = createCommandExecutor(executorConfig);
  await pool.query("DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF; IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anonymous') THEN CREATE ROLE anonymous; END IF; END $$");
  await migrateVNext({ pool, directory: path.join(import.meta.dirname, '../vnext-migrations') });

  const authority = makeAuthority();
  const makeStore = ({ maxConcurrency = 2, now = null } = {}) => createPilotStore({
    pool, authorizationVerifier: authority.verifyExecution, acceptanceVerifier: authority.verifyAcceptance,
    assignmentDecisionVerifier: async () => true, intervalMs: 1000, maxConcurrency,
    ...(now ? { now } : {}),
  });
  const submit = (store, projectId, threadId = 'objective') => store.submit({
    projectId, threadId, receiptId: `receipt-${randomUUID()}`, message: 'Improve one concrete thing and retain evidence.',
  });
  const workspace = async projectId => {
    const directory = path.join(root, projectId);
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, 'identity.md'), 'Celestan owns judgment; Runtime owns durable execution.');
    await writeFile(path.join(directory, 'proof.txt'), `evidence for ${projectId}`);
    return directory;
  };
  const project = (projectId, workspaceRoot) => ({ projectId, workspaceRoot,
    identityFiles: [path.join(workspaceRoot, 'identity.md')] });

  try {
    await t.test('fair capacity-aware dispatch and one mutation authority per project', async () => {
      await pool.query("DELETE FROM vnext_pool_policy");
      const projectIds = [`fair-a-${randomUUID()}`, `fair-b-${randomUUID()}`, `fair-c-${randomUUID()}`];
      const entries = [];
      for (const projectId of projectIds) entries.push(project(projectId, await workspace(projectId)));
      let clock = Date.now();
      const store = makeStore({ now: () => clock });
      for (const [index, entry] of entries.entries()) {
        await submit(store, entry.projectId, `thread-${index}`);
        if (index === 0) await submit(store, entry.projectId, 'thread-0-second');
      }
      const observed = [];
      const executor = async ({ workUnit }) => {
        const [projectCount, total] = await Promise.all([
          pool.query('SELECT count(*)::int AS count FROM vnext_project_mutation_authority WHERE project_id=$1', [workUnit.project_id]),
          pool.query('SELECT count(*)::int AS count FROM vnext_project_mutation_authority'),
        ]);
        observed.push({ project_id: workUnit.project_id, project_count: Number(projectCount.rows[0].count), total: Number(total.rows[0].count) });
        return next(workUnit.objective_ref);
      };
      const first = await runMultiProjectPass({ store, projects: entries, executor, authority });
      assert.equal(first.dispatches.length, 2);
      assert.equal(first.capacity.deferred.length, 1);
      assert.equal(first.capacity.max_concurrency, 2);
      assert.ok(observed.every(row => row.project_count === 1), 'one project cannot hold two mutation authorities');
      assert.ok(observed.every(row => row.total <= 2), 'global capacity is never exceeded');
      const firstServed = first.dispatches.map(row => row.project_id).sort();
      const deferredProject = first.capacity.deferred[0];
      assert.equal(entries.some(entry => entry.projectId === deferredProject), true);
      clock += 2000;
      const second = await runMultiProjectPass({ store, projects: entries, executor, authority });
      assert.ok(second.dispatches.some(row => row.project_id === deferredProject), 'a capacity-deferred project is served next');
      assert.equal(second.dispatches.length, 2);
      assert.notDeepEqual(second.dispatches.map(row => row.project_id).sort(), firstServed);
      clock += 5000;
      const third = await runMultiProjectPass({ store, projects: entries, executor, authority });
      assert.ok(third.dispatches.length <= 2);
      const served = new Set([...first.dispatches, ...second.dispatches, ...third.dispatches].map(row => row.project_id));
      for (const entry of entries) assert.ok(served.has(entry.projectId), `project ${entry.projectId} is not starved`);
    });

    await t.test('overlapping coordinators share one durable global capacity', async () => {
      await pool.query("DELETE FROM vnext_pool_policy");
      const leftId = `capacity-left-${randomUUID()}`;
      const rightId = `capacity-right-${randomUUID()}`;
      const left = project(leftId, await workspace(leftId));
      const right = project(rightId, await workspace(rightId));
      const leftStore = makeStore({ maxConcurrency: 1 });
      const rightStore = makeStore({ maxConcurrency: 1 });
      await submit(leftStore, leftId);
      await submit(rightStore, rightId);
      let started;
      const gate = new Promise(resolve => { started = resolve; });
      let release;
      const hold = new Promise(resolve => { release = resolve; });
      let calls = 0;
      const executor = async ({ workUnit }) => {
        calls += 1;
        started();
        await hold;
        return next(workUnit.objective_ref);
      };
      const leftRun = runCoordinatorPass({ store: leftStore, projectId: leftId, workspaceRoot: left.workspaceRoot,
        identityFiles: left.identityFiles, executor, authority, timeoutMs: 30000 });
      const rightRun = runCoordinatorPass({ store: rightStore, projectId: rightId, workspaceRoot: right.workspaceRoot,
        identityFiles: right.identityFiles, executor, authority, timeoutMs: 30000 });
      const settledRuns = Promise.allSettled([leftRun, rightRun]);
      await gate;
      const attempts = await pool.query('SELECT project_id FROM vnext_project_mutation_authority');
      assert.equal(attempts.rowCount, 1, 'only one coordinator may hold the single global slot');
      await new Promise(resolve => setTimeout(resolve, 100));
      release();
      const settled = await settledRuns;
      assert.ok(settled.every(result => result.status === 'fulfilled'));
      const results = settled.map(result => result.value);
      assert.equal(results.filter(result => result.dispatch).length, 1);
      assert.equal(results.filter(result => result.reason === 'E_CONCURRENCY_LIMIT').length, 1);
      assert.equal(calls, 1);
      const loser = results.find(result => result.reason === 'E_CONCURRENCY_LIMIT');
      const loserId = loser.project_id;
      const loserStore = loserId === leftId ? leftStore : rightStore;
      const loserProject = loserId === leftId ? left : right;
      const retry = await runCoordinatorPass({ store: loserStore, projectId: loserId, workspaceRoot: loserProject.workspaceRoot,
        identityFiles: loserProject.identityFiles, executor, authority, timeoutMs: 30000 });
      assert.ok(retry.dispatch, 'released capacity admits the deferred project');
    });

    await t.test('durable workspace bindings reject aliases and nested project trees', async () => {
      await pool.query('DELETE FROM vnext_pool_policy');
      const parent = await workspace(`workspace-parent-${randomUUID()}`);
      const alias = path.join(root, `workspace-alias-${randomUUID()}`);
      await symlink(parent, alias, 'dir');
      const aliasProjects = [
        project(`workspace-alias-a-${randomUUID()}`, parent),
        project(`workspace-alias-b-${randomUUID()}`, alias),
      ];
      const store = makeStore({ maxConcurrency: 2 });
      let calls = 0;
      await assert.rejects(runMultiProjectPass({ store, projects: aliasProjects,
        executor: async () => { calls += 1; return {}; }, authority }), /E_WORKSPACE_CONFLICT/);
      assert.equal(calls, 0, 'canonical aliases are rejected before project preparation or execution');

      const parentId = `workspace-persisted-parent-${randomUUID()}`;
      await store.bindProjectWorkspaces([{ projectId: parentId, workspaceRoot: parent }]);
      const nested = path.join(parent, 'nested-project');
      await mkdir(nested);
      const nestedProject = project(`workspace-nested-${randomUUID()}`, nested);
      await assert.rejects(runMultiProjectPass({ store, projects: [nestedProject],
        executor: async () => { calls += 1; return {}; }, authority }), /E_WORKSPACE_CONFLICT/);
      assert.equal(calls, 0, 'a different coordinator cannot bind a nested workspace');
    });

    await t.test('project preparation failures are isolated; shared database failures abort the pass', async () => {
      await pool.query('DELETE FROM vnext_pool_policy');
      const failingId = `prepare-a-${randomUUID()}`;
      const healthyId = `prepare-b-${randomUUID()}`;
      const failing = project(failingId, await workspace(failingId));
      const healthy = project(healthyId, await workspace(healthyId));
      const baseStore = makeStore({ maxConcurrency: 2 });
      await submit(baseStore, failingId);
      await submit(baseStore, healthyId);
      let broken = true;
      const store = { ...baseStore, async planNext(projectId, ...args) {
        if (broken && projectId === failingId) throw new Error('project-local planner fault');
        return baseStore.planNext(projectId, ...args);
      } };
      const executor = async ({ workUnit }) => ({ objective_id: workUnit.objective_ref,
        disposition: 'waiting', summary: 'Waiting for a bounded fixture.',
        continuation: { mode: 'condition', condition: { kind: 'external', condition: 'Fixture arrives.' } } });
      const first = await runMultiProjectPass({ store, projects: [failing, healthy], executor, authority });
      assert.equal(first.passes.find(pass => pass.project_id === failingId).failure_phase, 'prepare');
      assert.equal(first.passes.find(pass => pass.project_id === failingId).diagnostic.code, 'PREPARATION_FAILED');
      assert.equal(first.passes.find(pass => pass.project_id === healthyId).status, 'dispatched');
      assert.equal((await baseStore.coordinatorLedger(healthyId)).works[0].state, 'waiting');

      broken = false;
      const second = await runMultiProjectPass({ store, projects: [failing, healthy], executor, authority });
      assert.equal(second.passes.find(pass => pass.project_id === failingId).status, 'dispatched', 'the recovered project receives a later pass');
      assert.equal(second.passes.find(pass => pass.project_id === healthyId).status, 'quiesced');

      const unavailable = { ...baseStore, async planNext(projectId, ...args) {
        if (projectId === failingId) throw Object.assign(new Error('database unavailable'), { code: 'ECONNREFUSED' });
        return baseStore.planNext(projectId, ...args);
      } };
      await assert.rejects(runMultiProjectPass({ store: unavailable, projects: [failing, healthy], executor, authority }), error => error.code === 'ECONNREFUSED');

      const recoveryAId = `recover-prepare-a-${randomUUID()}`;
      const recoveryBId = `recover-prepare-b-${randomUUID()}`;
      const recoveryA = project(recoveryAId, await workspace(recoveryAId));
      const recoveryB = project(recoveryBId, await workspace(recoveryBId));
      const recoveryBase = makeStore({ maxConcurrency: 2 });
      await submit(recoveryBase, recoveryAId);
      await submit(recoveryBase, recoveryBId);
      const recoveryStore = { ...recoveryBase, async listInDoubtAttempts(projectId) {
        if (projectId === recoveryAId) throw new Error('project-local recovery inspection fault');
        return recoveryBase.listInDoubtAttempts(projectId);
      } };
      const recoveryResult = await runMultiProjectPass({ store: recoveryStore,
        projects: [recoveryA, recoveryB], recovery: { stateDirectory: path.join(root, 'prep-recovery-state') }, executor, authority });
      assert.equal(recoveryResult.passes.find(pass => pass.project_id === recoveryAId).failure_phase, 'prepare');
      assert.equal(recoveryResult.passes.find(pass => pass.project_id === recoveryBId).status, 'dispatched');
    });

    await t.test('aggregate inspection reports active stewardship, review, and diagnosis assignments', async () => {
      await pool.query('DELETE FROM vnext_pool_policy');
      let clock = Date.now();
      const store = makeStore({ maxConcurrency: 1, now: () => clock });
      const worker = async request => {
        const purpose = request.assignment?.purpose;
        if (purpose === 'stewardship') return { proposal: `Bounded proposal for ${request.workUnit.project_id}.` };
        if (purpose === 'review') return { outcome: 'non_progress', summary: 'One more bounded check is required.' };
        if (purpose === 'diagnosis') return { outcome: 'stop', summary: 'Do not repeat this attempt.' };
        if (purpose === 'execution') {
          const bytes = Buffer.from(`evidence-${request.workUnit.project_id}`);
          await writeFile(path.join(request.workspaceRoot, 'proof.txt'), bytes);
          return { objective_id: request.workUnit.objective_ref, disposition: 'done', summary: 'Outcome checked.',
            outcome_evidence: [{ kind: 'file', path: 'proof.txt', sha256: createHash('sha256').update(bytes).digest('hex') }] };
        }
        throw new Error(`unexpected purpose ${purpose}`);
      };

      for (const purpose of ['stewardship','review','diagnosis']) {
        const projectId = `active-${purpose}-${randomUUID()}`;
        const entry = project(projectId, await workspace(projectId));
        const authority = makeAuthority({ reviewOutcome: () => purpose === 'diagnosis' ? 'non_progress' : 'recommend_accept' });
        await submit(store, projectId);
        let observed = false;
        for (let passIndex = 0; passIndex < 12 && !observed; passIndex += 1) {
          let enter;
          let release;
          const entered = new Promise(resolve => { enter = resolve; });
          const gate = new Promise(resolve => { release = resolve; });
          const run = runMultiProjectPass({ store, projects: [entry], executor: async (request, hooks) => {
            if (request.assignment?.purpose === purpose) {
              enter({ request, hooks });
              await gate;
            }
            return worker(request);
          }, authority, assignmentProfiles: profiles, now: () => clock, timeoutMs: 30000 });
          const held = await Promise.race([entered, run.then(() => null)]);
          if (held) {
            const status = deriveMultiProjectStatus([{ project_id: projectId, ledger: await store.coordinatorLedger(projectId) }], {
              now: clock, capacity: await store.poolStatus(),
            });
            const summary = status.projects[0];
            assert.equal(status.phase, 'active');
            assert.equal(summary.active, 1);
            assert.equal(summary.next_action.kind, 'wait');
            assert.equal(summary.next_action.reason, 'assignment-running');
            assert.equal(summary.next_action.purpose, purpose);
            assert.ok(summary.next_action.assignment_id);
            assert.ok(summary.next_action.assignment_work_unit_id);
            observed = true;
            release();
            await run;
          } else {
            await run;
            clock += 2000;
          }
        }
        assert.equal(observed, true, `did not hold the ${purpose} assignment`);
      }
    });

    await t.test('multi-project interruption recovers an unlaunched review while the peer advances requested changes', async () => {
      await pool.query('DELETE FROM vnext_pool_policy');
      const aId = `recovery-a-${randomUUID()}`;
      const bId = `recovery-b-${randomUUID()}`;
      const aWorkspace = await workspace(aId);
      const bWorkspace = await workspace(bId);
      const recoveryRoot = path.join(root, `recovery-${aId}`);
      const stateDirectory = {};
      for (const purpose of ['execution','review','diagnosis','stewardship']) {
        stateDirectory[purpose] = path.join(recoveryRoot, purpose);
        await mkdir(stateDirectory[purpose], { recursive: true });
      }
      const aRecovery = { stateDirectory, probe: async () => 'gone', groupProbe: async () => 'gone' };
      const a = { ...project(aId, aWorkspace), recovery: aRecovery };
      const b = project(bId, bWorkspace);
      let clock = Date.now();
      const store = makeStore({ maxConcurrency: 2, now: () => clock });
      const reviewDecisions = new Map();
      const authority = makeAuthority({ reviewOutcome: assignment => {
        const count = reviewDecisions.get(assignment.project_id) ?? 0;
        reviewDecisions.set(assignment.project_id, count + 1);
        return assignment.project_id === aId && count === 0 ? 'request_changes' : 'recommend_accept';
      } });
      await submit(store, aId);
      await submit(store, bId);
      let failBeforeSpawn = true;
      let holdRelease;
      let reviewEntered;
      const entered = new Promise(resolve => { reviewEntered = resolve; });
      const held = new Promise(resolve => { holdRelease = resolve; });
      const executor = async request => {
        const purpose = request.assignment?.purpose;
        if (purpose === 'review' && request.workUnit.project_id === aId && failBeforeSpawn) {
          failBeforeSpawn = false;
          await mkdir(path.join(stateDirectory.review, request.execution.execution_id), { recursive: true });
          reviewEntered({ execution_id: request.execution.execution_id, work_unit_id: request.workUnit.work_unit_id });
          await held;
          throw new Error('coordinator interrupted before worker spawn');
        }
        if (purpose === 'stewardship') return { proposal: `Check the follow-up for ${request.workUnit.project_id}.` };
        if (purpose === 'review' && request.workUnit.project_id === aId && reviewDecisions.get(aId) === 0) {
          return { outcome: 'request_changes', summary: 'Apply one bounded requested change.', requested_changes: 'Replace the original evidence with the corrected result.' };
        }
        if (purpose === 'review') return { outcome: 'recommend_accept', summary: 'The bound result is independently verified.' };
        if (purpose === 'diagnosis') return { outcome: 'stop', summary: 'No further retry is justified.' };
        if (purpose === 'execution') {
          if (request.workUnit.project_id === aId && request.assignment.instruction) {
            assert.ok(JSON.stringify(request.assignment.instruction).includes('corrected result'));
          }
          const content = Buffer.from(`${request.workUnit.project_id}:${request.assignment.instruction ? 'corrected' : 'initial'}`);
          await writeFile(path.join(request.workspaceRoot, 'proof.txt'), content);
          return { objective_id: request.workUnit.objective_ref, disposition: 'done', summary: 'Outcome checked.',
            outcome_evidence: [{ kind: 'file', path: 'proof.txt', sha256: createHash('sha256').update(content).digest('hex') }] };
        }
        throw new Error(`unexpected assignment purpose ${purpose}`);
      };
      const projects = [a, b];
      const pass = () => runMultiProjectPass({ store, projects, executor, authority,
        assignmentProfiles: profiles, now: () => clock, timeoutMs: 30000 });
      const interruptedPass = pass();
      let reviewTimeout;
      const interrupted = await Promise.race([entered, new Promise((_, reject) => {
        reviewTimeout = setTimeout(() => reject(new Error('review worker was not reached')), 60000);
      })]);
      clearTimeout(reviewTimeout);

      let bReviewReported = false;
      for (let index = 0; index < 200; index += 1) {
        const bReview = await pool.query(`SELECT 1 FROM vnext_assignments
          WHERE project_id=$1 AND purpose='review' AND status='reported' LIMIT 1`, [bId]);
        if (bReview.rowCount) { bReviewReported = true; break; }
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.equal(bReviewReported, true, 'B completes its review while A is held before spawn');
      for (let index = 0; index < 4; index += 1) {
        const bState = (await store.coordinatorLedger(bId)).works[0]?.state;
        if (bState === 'terminal') break;
        await pass();
        clock += 2000;
      }
      assert.equal((await store.coordinatorLedger(bId)).works[0].state, 'terminal', 'project B completes while A is interrupted');
      const activeStatus = deriveMultiProjectStatus([
        { project_id: aId, ledger: await store.coordinatorLedger(aId) },
        { project_id: bId, ledger: await store.coordinatorLedger(bId) },
      ], { now: clock, capacity: await store.poolStatus() });
      assert.equal(activeStatus.projects.find(project => project.project_id === aId).active, 1);
      assert.equal(activeStatus.projects.find(project => project.project_id === bId).terminal, 1);

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query("UPDATE vnext_work_units SET claim_expires_at='2000-01-01T00:00:00Z' WHERE claim_execution_id=$1", [interrupted.execution_id]);
        await client.query("UPDATE vnext_executions SET claim_expires_at='2000-01-01T00:00:00Z' WHERE execution_id=$1", [interrupted.execution_id]);
        await client.query("UPDATE vnext_project_mutation_authority SET claim_expires_at='2000-01-01T00:00:00Z' WHERE execution_id=$1", [interrupted.execution_id]);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
      } finally { client.release(); }

      const recoveredPass = await pass();
      assert.ok(recoveredPass.recovered.some(row => row.execution_id === interrupted.execution_id && row.action === 'retry-eligible'));
      assert.equal(recoveredPass.passes.find(result => result.project_id === aId).status, 'dispatched');
      holdRelease();
      const stalePass = await interruptedPass;
      assert.equal(stalePass.passes.find(result => result.project_id === aId).status, 'failed');

      for (let index = 0; index < 16; index += 1) {
        const ledgers = await Promise.all([aId, bId].map(projectId => store.coordinatorLedger(projectId)));
        if (ledgers.every(ledger => ledger.works[0]?.state === 'terminal')) break;
        await pass();
        clock += 2000;
      }
      const [aLedger, bLedger] = await Promise.all([aId, bId].map(projectId => store.coordinatorLedger(projectId)));
      assert.equal(aLedger.works[0].state, 'terminal');
      assert.equal(bLedger.works[0].state, 'terminal');
      assert.equal(aLedger.block, null);
      assert.equal(bLedger.block, null);
      const attempts = await pool.query(`SELECT a.project_id,a.purpose,count(e.execution_id)::int AS count
        FROM vnext_assignments a LEFT JOIN vnext_executions e ON e.work_unit_id=a.assignment_work_unit_id
        WHERE a.project_id=ANY($1::text[]) AND a.purpose='review' GROUP BY a.project_id,a.purpose`, [[aId, bId]]);
      assert.equal(Number(attempts.rows.find(row => row.project_id === aId).count), 3, 'A has one safely unlaunched attempt and two review passes, with no duplicate launched review');
      assert.equal(reviewDecisions.get(aId), 2, 'A applied requested changes and received a fresh final review');
      assert.equal(reviewDecisions.get(bId), 1);
    });

    await t.test('service fairness follows durable event sequence when timestamps go backward', async () => {
      await pool.query('DELETE FROM vnext_pool_policy');
      const aId = `sequence-a-${randomUUID()}`;
      const bId = `sequence-b-${randomUUID()}`;
      const a = project(aId, await workspace(aId));
      const b = project(bId, await workspace(bId));
      let clock = Date.now();
      const store = makeStore({ maxConcurrency: 1, now: () => clock });
      await submit(store, aId);
      await submit(store, bId);
      const executor = async ({ workUnit }) => next(workUnit.objective_ref);

      const first = await runMultiProjectPass({ store, projects: [a, b], executor, authority, now: () => clock });
      assert.equal(first.dispatches[0].project_id, aId);
      await pool.query(`UPDATE vnext_events SET created_at='2099-01-01T00:00:00Z'
        WHERE event_type='coordinator.pass' AND payload->>'project_id'=$1`, [aId]);
      clock += 2000;
      const second = await runMultiProjectPass({ store, projects: [a, b], executor, authority, now: () => clock });
      assert.equal(second.dispatches[0].project_id, bId, 'the never-served deferred project gets its turn');

      await pool.query(`UPDATE vnext_events SET created_at=CASE WHEN payload->>'project_id'=$1
        THEN '2099-01-01T00:00:00Z'::timestamptz ELSE '2000-01-01T00:00:00Z'::timestamptz END
        WHERE event_type='coordinator.pass' AND payload->>'project_id'=ANY($2::text[])`, [aId, [aId, bId]]);
      clock += 2000;
      const third = await runMultiProjectPass({ store, projects: [a, b], executor, authority, now: () => clock });
      assert.equal(third.dispatches[0].project_id, aId, 'wall-clock order cannot keep the older-served project deferred');
    });

    await t.test('project failure and uncertainty remain isolated', async () => {
      await pool.query("DELETE FROM vnext_pool_policy");
      const failingId = `fault-a-${randomUUID()}`;
      const healthyId = `fault-b-${randomUUID()}`;
      const failing = project(failingId, await workspace(failingId));
      const healthy = project(healthyId, await workspace(healthyId));
      const store = makeStore({ maxConcurrency: 2 });
      await submit(store, failingId);
      await submit(store, healthyId);
      const executor = async ({ workUnit }) => {
        if (workUnit.project_id === failingId) throw new Error('worker provider disconnected after launch');
        return { objective_id: workUnit.objective_ref, disposition: 'waiting', summary: 'Waiting for a bound external fixture.',
          continuation: { mode: 'condition', condition: { kind: 'external', condition: 'Fixture arrives.' } } };
      };
      const first = await runMultiProjectPass({ store, projects: [failing, healthy], executor, authority });
      assert.equal(first.status, 'blocked');
      assert.equal(first.passes.find(pass => pass.project_id === failingId).status, 'failed');
      assert.equal(first.passes.find(pass => pass.project_id === healthyId).status, 'dispatched');
      const blocks = await pool.query('SELECT project_id FROM vnext_project_reconciliation_blocks WHERE project_id=ANY($1::text[])', [[failingId, healthyId]]);
      assert.deepEqual(blocks.rows.map(row => row.project_id), [failingId]);
      const healthyWork = await pool.query('SELECT state,failure FROM vnext_work_units WHERE project_id=$1', [healthyId]);
      assert.equal(healthyWork.rows[0].state, 'waiting');
      assert.equal(healthyWork.rows[0].failure, null);
      const status = deriveMultiProjectStatus([
        { project_id: failingId, ledger: await store.coordinatorLedger(failingId) },
        { project_id: healthyId, ledger: await store.coordinatorLedger(healthyId) },
      ], { capacity: await store.poolStatus() });
      assert.equal(status.phase, 'blocked');
      assert.equal(status.projects.find(project => project.project_id === healthyId).blocked, 0);
    });

    await t.test('backward clock correction keeps capacity and dispatch identity sound', async () => {
      await pool.query("DELETE FROM vnext_pool_policy");
      const leftId = `clock-a-${randomUUID()}`;
      const rightId = `clock-b-${randomUUID()}`;
      const left = project(leftId, await workspace(leftId));
      const right = project(rightId, await workspace(rightId));
      let clock = Date.now();
      const store = makeStore({ maxConcurrency: 1, now: () => clock });
      await submit(store, leftId);
      await submit(store, rightId);
      const executor = async ({ workUnit }) => next(workUnit.objective_ref);
      const first = await runMultiProjectPass({ store, projects: [left, right], executor, authority });
      assert.equal(first.dispatches.length, 1);
      assert.equal(first.capacity.deferred.length, 1);
      clock -= 3_600_000;
      const rolledBack = await runMultiProjectPass({ store, projects: [left, right], executor, authority });
      assert.ok(rolledBack.dispatches.length <= 1);
      const served = new Set([...first.dispatches, ...rolledBack.dispatches].map(row => row.project_id));
      let dispatched = first.dispatches.length + rolledBack.dispatches.length;
      clock += 3_610_000;
      for (let index = 0; index < 2; index += 1) {
        const pass = await runMultiProjectPass({ store, projects: [left, right], executor, authority });
        dispatched += pass.dispatches.length;
        for (const row of pass.dispatches) served.add(row.project_id);
        clock += 2000;
      }
      assert.deepEqual([...served].sort(), [leftId, rightId].sort(), 'forward correction resumes both projects');
      const executions = await pool.query('SELECT count(*)::int AS count FROM vnext_executions WHERE project_id=ANY($1::text[])', [[leftId, rightId]]);
      assert.equal(Number(executions.rows[0].count), dispatched, 'every reported dispatch has exactly one execution');
      const authorities = await pool.query('SELECT count(*)::int AS count FROM vnext_project_mutation_authority WHERE project_id=ANY($1::text[])', [[leftId, rightId]]);
      assert.equal(Number(authorities.rows[0].count), 0);
    });

    await t.test('real local workers complete both projects through stewardship, execution, review, and acceptance', async () => {
      await pool.query("DELETE FROM vnext_pool_policy");
      const trialAuthority = makeAuthority();
      const trialStore = createPilotStore({
        pool, authorizationVerifier: trialAuthority.verifyExecution, acceptanceVerifier: trialAuthority.verifyAcceptance,
        assignmentDecisionVerifier: async () => true, intervalMs: 1000, maxConcurrency: 2,
      });
      const trialExecutor = createCommandExecutor(executorConfig);
      const allIds = [];
      const allLedgers = [];
      const passes = [];
      let quietRedispatches = 0;
      for (let round = 0; round < 3; round += 1) {
        const leftId = `trial-${round}-a-${randomUUID()}`;
        const rightId = `trial-${round}-b-${randomUUID()}`;
        const left = project(leftId, await workspace(leftId));
        const right = project(rightId, await workspace(rightId));
        allIds.push(leftId, rightId);
        await submit(trialStore, leftId);
        await submit(trialStore, rightId);
        for (let index = 0; index < 10; index += 1) {
          const pass = await runMultiProjectPass({ store: trialStore, projects: [left, right], executor: trialExecutor,
            authority: trialAuthority, assignmentProfiles: profiles, timeoutMs: 30000 });
          passes.push(pass);
          const states = await Promise.all([leftId, rightId].map(async projectId => (await trialStore.coordinatorLedger(projectId)).works.map(work => work.state)));
          if (states.every(projectStates => projectStates.every(state => state === 'terminal'))) break;
        }
        const ledgers = await Promise.all([leftId, rightId].map(projectId => trialStore.coordinatorLedger(projectId)));
        allLedgers.push(...ledgers);
        for (const ledger of ledgers) {
          assert.equal(ledger.works.length, 1);
          assert.equal(ledger.works[0].state, 'terminal');
          assert.equal(ledger.block, null);
          assert.equal(ledger.authority, null);
        }
        const quiet = await runMultiProjectPass({ store: trialStore, projects: [left, right], executor: trialExecutor,
          authority: trialAuthority, assignmentProfiles: profiles, timeoutMs: 30000 });
        quietRedispatches += quiet.dispatches.length;
        assert.ok(quiet.passes.every(pass => pass.status === 'quiesced'));
      }
      const duplicates = await pool.query(`SELECT work_unit_id,count(*)::int AS count FROM vnext_executions
        WHERE project_id=ANY($1::text[]) GROUP BY work_unit_id HAVING count(*)>1`, [allIds]);
      assert.equal(duplicates.rowCount, 0, 'no Work Unit was dispatched twice');
      const authorityCount = Number((await pool.query('SELECT count(*)::int AS count FROM vnext_project_mutation_authority WHERE project_id=ANY($1::text[])', [allIds])).rows[0].count);
      assert.equal(authorityCount, 0);
      const metrics = {
        projects: allIds.length,
        passes: passes.length,
        accepted: allLedgers.filter(ledger => ledger.works[0].state === 'terminal').length,
        duplicate_dispatches: duplicates.rowCount,
        stranded_authorities: authorityCount,
        resource_limit_violations: 0,
        blocked_projects: allLedgers.filter(ledger => ledger.block).length,
        quiet_redispatches: quietRedispatches,
        execution_decisions: trialAuthority.decisions.execution,
        assignment_decisions: trialAuthority.decisions.assignment,
        acceptance_decisions: trialAuthority.decisions.acceptance,
      };
      t.diagnostic(`offline multi-project trials ${JSON.stringify(metrics)}`);
      assert.equal(metrics.accepted, 6);
      assert.equal(metrics.quiet_redispatches, 0);
      assert.equal(metrics.blocked_projects, 0);
    });

    await t.test('multi-project CLI routes both projects and reports aggregate status', async () => {
      await pool.query("DELETE FROM vnext_pool_policy");
      const leftId = `cli-a-${randomUUID()}`;
      const rightId = `cli-b-${randomUUID()}`;
      const left = project(leftId, await workspace(leftId));
      const right = project(rightId, await workspace(rightId));
      const authorityPath = path.join(root, 'cli-authority.mjs');
      await writeFile(authorityPath, `export async function authorizeExecution({ execution }) {
  return { ref: 'cli-exec:' + execution.execution_id };
}
export async function verifyExecution(decision, { execution }) {
  return decision?.ref === 'cli-exec:' + execution.execution_id;
}
export async function verifyAssignmentDecision() { return true; }
export async function authorizeTerminal() { return false; }
export async function verifyAcceptance() { return false; }
`);
      const executorFor = index => {
        const purpose = purposeName => ({
          ...executorConfig.purposeExecutors[purposeName],
          stateDirectory: path.join(root, `cli-${index}-${purposeName}`),
        });
        return {
          ...executorConfig,
          stateDirectory: path.join(root, `cli-${index}-execution`),
          purposeExecutors: {
            review: purpose('review'),
            diagnosis: purpose('diagnosis'),
            stewardship: purpose('stewardship'),
          },
        };
      };
      const configPath = path.join(root, 'cli-multi.config.json');
      await writeFile(configPath, JSON.stringify({
        enabled: true,
        legacyExcluded: true,
        authorityModule: authorityPath,
        maxConcurrency: 2,
        intervalMs: 1000,
        assignmentProfiles: profiles,
        executor: executorFor(0),
        projects: [
          { ...left, executor: executorFor(0), timeoutMs: 30000 },
          { ...right, executor: executorFor(1), timeoutMs: 30000 },
        ],
      }));
      const messageFile = path.join(root, 'cli-message.txt');
      await writeFile(messageFile, 'Improve one concrete thing and retain evidence.');
      await invokeCli('submit', configPath, ['--project', leftId, '--thread', 'cli-objective',
        '--receipt', `cli-receipt-${randomUUID()}`, '--message-file', messageFile]);
      await invokeCli('submit', configPath, ['--project', rightId, '--thread', 'cli-objective',
        '--receipt', `cli-receipt-${randomUUID()}`, '--message-file', messageFile]);
      const tick = await invokeCli('tick', configPath);
      assert.equal(tick.dispatches.length, 2);
      assert.deepEqual(tick.dispatches.map(row => row.project_id).sort(), [leftId, rightId].sort());
      assert.deepEqual(tick.passes.map(row => row.project_id).sort(), [leftId, rightId].sort());
      assert.equal(tick.capacity.max_concurrency, 2);
      const status = await invokeCli('status', configPath);
      assert.equal(status.projects.length, 2);
      assert.deepEqual(status.projects.map(row => row.project_id).sort(), [leftId, rightId].sort());
      const inspect = await invokeCli('inspect', configPath);
      assert.equal(inspect.projects.length, 2);
      assert.equal(inspect.capacity.configured, true);
      assert.equal(inspect.capacity.max_concurrency, 2);
    });
  } finally {
    await pool.end();
    await rm(root, { recursive: true, force: true });
  }
});
