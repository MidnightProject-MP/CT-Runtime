import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { HeadObjectCommand } from '@aws-sdk/client-s3';
import { runtimeMetadata } from './config.mjs';

const migrationDirectory = fileURLToPath(new URL('../migrations/', import.meta.url));
const terminalStates = new Set(['success', 'failed', 'cancelled', 'crashed']);

export async function reconstruct({ store, config, evidenceStore, deploymentId, workdir = path.join(os.tmpdir(), 'ct-runtime', 'workspace') } = {}) {
  if (!store || config?.mode !== 'production') throw new Error('reconstruction requires production mode');
  evidenceStore ||= store.evidenceStore;
  deploymentId ||= config.deploymentId;
  await store.init();
  await validateMigrations(store.pool);
  if (typeof evidenceStore?.reachable !== 'function') throw new Error('S3 evidence store is unavailable');
  await evidenceStore.reachable();
  if (!config.imageDigest || !config.configDigest) throw new Error('deployment provenance is incomplete');
  const relativeWorkdir = path.relative(path.resolve(os.tmpdir()), path.resolve(workdir));
  if (relativeWorkdir.startsWith('..') || path.isAbsolute(relativeWorkdir)) throw new Error('reconstruction workspace must be ephemeral');
  const evidence = await validateCanonicalState(store.pool, evidenceStore);
  if (typeof store.registerDeployment !== 'function') throw new Error('deployment registration is unavailable');
  await store.registerDeployment({ deploymentId, provider: config.provider, runtimeClass: config.runtimeClass, region: config.region, architecture: process.arch, imageDigest: config.imageDigest, configDigest: config.configDigest, gitRepository: config.gitRepository, gitCommit: config.gitCommit });
  await rm(workdir, { recursive: true, force: true });
  await mkdir(workdir, { recursive: true });
  const entries = await readdir(workdir).catch(() => []);
  return { status: 'reconstructed', deploymentId, schema: 'current', evidenceReferences: evidence, metadata: runtimeMetadata(config, { instanceId: `${os.hostname()}-${process.pid}` }), workdir, clean: entries.length === 0 };
}

export async function doctor({ store, config, evidenceStore } = {}) {
  const result = { mode: config?.mode, database: 'unavailable', evidence: 'not-configured', schema: 'unknown', errors: [] };
  try { await store.init(); result.database = 'reachable'; const versions = await validateMigrations(store.pool); result.schema = versions.join(','); } catch (error) { result.errors.push(error.message.slice(0, 200)); }
  evidenceStore ||= store?.evidenceStore;
  try { if (typeof evidenceStore?.reachable === 'function') { await evidenceStore.reachable(); result.evidence = 'reachable'; } else if (config?.mode === 'production') result.errors.push('S3 evidence store is unavailable'); } catch (error) { result.errors.push(`evidence: ${error.message.slice(0, 160)}`); }
  if (config?.mode === 'production' && !config.s3?.bucket) result.errors.push('S3 bucket is required');
  result.healthy = result.errors.length === 0;
  if (!result.healthy) throw new Error(JSON.stringify(result));
  return result;
}

async function expectedMigrations() {
  const files = (await readdir(migrationDirectory)).filter((file) => /^\d+_.*\.sql$/.test(file)).sort();
  return Promise.all(files.map(async (file) => ({
    version: Number(file.match(/^\d+/)[0]),
    checksum: createHash('sha256').update(await readFile(path.join(migrationDirectory, file), 'utf8')).digest('hex')
  })));
}

async function validateMigrations(pool) {
  if (!pool?.query) throw new Error('PostgreSQL query interface is unavailable');
  const expected = await expectedMigrations();
  const actual = (await pool.query('SELECT version,checksum FROM runtime_schema_migrations ORDER BY version')).rows;
  if (actual.length !== expected.length || expected.some((item, index) => Number(actual[index]?.version) !== item.version || actual[index]?.checksum !== item.checksum)) throw new Error('database migration versions or checksums do not match this image');
  return expected.map((item) => item.version);
}

