import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import path from 'node:path';
import { Pool } from 'pg';
import { migrate } from '../lib/migration.mjs';
import { PostgresStore } from '../lib/postgres-store.mjs';
import { invoke, recover } from '../lib/runtime.mjs';
import { createSemanticEvidenceEnvelope } from '../lib/semantic-evidence.mjs';

const connectionString = process.env.TEST_DATABASE_URL;
const fixture = path.join(import.meta.dirname, 'fixture-runner.mjs');
const dueWake = (project = 'pg-demo') => ({ time: new Date(Date.now() - 1000).toISOString(), reason: 'scheduled', priority: 'normal', project });
const futureWake = (project = 'pg-demo', year = 2030) => ({ time: `${year}-01-01T00:00:00.000Z`, reason: 'self_scheduled', priority: 'low', project });
const launch = { command: process.execPath, commandArgs: [fixture], model: 'provider/model', agent: 'build', task: 'fixture task' };
const semanticEnvelope = (executionId, statement = 'persisted claim') => createSemanticEvidenceEnvelope({ lineage: { physicalExecutionId: executionId, workOrderId: `${executionId}-work` }, sources: [{ sourceId: 'source-1', sourceClass: 'execution-reported', reference: `ct-runtime-result:${executionId}`, sha256: null, sourceExecutionId: executionId }], claims: [{ claimId: 'claim-1', claimType: 'execution-summary', statement, supportSourceIds: ['source-1'] }] });

