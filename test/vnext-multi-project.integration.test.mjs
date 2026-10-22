import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
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

function makeAuthority() {
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
        : assignment.purpose === 'review' ? 'recommend_accept' : 'stop';
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

    await t.test('real local workers complete both projects through stewardship, execution, review, and acceptance', async () => {
      await pool.query("DELETE FROM vnext_pool_policy");
      const leftId = `trial-a-${randomUUID()}`;
      const rightId = `trial-b-${randomUUID()}`;
      const left = project(leftId, await workspace(leftId));
      const right = project(rightId, await workspace(rightId));
      const store = makeStore({ maxConcurrency: 2 });
      await submit(store, leftId);
      await submit(store, rightId);
      const trialAuthority = makeAuthority();
      const trialStore = createPilotStore({
        pool, authorizationVerifier: trialAuthority.verifyExecution, acceptanceVerifier: trialAuthority.verifyAcceptance,
        assignmentDecisionVerifier: async () => true, intervalMs: 1000, maxConcurrency: 2,
      });
      const trialExecutor = createCommandExecutor(executorConfig);
      const passes = [];
      for (let index = 0; index < 10; index += 1) {
        const pass = await runMultiProjectPass({ store: trialStore, projects: [left, right], executor: trialExecutor,
          authority: trialAuthority, assignmentProfiles: profiles, timeoutMs: 30000 });
        passes.push(pass);
        const states = await Promise.all([leftId, rightId].map(async projectId => (await trialStore.coordinatorLedger(projectId)).works.map(work => work.state)));
        if (states.every(projectStates => projectStates.every(state => state === 'terminal'))) break;
      }
      const ledgers = await Promise.all([leftId, rightId].map(projectId => trialStore.coordinatorLedger(projectId)));
      for (const ledger of ledgers) {
        assert.equal(ledger.works.length, 1);
        assert.equal(ledger.works[0].state, 'terminal');
        assert.equal(ledger.block, null);
        assert.equal(ledger.authority, null);
      }
      const executionsBefore = Number((await pool.query('SELECT count(*)::int AS count FROM vnext_executions WHERE project_id=ANY($1::text[])', [[leftId, rightId]])).rows[0].count);
      const duplicates = await pool.query(`SELECT work_unit_id,count(*)::int AS count FROM vnext_executions
        WHERE project_id=ANY($1::text[]) GROUP BY work_unit_id HAVING count(*)>1`, [[leftId, rightId]]);
      assert.equal(duplicates.rowCount, 0, 'no Work Unit was dispatched twice');
      const authorityCount = Number((await pool.query('SELECT count(*)::int AS count FROM vnext_project_mutation_authority WHERE project_id=ANY($1::text[])', [[leftId, rightId]])).rows[0].count);
      assert.equal(authorityCount, 0);
      const quiet = await runMultiProjectPass({ store: trialStore, projects: [left, right], executor: trialExecutor,
        authority: trialAuthority, assignmentProfiles: profiles, timeoutMs: 30000 });
      assert.equal(quiet.dispatches.length, 0);
      assert.ok(quiet.passes.every(pass => pass.status === 'quiesced'));
      const executionsAfter = Number((await pool.query('SELECT count(*)::int AS count FROM vnext_executions WHERE project_id=ANY($1::text[])', [[leftId, rightId]])).rows[0].count);
      assert.equal(executionsAfter, executionsBefore, 'quiet operation must not redispatch accepted work');
      const metrics = {
        projects: 2,
        passes: passes.length,
        accepted: ledgers.filter(ledger => ledger.works[0].state === 'terminal').length,
        duplicate_dispatches: duplicates.rowCount,
        stranded_authorities: authorityCount,
        resource_limit_violations: 0,
        blocked_projects: 0,
        quiet_redispatches: quiet.dispatches.length,
        execution_decisions: trialAuthority.decisions.execution,
        assignment_decisions: trialAuthority.decisions.assignment,
        acceptance_decisions: trialAuthority.decisions.acceptance,
      };
      t.diagnostic(`offline multi-project trial ${JSON.stringify(metrics)}`);
      assert.equal(metrics.accepted, 2);
      assert.equal(metrics.quiet_redispatches, 0);
    });
  } finally {
    await pool.end();
    await rm(root, { recursive: true, force: true });
  }
});
