import crypto from 'node:crypto';
import { canonicalJson } from './config.mjs';

const DEFAULT_FOUNDRY = '../../CT-Foundry/capabilities/observer/observer.mjs';
const DEFAULT_SCHEMA = '../../CT-Foundry/capabilities/observer/schema.mjs';
const SAFE_FAILURE_CLASSES = new Set(['ValidationError', 'SchemaError', 'TimeoutError', 'NetworkError', 'ProviderError', 'UnknownError']);
const SAFE_FAILURE_REASONS = new Set(['semantic-observation-rejected', 'provider-error', 'timeout', 'network-error', 'invalid-input', 'unknown']);
const hash = (value) => crypto.createHash('sha256').update(canonicalJson(value)).digest('hex');
const stamp = (value) => value?.toISOString?.() || value;
const immutableDigestValue = (value) => { const copy = structuredClone(value); delete copy.observedAt; return copy; };
const immutableDigestHash = (value) => hash(immutableDigestValue(value));
const safeId = (value, field = 'ID') => {
  if (typeof value !== 'string' || !value.trim() || value.length > 500 || /[\r\n\0]/.test(value)) throw new Error(`${field} must be a bounded safe string`);
  return value;
};

export class PostgresObserverStore {
  constructor(pool, artifactStore, foundry = {}) {
    if (!pool) throw new Error('Postgres pool is required');
    this.pool = pool;
    this.artifactStore = artifactStore;
    this.injectedFoundry = foundry;
  }

  async foundry() {
    if (this.injectedFoundry.joinedRecords && this.injectedFoundry.normalizeModelRuntimeTelemetry) return this.injectedFoundry;
    const observerSpecifier = process.env.CT_RUNTIME_OBSERVER_MODULE || DEFAULT_FOUNDRY;
    const schemaSpecifier = process.env.CT_RUNTIME_OBSERVER_SCHEMA_MODULE || (process.env.CT_RUNTIME_OBSERVER_MODULE ? observerSpecifier.replace(/observer\.mjs$/, 'schema.mjs') : DEFAULT_SCHEMA);
    if (!this.foundryPromise) this.foundryPromise = Promise.all([
      this.injectedFoundry.observer ? this.injectedFoundry.observer : import(observerSpecifier),
      this.injectedFoundry.schema ? this.injectedFoundry.schema : import(schemaSpecifier)
    ]).then(([observer, schema]) => ({ ...schema, ...observer, ...this.injectedFoundry }));
    return this.foundryPromise;
  }

  async transaction(operation) {
    const client = await this.pool.connect();
    try { await client.query('BEGIN'); const result = await operation(client); await client.query('COMMIT'); return result; }
    catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
    finally { client.release(); }
  }

  async init() { await this.pool.query('SELECT 1'); await this.foundry(); }
  async has(executionId) { return (await this.pool.query('SELECT 1 FROM observer_digests WHERE execution_id=$1', [safeId(executionId)])).rowCount > 0; }
  async getDigest(executionId, client = this.pool) { const result = await client.query('SELECT digest FROM observer_digests WHERE execution_id=$1', [safeId(executionId)]); if (!result.rows[0]) throw new Error('Observer digest not found'); return result.rows[0].digest; }
  async getSemantic(executionId, client = this.pool) { const result = await client.query('SELECT semantic FROM observer_semantic_sidecars WHERE execution_id=$1', [safeId(executionId)]); return result.rows[0]?.semantic; }

  async append(digest) {
    const executionId = safeId(digest?.execution?.id, 'digest execution ID');
    const provenanceHash = immutableDigestHash(digest);
    const { createSemanticObservationTask } = await this.foundry();
    const task = createSemanticObservationTask(digest);
    const result = await this.transaction(async (client) => {
      const execution = (await client.query('SELECT observer_state FROM runtime_executions WHERE execution_id=$1 FOR UPDATE', [executionId])).rows[0];
      if (!execution) throw new Error('runtime execution not found');
      const inserted = await client.query(`INSERT INTO observer_digests(execution_id,digest_schema,observer_version,digest,provenance_hash,recorded_at,lifecycle_state)
        VALUES ($1,$2,$3,$4,$5,clock_timestamp(),'semantic-analysis-pending') ON CONFLICT (execution_id) DO NOTHING RETURNING execution_id`,
      [executionId, digest.schema, digest.observerVersion, digest, provenanceHash]);
      const existingRow = inserted.rowCount ? { digest, provenance_hash: provenanceHash } : (await client.query('SELECT digest,provenance_hash FROM observer_digests WHERE execution_id=$1 FOR UPDATE', [executionId])).rows[0];
      const existing = existingRow.digest;
      if (existingRow.provenance_hash !== immutableDigestHash(existing) || existingRow.provenance_hash !== provenanceHash || canonicalJson(immutableDigestValue(existing)) !== canonicalJson(immutableDigestValue(digest))) throw new Error('immutable Observer digest conflict');
      const semantic = await this.getSemantic(executionId, client);
      const state = semantic ? 'observed' : 'semantic-analysis-pending';
      await client.query('UPDATE observer_digests SET lifecycle_state=$2 WHERE execution_id=$1', [executionId, state]);
      await client.query(`UPDATE runtime_executions SET observer_state=$2,
        observer_pending_at=COALESCE(observer_pending_at,clock_timestamp()),
        observer_observed_at=CASE WHEN $2='observed' THEN COALESCE(observer_observed_at,clock_timestamp()) ELSE observer_observed_at END,
        version=version+1 WHERE execution_id=$1`, [executionId, state === 'observed' ? 'observed' : 'pending']);
      if (inserted.rowCount && !semantic) await appendArtifact(client, { executionId, kind: 'semantic-task', key: executionId, content: task });
      if (inserted.rowCount) await appendLifecycle(client, executionId, execution.observer_state || 'not-eligible', 'semantic-analysis-pending', 'pending', { schema: 'celestan-observer-lifecycle-v1' });
      return { status: inserted.rowCount ? 'processed' : 'duplicate', executionId, task, state };
    });
    await this.mirrorArtifact('semantic-task', executionId, task);
    return result;
  }