async function validateCanonicalState(pool, evidenceStore) {
  const executions = (await pool.query('SELECT execution_id,root_execution_id,parent_execution_id,status,topology,observer_state,observer_pending_at,observer_observed_at FROM runtime_executions ORDER BY execution_id')).rows;
  const byId = new Map(executions.map((item) => [item.execution_id, item]));
  for (const execution of executions) validateTopology(execution, executions, byId);

  const invalidLease = await pool.query(`SELECT l.execution_id FROM runtime_leases l JOIN runtime_executions e USING (execution_id) WHERE (l.released_at IS NULL AND l.expires_at>clock_timestamp() AND e.status = ANY($1)) OR l.fence<1 OR l.revision<1 OR l.expires_at<l.acquired_at OR (l.released_at IS NOT NULL AND l.released_at<l.acquired_at) LIMIT 1`, [[...terminalStates]]);
  if (invalidLease.rowCount) throw new Error(`impossible active lease state: ${invalidLease.rows[0].execution_id}`);
  const invalidSchedule = await pool.query(`SELECT schedule_key FROM runtime_schedules WHERE state NOT IN ('pending','claimed','completed','failed') OR (state='pending' AND (claim_owner IS NOT NULL OR claim_fence IS NOT NULL OR claimed_at IS NOT NULL OR finished_at IS NOT NULL)) OR (state='claimed' AND (claim_owner IS NULL OR claim_fence IS NULL OR claimed_at IS NULL OR finished_at IS NOT NULL)) OR (state IN ('completed','failed') AND finished_at IS NULL) LIMIT 1`);
  if (invalidSchedule.rowCount) throw new Error(`impossible schedule state: ${invalidSchedule.rows[0].schedule_key}`);
  const invalidObserver = await pool.query(`SELECT e.execution_id FROM runtime_executions e LEFT JOIN observer_digests d USING (execution_id) LEFT JOIN observer_semantic_sidecars s USING (execution_id) WHERE e.observer_state NOT IN ('not-eligible','pending','observed') OR (e.observer_state='observed' AND (d.execution_id IS NULL OR s.execution_id IS NULL OR e.observer_observed_at IS NULL)) OR (e.observer_state='pending' AND e.observer_pending_at IS NULL) LIMIT 1`);
  if (invalidObserver.rowCount) throw new Error(`impossible Observer state: ${invalidObserver.rows[0].execution_id}`);

  const references = (await pool.query('SELECT execution_id,object_key,object_uri,sha256,byte_count FROM runtime_evidence ORDER BY object_key')).rows;
  const urisByExecution = new Map();
  for (const reference of references) {
    const expectedUri = `s3://${evidenceStore.bucket}/${reference.object_key}`;
    if (reference.object_uri !== expectedUri) throw new Error(`inconsistent evidence URI: ${reference.object_key}`);
    const head = await evidenceStore.client.send(new HeadObjectCommand({ Bucket: evidenceStore.bucket, Key: reference.object_key }));
    if (Number(head.ContentLength) !== Number(reference.byte_count) || head.Metadata?.sha256 !== reference.sha256) throw new Error(`inconsistent evidence object: ${reference.object_key}`);
    const values = urisByExecution.get(reference.execution_id) || new Set();
    values.add(reference.object_uri);
    urisByExecution.set(reference.execution_id, values);
  }
  const digests = (await pool.query('SELECT execution_id,digest FROM observer_digests ORDER BY execution_id')).rows;
  for (const row of digests) {
    const allowed = urisByExecution.get(row.execution_id) || new Set();
    for (const reference of row.digest?.provenance?.references || []) if (!allowed.has(reference)) throw new Error(`Observer evidence reference is inconsistent: ${row.execution_id}`);
  }
  return references.length;
}

function validateTopology(execution, executions, byId) {
  const root = byId.get(execution.root_execution_id);
  const parent = execution.parent_execution_id ? byId.get(execution.parent_execution_id) : null;
  if (!root || root.parent_execution_id || root.root_execution_id !== root.execution_id) throw new Error(`impossible topology root: ${execution.execution_id}`);
  if (execution.parent_execution_id && (!parent || parent.root_execution_id !== execution.root_execution_id)) throw new Error(`impossible topology parent: ${execution.execution_id}`);
  const children = executions.filter((item) => item.parent_execution_id === execution.execution_id).map((item) => item.execution_id).sort();
  const recorded = [...(execution.topology?.childIds || [])].sort();
  if (execution.topology?.rootId !== execution.root_execution_id || (execution.topology?.parentId || null) !== (execution.parent_execution_id || null) || JSON.stringify(children) !== JSON.stringify(recorded)) throw new Error(`inconsistent topology projection: ${execution.execution_id}`);
  const seen = new Set([execution.execution_id]);
  let cursor = execution.parent_execution_id;
  while (cursor) {
    if (seen.has(cursor)) throw new Error(`topology cycle: ${execution.execution_id}`);
    seen.add(cursor);
    cursor = byId.get(cursor)?.parent_execution_id;
  }
}
