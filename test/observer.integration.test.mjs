import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Pool } from 'pg';
import { migrate } from '../lib/migration.mjs';
import { PostgresObserverStore } from '../lib/observer-store.mjs';
import { PostgresStore } from '../lib/postgres-store.mjs';
import { exportObserver, observePostgres } from '../lib/production-observer.mjs';
import { invoke } from '../lib/runtime.mjs';

const connectionString = process.env.TEST_DATABASE_URL;
const foundryPath = path.join(import.meta.dirname, '..', '..', 'CT-Foundry', 'capabilities', 'observer', 'observer.mjs');
const schemaPath = path.join(path.dirname(foundryPath), 'schema.mjs');
const fixture = path.join(import.meta.dirname, 'fixture-runner.mjs');

test('Postgres Observer production contract is transactional and storage-neutral', { skip: !connectionString || !existsSync(foundryPath) || !existsSync(schemaPath), timeout: 60000 }, async () => {
  const [foundry, schemaModule] = await Promise.all([import(foundryPath), import(schemaPath)]);
  assert.equal(schemaModule.OBSERVER_VERSION, '1.2.0');
  const schema = `ct_observer_test_${crypto.randomBytes(8).toString('hex')}`;
  const admin = new Pool({ connectionString, max: 2 });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({ connectionString, max: 5, options: `-c search_path=${schema}` });
  const artifactSink = new ArtifactSink();
  const evidenceStore = new EvidenceStore();
  const store = new PostgresStore({ pool, config: { runtimeVersion: 'test' }, evidenceStore });
  const observerStore = new PostgresObserverStore(pool, artifactSink, { ...foundry, ...schemaModule });
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'ct-observer-integration-'));
  try {
    await migrate({ pool, directory: path.join(import.meta.dirname, '..', 'migrations') });
    await store.createManifest({ executionId: 'observer-e2e', project: 'observer-integration', task: 'verify observer', model: 'provider/model', agent: 'build' });
    assert.equal((await invoke({ store, executionId: 'observer-e2e', command: process.execPath, commandArgs: [fixture], model: 'provider/model', agent: 'build', task: 'verify observer', maxRetries: 0 })).status, 'success');

    await observerStore.appendModelTelemetryEnvelope('observer-e2e', { sessions: [{ sessionId: 'session-1', provider: 'provider', model: 'model', status: 'success' }], invocations: [{ invocationId: 'invocation-1', sessionId: 'session-1', provider: 'provider', model: 'model', status: 'success' }] }, { envelopeId: 'envelope-1', sequence: '9007199254740993' });
    await observerStore.appendModelTelemetryEnvelope('observer-e2e', { transitions: [{ transitionId: 'transition-1', facets: ['retry'], fromInvocationId: 'invocation-1', toInvocationId: 'invocation-1', retryCount: 1, outcome: 'success' }] }, { envelopeId: 'envelope-2', sequence: '9007199254740994' });
    assert.equal((await observerStore.appendModelTelemetryEnvelope('observer-e2e', { transitions: [{ transitionId: 'transition-1', facets: ['retry'], fromInvocationId: 'invocation-1', toInvocationId: 'invocation-1', retryCount: 1, outcome: 'success' }] }, { envelopeId: 'envelope-2', sequence: '9007199254740994' })).status, 'duplicate');

    const pending = await observePostgres({ store, observerStore });
    assert.deepEqual(pending, [{ executionId: 'observer-e2e', status: 'semantic-analysis-pending' }]);
    assert.equal((await store.manifest('observer-e2e')).observer.state, 'pending');
    assert.equal((await pool.query("SELECT count(*) FROM observer_artifacts WHERE artifact_kind='semantic-task' AND execution_id='observer-e2e'")).rows[0].count, '1');
    assert.deepEqual((await observerStore.getDigest('observer-e2e')).modelRuntimeTelemetry.transitions.map((item) => item.id), ['transition-1']);
    assert.deepEqual((await observerStore.getDigest('observer-e2e')).hostRuntimeTelemetry.records.map((item) => item.sampleType), ['startup', 'execution', 'termination']);

    const semantic = { schema: schemaModule.SEMANTIC_SCHEMA, executionId: 'observer-e2e', status: 'complete', summary: 'Observer integration completed with cited runtime evidence.', confidence: 0.9, signals: [] };
    const semanticFile = path.join(temporary, 'semantic.json');
    await writeFile(semanticFile, JSON.stringify(semantic));
    let observed;
    try { observed = await observePostgres({ store, observerStore, semanticResultFile: semanticFile }); } catch (error) { console.error('observePostgres threw', error.stack || error.message); throw error; }
    if (observed[0]?.status !== 'observed') { console.error('observed failure', JSON.stringify(observed, null, 2)); let extra = ''; try { extra = JSON.stringify(await observerStore.getDigest('observer-e2e'), null, 2); } catch {} console.error('digest', extra.slice(0, 4000)); }
    assert.deepEqual(observed, [{ executionId: 'observer-e2e', status: 'observed' }]);
    assert.equal((await store.manifest('observer-e2e')).observer.state, 'observed');

    const digest = await observerStore.getDigest('observer-e2e');
    await assert.rejects(() => observerStore.append({ ...digest, execution: { ...digest.execution, project: 'conflict' } }), /digest conflict/);
    await assert.rejects(() => observerStore.appendSemantic('observer-e2e', { ...semantic, summary: 'conflict' }), /semantic conflict/);
    await pool.query("UPDATE observer_digests SET lifecycle_state='semantic-analysis-pending' WHERE execution_id='observer-e2e'");
    await pool.query("UPDATE runtime_executions SET observer_state='pending',observer_observed_at=NULL WHERE execution_id='observer-e2e'");
    assert.equal((await observerStore.append(digest)).status, 'duplicate');
    assert.equal((await store.manifest('observer-e2e')).observer.state, 'observed');

    const decision = foundry.createPolicyDecision({ key: 'observer-hook', evidence: ['observer-e2e'] }, 'defer', 'foundry');
    await foundry.appendPolicyDecision(observerStore, decision);
    await foundry.appendCoverageSnapshot(observerStore, { manifest: [{ executionId: 'observer-e2e' }], records: await foundry.joinedRecords(observerStore) });
    await foundry.appendChronicle(observerStore, { start: '2020-01-01', end: '2030-01-01' }, path.join(temporary, 'chronicle.json'));
    const artifactKinds = (await pool.query('SELECT artifact_kind FROM observer_artifacts ORDER BY artifact_kind')).rows.map((item) => item.artifact_kind);
    assert.deepEqual(artifactKinds, ['chronicle', 'coverage-snapshot', 'policy-decision', 'semantic-task']);
    assert.equal(artifactSink.values.some((item) => item.kind === 'chronicle' && item.markdown.includes('# Observer Chronicle')), true);

    const exported = JSON.parse(await exportObserver(observerStore));
    assert.equal(exported[0].lifecycle.state, 'observed');
    assert.equal(exported[0].summary, semantic.summary);
    assert.equal(exported[0].modelRuntimeTelemetry.invocations.length, 1);
    assert.equal('aggregate' in (await store.modelTelemetryFor('observer-e2e'))[0], true);
  } finally {
    await rm(temporary, { recursive: true, force: true });
    await pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
});

class ArtifactSink { values = []; async putArtifact(value) { this.values.push(value); return value; } }
class EvidenceStore {
  async put({ project, executionId, attempt, label, content }) { const body = Buffer.from(String(content)), hash = crypto.createHash('sha256').update(body).digest('hex'), objectKey = `${project}/${executionId}/${attempt}/${label}-${hash}`; return { evidenceId: `${label}-${hash}`, objectKey, objectUri: `memory://${objectKey}`, sha256: hash, bytes: body.length, truncated: false, contentType: 'text/plain', retentionClass: 'operational', metadata: {} }; }
}