  async appendSemantic(executionId, output) {
    safeId(executionId);
    const { validateSemanticObservation, telemetryReferenceIds } = await this.foundry();
    const digest = await this.getDigest(executionId);
    validateSemanticObservation(output, executionId, { allowedEvidenceReferences: digest.provenance?.references || [], allowedTelemetryReferences: telemetryReferenceIds(digest.modelRuntimeTelemetry) });
    const semanticHash = hash(output);
    const result = await this.transaction(async (client) => {
      const currentDigest = (await client.query('SELECT digest,lifecycle_state FROM observer_digests WHERE execution_id=$1 FOR UPDATE', [executionId])).rows[0];
      if (!currentDigest) throw new Error('Observer digest not found');
      await client.query('SELECT observer_state FROM runtime_executions WHERE execution_id=$1 FOR UPDATE', [executionId]);
      const inserted = await client.query(`INSERT INTO observer_semantic_sidecars(execution_id,semantic_schema,semantic,semantic_hash,recorded_at)
        VALUES ($1,$2,$3,$4,clock_timestamp()) ON CONFLICT (execution_id) DO NOTHING RETURNING execution_id`, [executionId, output.schema, output, semanticHash]);
      if (!inserted.rowCount) {
        const current = await this.getSemantic(executionId, client);
        if (canonicalJson(current) !== canonicalJson(output)) throw new Error('immutable Observer semantic conflict');
      }
      await client.query("UPDATE observer_digests SET lifecycle_state='observed' WHERE execution_id=$1", [executionId]);
      await client.query("UPDATE runtime_executions SET observer_state='observed',observer_pending_at=COALESCE(observer_pending_at,clock_timestamp()),observer_observed_at=COALESCE(observer_observed_at,clock_timestamp()),version=version+1 WHERE execution_id=$1", [executionId]);
      if (inserted.rowCount) await appendLifecycle(client, executionId, currentDigest.lifecycle_state || 'semantic-analysis-pending', 'observed', 'observed', { schema: 'celestan-observer-lifecycle-v1' });
      return { status: inserted.rowCount ? 'observed' : 'duplicate', executionId };
    });
    await this.mirrorArtifact('semantic-sidecar', executionId, output);
    return result;
  }

  async appendSemanticFailure(executionId, failure = {}, attempt = 1) {
    safeId(executionId);
    if (!Number.isInteger(attempt) || attempt < 1 || attempt > 100000) throw new Error('attempt must be a bounded positive integer');
    const value = { executionId, from: 'semantic-analysis-pending', to: 'semantic-analysis-pending', status: 'failed', attempt, errorClass: SAFE_FAILURE_CLASSES.has(failure.errorClass) ? failure.errorClass : 'UnknownError', reason: SAFE_FAILURE_REASONS.has(failure.reason) ? failure.reason : 'semantic-observation-rejected', retryable: Boolean(failure.retryable), at: new Date().toISOString() };
    await this.transaction(async (client) => {
      const digest = await client.query('SELECT execution_id FROM observer_digests WHERE execution_id=$1 FOR UPDATE', [executionId]);
      if (!digest.rowCount) throw new Error('Observer digest not found');
      await client.query('SELECT observer_state FROM runtime_executions WHERE execution_id=$1 FOR UPDATE', [executionId]);
      await appendLifecycle(client, executionId, value.from, value.to, value.status, value, attempt, value.errorClass, value.reason, value.retryable);
      await client.query("UPDATE observer_digests SET lifecycle_state='semantic-analysis-pending' WHERE execution_id=$1", [executionId]);
      await client.query("UPDATE runtime_executions SET observer_state='pending',observer_pending_at=COALESCE(observer_pending_at,clock_timestamp()),version=version+1 WHERE execution_id=$1", [executionId]);
    });
    return value;
  }