test('Postgres runtime lifecycle is canonical, fenced, and atomic', { skip: !connectionString, timeout: 60000 }, async (t) => {
  const poolA = new Pool({ connectionString, max: 5 });
  const poolB = new Pool({ connectionString, max: 5 });
  const evidenceStore = new FakeEvidenceStore();
  const storeA = new PostgresStore({ pool: poolA, config: { runtimeVersion: 'test' }, evidenceStore });
  const storeB = new PostgresStore({ pool: poolB, config: { runtimeVersion: 'test' }, evidenceStore });
  try {
    await migrate({ pool: poolA, directory: path.join(import.meta.dirname, '..', 'migrations') });

    await t.test('immutable manifests conflict and both hosts read one canonical execution', async () => {
      const input = { executionId: 'canonical', project: 'pg-demo', task: 'task', model: 'model', agent: 'agent' };
      assert.equal((await storeA.createManifest(input)).created, true);
      assert.equal((await storeB.createManifest(input)).created, false);
      await assert.rejects(() => storeB.createManifest({ ...input, task: 'different' }), /identity conflict/);
      assert.deepEqual(await storeA.manifest('canonical'), await storeB.manifest('canonical'));
      await storeA.hostTelemetry({ executionId: 'canonical', host: { instanceId: 'host-a' }, availability: 'available' });
      await storeB.hostTelemetry({ executionId: 'canonical', host: { instanceId: 'host-b' }, availability: 'available' });
      const hosts = await poolA.query("SELECT host_instance_id FROM runtime_host_telemetry WHERE execution_id='canonical' ORDER BY host_instance_id");
      assert.deepEqual(hosts.rows.map((item) => item.host_instance_id), ['host-a', 'host-b']);
    });

    await t.test('stale lease takeover fences the old pool writer', async () => {
      await storeA.createManifest({ executionId: 'fenced', project: 'pg-demo', task: 'task', model: 'model', agent: 'agent' });
      const oldLease = await storeA.lease('fenced', 'owner-a', 20);
      await new Promise((resolve) => setTimeout(resolve, 40));
      const blocker = await poolA.connect();
      await blocker.query('BEGIN');
      await blocker.query("SELECT execution_id FROM runtime_leases WHERE execution_id='fenced' FOR UPDATE");
      const takeover = storeB.lease('fenced', 'owner-b', 1000);
      assert.equal(await Promise.race([takeover.then(() => 'acquired'), new Promise((resolve) => setTimeout(() => resolve('blocked'), 30))]), 'blocked');
      await blocker.query('COMMIT');
      blocker.release();
      const newLease = await takeover;
      assert.equal(newLease.acquired, true);
      assert.equal(typeof newLease.fence, 'string');
      assert.equal(typeof newLease.revision, 'string');
      await assert.rejects(() => storeA.updateManifest('fenced', { execution: { status: 'failed' } }, oldLease), /fencing/);
      await storeB.updateManifest('fenced', { execution: { status: 'running' } }, newLease);
      await storeB.release('fenced', newLease);
    });

    await t.test('SKIP LOCKED yields one claim and maps its work order', async () => {
      const scheduled = await storeA.schedule(dueWake(), launch);
      const [left, right] = await Promise.all([storeA.claimSchedules(1, 'claimer-a'), storeB.claimSchedules(1, 'claimer-b')]);
      assert.equal(left.length + right.length, 1);
      const claim = [...left, ...right][0];
      assert.equal(typeof claim.claimFence, 'string');
      assert.equal(claim.workOrder, scheduled.schedule.workOrder);
      const made = await storeA.createManifest({ executionId: claim.executionId, workOrder: claim.workOrder, launch: claim.launch, project: claim.wake.project, task: claim.launch.task, model: claim.launch.model, agent: claim.launch.agent, wake_reason: claim.wake.reason });
      assert.equal(made.manifest.workOrder, claim.workOrder);
      await storeA.completeSchedule(claim, 'completed');
    });

    await t.test('a stale schedule claim is not reclaimed while its execution lease is current', async () => {
      const scheduled = await storeA.schedule({ ...dueWake(), priority: 'active-lease' }, launch);
      const claim = (await storeA.claimSchedules(1, 'active-owner'))[0];
      await storeA.createManifest({ executionId: claim.executionId, workOrder: claim.workOrder, launch: claim.launch, project: claim.wake.project, task: claim.launch.task, model: claim.launch.model, agent: claim.launch.agent, wake_reason: claim.wake.reason });
      const lease = await storeA.lease(claim.executionId, 'invoker', 30000);
      await poolA.query("UPDATE runtime_schedules SET claimed_at=clock_timestamp()-interval '10 minutes' WHERE schedule_key=$1", [scheduled.schedule.key]);
      assert.equal((await storeB.claimSchedules(10, 'reclaimer')).some((item) => item.scheduleKey === scheduled.schedule.key), false);
      await storeA.release(claim.executionId, lease);
      const reclaimed = await storeB.claimSchedules(10, 'reclaimer');
      assert.equal(reclaimed.some((item) => item.scheduleKey === scheduled.schedule.key), true);
    });

    await t.test('finalization commits attempt, event, execution, and wake or rolls all back', async () => {
      await storeA.createManifest({ executionId: 'finalize', workOrder: 'finalize-work', launch, project: 'pg-demo', task: 'task', model: 'model', agent: 'agent' });
      const lease = await storeA.lease('finalize', 'finalizer', 30000);
      const startedAt = new Date().toISOString(), finishedAt = new Date(Date.now() + 1).toISOString(), wake = futureWake();
      await storeA.finalizeExecution('finalize', { status: 'success', attempt: 1, startedAt, finishedAt, result: { status: 'continue' }, failure: null, output: { stdoutTruncated: false }, processResult: { code: 0 }, modelRuntimeTelemetry: { availability: 'available' }, requested_next_wake: wake, event: { executionId: 'finalize', status: 'success' }, launch }, lease);
      const counts = await poolA.query("SELECT (SELECT count(*) FROM runtime_attempts WHERE execution_id='finalize') attempts,(SELECT count(*) FROM runtime_events WHERE execution_id='finalize' AND event_type='process_finished') events,(SELECT count(*) FROM runtime_schedules WHERE wake_time=$1) schedules", [wake.time]);
      assert.deepEqual(counts.rows[0], { attempts: '1', events: '1', schedules: '1' });
      assert.equal((await storeA.manifest('finalize')).requested_next_wake.time, wake.time);
      await assert.rejects(() => storeA.finalizeExecution('finalize', { status: 'failed', attempt: 1, startedAt, finishedAt, result: { changed: true }, requested_next_wake: null, event: {} }, lease), /attempt immutable/);
      await assert.rejects(() => storeA.finalizeExecution('finalize', { status: 'success', attempt: 2, startedAt, finishedAt: new Date().toISOString(), result: {}, requested_next_wake: futureWake('pg-demo', 2029), event: {} }, lease), /cannot regress/);
      assert.equal((await poolA.query("SELECT count(*) FROM runtime_attempts WHERE execution_id='finalize'")).rows[0].count, '1');
      await storeA.release('finalize', lease);
    });

    await t.test('recovery writes crashed attempts and stops at its durable bound', async () => {
      await storeA.createManifest({ executionId: 'recoverable', project: 'pg-demo', task: 'task', model: 'model', agent: 'agent' });
      await poolA.query("UPDATE runtime_executions SET status='running',started_at='2000-01-01',last_heartbeat_at='2000-01-01' WHERE execution_id='recoverable'");
      for (let count = 1; count <= 4; count++) {
        const recovered = await storeA.recoverExecution('recoverable', { staleMs: 1, maxRecovery: 3 });
        assert.equal(recovered.recoveryAttempts, count);
      }
      const manifest = await storeA.manifest('recoverable');
      assert.equal(manifest.execution.status, 'crashed');
      assert.equal(manifest.recoveryAttempts, 4);
      assert.equal(manifest.recovery.status, 'bounded-abandonment');
      assert.equal((await poolA.query("SELECT count(*) FROM runtime_attempts WHERE execution_id='recoverable' AND status='crashed'")).rows[0].count, '4');
    });

    await t.test('topology rejects supplied children and cross-root parents, then derives children', async () => {
      await storeA.createManifest({ executionId: 'root-a', project: 'pg-demo', task: 'task', model: 'model', agent: 'agent' });
      await storeA.createManifest({ executionId: 'root-b', project: 'pg-demo', task: 'task', model: 'model', agent: 'agent' });
      await assert.rejects(() => storeA.createManifest({ executionId: 'bad-children', project: 'pg-demo', task: 'task', model: 'model', agent: 'agent', topology: { rootId: 'root-a', parentId: 'root-a', childIds: ['forged'] } }), /authoritative/);
      await assert.rejects(() => storeA.createManifest({ executionId: 'cross-root', project: 'pg-demo', task: 'task', model: 'model', agent: 'agent', topology: { rootId: 'root-a', parentId: 'root-b', childIds: [] } }), /root mismatch/);
      await storeA.createManifest({ executionId: 'child-a', project: 'pg-demo', task: 'task', model: 'model', agent: 'agent', topology: { rootId: 'root-a', parentId: 'root-a', childIds: [] } });
      await storeA.rebuildTopology();
      assert.deepEqual((await storeA.manifest('root-a')).topology.childIds, ['child-a']);
    });

    await t.test('invoke finalizes through Postgres with actual evidence attempts', async () => {
      await storeA.createManifest({ executionId: 'invoked', project: 'pg-demo', task: 'task', model: 'model', agent: 'agent' });
      const result = await invoke({ store: storeA, executionId: 'invoked', command: process.execPath, commandArgs: [fixture], model: 'model', agent: 'agent', task: 'task', maxRetries: 0 });
      assert.equal(result.status, 'success');
      assert.equal((await storeB.manifest('invoked')).execution.status, 'success');
      assert.deepEqual(evidenceStore.attempts.filter((item) => item.executionId === 'invoked').map((item) => item.attempt), [1]);
      const attempt = (await poolB.query("SELECT status,process_result FROM runtime_attempts WHERE execution_id='invoked' AND attempt=1")).rows[0];
      assert.equal(attempt.status, 'success');
      assert.equal(attempt.process_result.code, 0);
    });

    await t.test('semantic evidence is validated, immutable, fenced, and bounded', async () => {
      await storeA.createManifest({ executionId: 'semantic-pg', project: 'pg-demo', task: 'task', model: 'model', agent: 'agent' });
      const lease = await storeA.lease('semantic-pg', 'semantic-owner', 30000);
      const envelope = semanticEnvelope('semantic-pg');
      const reference = await storeA.persistSemanticEvidence('semantic-pg', envelope, lease);
      assert.deepEqual(reference, { envelopeId: envelope.envelopeId, executionId: 'semantic-pg', sha256: envelope.contentHash, bytes: Buffer.byteLength(JSON.stringify(envelope)) });
      assert.deepEqual(await storeB.semanticEvidenceFor('semantic-pg'), [envelope]);
      assert.deepEqual(await storeA.persistSemanticEvidence('semantic-pg', envelope, lease), reference);
      await assert.rejects(() => storeA.persistSemanticEvidence('semantic-pg', { ...envelope, lineage: { physicalExecutionId: 'other' } }, lease), /contentHash|execution/);
      await storeA.release('semantic-pg', lease);
      await assert.rejects(() => storeA.persistSemanticEvidence('semantic-pg', envelope, lease), /fencing/);
      await assert.rejects(() => storeB.semanticEvidenceFor('semantic-pg', { limit: 101 }), /limit/);
    });

    await t.test('generic recovery delegates to the atomic Postgres path', async () => {
      await storeA.createManifest({ executionId: 'generic-recovery', project: 'pg-demo', task: 'task', model: 'model', agent: 'agent' });
      await poolA.query("UPDATE runtime_executions SET status='running',started_at='2000-01-01',last_heartbeat_at='2000-01-01' WHERE execution_id='generic-recovery'");
      const result = await recover({ store: storeB, staleMs: 1 });
      assert.equal(result.requeued.includes('generic-recovery'), true);
      assert.equal((await storeA.manifest('generic-recovery')).recoveryAttempts, 1);
    });
  } finally {
    await Promise.allSettled([poolA.end(), poolB.end()]);
  }
});

class FakeEvidenceStore {
  attempts = [];
  objects = [];

  async put({ project, executionId, attempt, label, content }) {
    const body = Buffer.from(String(content));
    const hash = crypto.createHash('sha256').update(body).digest('hex');
    const objectKey = `${project}/${executionId}/${attempt}/${label}-${hash}`;
    this.attempts.push({ executionId, attempt });
    this.objects.push({ objectKey, hash });
    return { evidenceId: `${label}-${hash}`, objectKey, objectUri: `fake://${objectKey}`, sha256: hash, bytes: body.length, truncated: false, contentType: 'text/plain', retentionClass: 'operational', metadata: {} };
  }

  async list() { return [...this.objects]; }
  async reconcileOrphans(references) { return { references, objects: [...this.objects] }; }
}