  async appendModelTelemetryEnvelope(executionId, envelope, { envelopeId = `model-${crypto.randomUUID()}`, sequence, allowedEvidenceReferences = [] } = {}) {
    safeId(executionId); safeId(envelopeId, 'envelope ID');
    if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) throw new Error('model telemetry envelope must be an object');
    if (!['sessions', 'invocations', 'failures', 'transitions'].some((field) => Array.isArray(envelope[field]) && envelope[field].length)) throw new Error('model telemetry envelope must contain authoritative records');
    const { normalizeModelRuntimeTelemetry } = await this.foundry();
    return this.transaction(async (client) => {
      const execution = await client.query('SELECT execution_id FROM runtime_executions WHERE execution_id=$1 FOR SHARE', [executionId]);
      if (!execution.rowCount) throw new Error('runtime execution not found');
      const rows = (await client.query('SELECT envelope_id,sequence,envelope FROM observer_model_telemetry_envelopes WHERE execution_id=$1 ORDER BY sequence,envelope_id FOR UPDATE', [executionId])).rows;
      const existing = rows.find((row) => row.envelope_id === envelopeId);
      if (existing) {
        if (canonicalJson(existing.envelope) !== canonicalJson(envelope) || sequence !== undefined && BigInt(existing.sequence) !== BigInt(sequence)) throw new Error('immutable model telemetry envelope conflict');
        return { status: 'duplicate', executionId, envelopeId, sequence: String(existing.sequence) };
      }
      const nextSequence = sequence === undefined ? (rows.length ? BigInt(rows.at(-1).sequence) + 1n : 1n) : BigInt(sequence);
      if (nextSequence < 1n) throw new Error('model telemetry sequence must be positive');
      const combined = combineModelEnvelopes([...rows.map((row) => row.envelope), envelope]);
      normalizeModelRuntimeTelemetry(combined, {}, allowedEvidenceReferences);
      await client.query('INSERT INTO observer_model_telemetry_envelopes(envelope_id,execution_id,sequence,envelope,recorded_at) VALUES ($1,$2,$3,$4,clock_timestamp())', [envelopeId, executionId, String(nextSequence), envelope]);
      return { status: 'processed', executionId, envelopeId, sequence: String(nextSequence) };
    });
  }

  async modelTelemetryFor(executionId) {
    const rows = (await this.pool.query('SELECT envelope FROM observer_model_telemetry_envelopes WHERE execution_id=$1 ORDER BY sequence,envelope_id', [safeId(executionId)])).rows;
    return rows.length ? combineModelEnvelopes(rows.map((row) => row.envelope)) : undefined;
  }

  async lineageFor(workOrderId) {
    safeId(workOrderId, 'work order ID');
    const result = await this.pool.query(`SELECT occurred_at AS at,event_id AS id,execution_id,event_type AS type,payload
      FROM federation_events WHERE work_order_id=$1
      UNION ALL SELECT created_at AS at,execution_id AS id,execution_id,'physical-execution' AS type,
      jsonb_build_object('provider',provider,'mode',mode,'state',state,'lineage',lineage) AS payload
      FROM federation_executions WHERE work_order_id=$1 ORDER BY at,id`, [workOrderId]);
    return result.rows.map((item) => ({ id: item.id, at: stamp(item.at), executionId: item.execution_id, type: item.type, payload: item.type === 'physical-execution' ? boundedPhysicalExecution(item.payload) : boundedFederationEvent(item.payload) }));
  }
  async appendPolicyDecision(decision) { return this.appendStoredArtifact('policy-decision', `${decision.candidateKey}:${decision.decidedAt}`, decision); }
  async appendCoverageSnapshot(report) { return this.appendStoredArtifact('coverage-snapshot', report.checkedAt, report); }
  async appendChronicleArtifact(entry, markdown) { return this.appendStoredArtifact('chronicle', `${entry.period.start}:${entry.period.end}`, entry, markdown); }
  async appendStoredArtifact(kind, key, content, markdown) {
    const result = await this.transaction((client) => appendArtifact(client, { kind, key, content, markdown }));
    await this.mirrorArtifact(kind, key, content, markdown);
    return result.status === 'duplicate' ? content : content;
  }

  async mirrorArtifact(kind, key, content, markdown) {
    if (typeof this.artifactStore?.putArtifact !== 'function') return;
    await this.artifactStore.putArtifact({ kind, key, content, markdown });
  }

  async all() {
    const result = await this.pool.query('SELECT digest FROM observer_digests');
    return result.rows.map((item) => item.digest).sort((a, b) => compareCodePoints(a.execution.id, b.execution.id));
  }
  async list() { return this.all(); }
  async joined() { const { joinedRecords } = await this.foundry(); return joinedRecords(this); }
  async export() { return canonicalJson(await this.joined()) + '\n'; }
}

function combineModelEnvelopes(envelopes) {
  return Object.fromEntries(['sessions', 'invocations', 'failures', 'transitions'].map((field) => [field, envelopes.flatMap((envelope) => envelope[field] || [])]).filter(([, records]) => records.length));
}

async function appendLifecycle(client, executionId, from, to, status, payload, attempt = null, errorClass = null, reason = null, retryable = null) {
  await client.query(`INSERT INTO observer_lifecycle(lifecycle_id,execution_id,from_state,to_state,status,attempt,error_class,reason,retryable,occurred_at,payload)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,clock_timestamp(),$10)`, [`life-${crypto.randomUUID()}`, executionId, from, to, status, attempt, errorClass, reason, retryable, payload]);
}

async function appendArtifact(client, { executionId = null, kind, key, content, markdown = null }) {
  safeId(kind, 'artifact kind'); safeId(key, 'artifact key');
  const contentHash = hash({ content, markdown });
  const inserted = await client.query(`INSERT INTO observer_artifacts(artifact_id,execution_id,artifact_kind,artifact_key,content,markdown,content_hash,recorded_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,clock_timestamp()) ON CONFLICT (artifact_kind,artifact_key) DO NOTHING RETURNING artifact_id`, [`artifact-${crypto.randomUUID()}`, executionId, kind, key, content, markdown, contentHash]);
  if (!inserted.rowCount) {
    const existing = (await client.query('SELECT content,markdown FROM observer_artifacts WHERE artifact_kind=$1 AND artifact_key=$2', [kind, key])).rows[0];
    if (hash({ content: existing.content, markdown: existing.markdown }) !== contentHash) throw new Error(`immutable Observer ${kind} artifact conflict`);
  }
  return { status: inserted.rowCount ? 'processed' : 'duplicate', kind, key };
}

function compareCodePoints(left, right) {
  const a = Array.from(String(left)), b = Array.from(String(right));
  for (let index = 0; index < Math.min(a.length, b.length); index++) { const difference = a[index].codePointAt(0) - b[index].codePointAt(0); if (difference) return difference; }
  return a.length - b.length;
}

const FEDERATION_EVENT_FIELDS = new Set(['state', 'status', 'fence', 'mode', 'digest', 'checkpointDigest', 'advisory', 'instanceId', 'handoffId', 'takeoverId', 'fromExecutionId', 'continuationId', 'repositoryDigest']);
function boundedFederationEvent(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return {};
  return Object.fromEntries(Object.entries(payload).filter(([key, value]) => FEDERATION_EVENT_FIELDS.has(key) && (value === null || ['number', 'boolean'].includes(typeof value) || typeof value === 'string' && value.length <= 500 && !/[\0\r\n]/.test(value))));
}

const LINEAGE_FIELDS = new Set(['schema', 'workOrderId', 'executionId', 'parentExecutionId', 'provider', 'mode', 'handoffId', 'continuationId', 'checkpointDigest', 'repositoryDigest', 'nextOperation']);
const GAS_LINEAGE_FIELDS = new Set(['physicalExecutionId', 'continuationId', 'checkpointDigest', 'sourceCheckpointDigest', 'canonicalCheckpointDigest', 'reconstructedAt']);
function boundedPhysicalExecution(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return {};
  const scalar = (value, max = 500) => value === null || ['number', 'boolean'].includes(typeof value) || typeof value === 'string' && value.length <= max && !/[\0\r\n]/.test(value);
  const lineage = payload.lineage && typeof payload.lineage === 'object' ? Object.fromEntries(Object.entries(payload.lineage).filter(([key, value]) => LINEAGE_FIELDS.has(key) && scalar(value, key === 'nextOperation' ? 160 : 500))) : {};
  const gas = payload.lineage?.gas;
  if (gas && typeof gas === 'object' && !Array.isArray(gas)) {
    lineage.gas = Object.fromEntries(Object.entries(gas).filter(([key, value]) => GAS_LINEAGE_FIELDS.has(key) && scalar(value)));
    if (Array.isArray(gas.evidence)) lineage.gas.evidence = gas.evidence.slice(0, 20).map((reference) => Object.fromEntries(Object.entries(reference || {}).filter(([key, value]) => ['drive_file_id', 'sha256', 'schema'].includes(key) && scalar(value))));
  }
  return { provider: scalar(payload.provider, 160) ? payload.provider : 'unavailable', mode: payload.mode === 'foreground' ? 'foreground' : 'background', state: scalar(payload.state, 80) ? payload.state : 'unknown', lineage };
}
