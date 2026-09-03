import crypto from 'node:crypto';
import { canonicalJson, sha256 } from './config.mjs';

export const FEDERATION_SCHEMA = 'celestan-execution-federation-v1';
export const FEDERATION_STATES = Object.freeze(['ready', 'claimed', 'running', 'deferred', 'handoff', 'finalized', 'failed']);
export const CoordinationUnavailableError = class extends Error {
  constructor(message = 'execution coordination is unavailable') { super(message); this.name = 'CoordinationUnavailableError'; this.category = 'coordination-unavailable'; }
};
const conflict = (message) => Object.assign(new Error(message), { category: 'conflict' });
const required = (value, field, max = 500) => { if (typeof value !== 'string' || !value.trim() || value.length > max || /[\0\r\n]/.test(value)) throw new Error(`${field} must be a bounded safe string`); return value; };
const isSecretKey = (key) => /(?:apikey|token|secret|password|passwd|credential|authorization|privatekey|accesskey)/i.test(String(key).replace(/[_-]/g, ''));
const json = (value) => value == null ? null : JSON.parse(JSON.stringify(value));
const id = (prefix) => `${prefix}-${crypto.randomUUID()}`;
const row = (result) => result.rows[0];
const stamp = (v) => v?.toISOString?.() || v;
const MIN_FEDERATION_TTL_MS = 1000;
const MAX_FEDERATION_TTL_MS = 3600000;
const MAX_FEDERATION_CHECKPOINT_BYTES = 64 * 1024;

export function normalizeObserverLineage(input = {}) {
  const checkpointDigest = input.checkpointDigest || (input.checkpoint == null ? null : sha256(input.checkpoint));
  if (checkpointDigest !== null && !/^[a-f0-9]{64}$/.test(checkpointDigest)) throw new Error('checkpointDigest must be a SHA-256 digest');
  if (input.repositoryDigest != null && !/^[a-f0-9]{64}$/.test(input.repositoryDigest)) throw new Error('repositoryDigest must be a SHA-256 digest');
  return { schema: 'celestan-observer-lineage-v1', workOrderId: required(input.workOrderId, 'workOrderId'), executionId: required(input.executionId, 'executionId'), parentExecutionId: input.parentExecutionId ? required(input.parentExecutionId, 'parentExecutionId') : null, provider: required(input.provider || 'unavailable', 'provider', 160), mode: input.mode === 'foreground' ? 'foreground' : 'background', handoffId: input.handoffId ? required(input.handoffId, 'handoffId') : null, continuationId: input.continuationId ? required(input.continuationId, 'continuationId') : null, checkpointDigest, repositoryDigest: input.repositoryDigest || null, nextOperation: input.nextOperation ? required(input.nextOperation, 'nextOperation', 160) : null };
}
export function redactFederation(value, secrets = []) {
  const replacements = secrets.filter((s) => typeof s === 'string' && s.length >= 4);
  const walk = (v) => typeof v === 'string' ? replacements.reduce((out, secret) => out.split(secret).join('[REDACTED]'), v) : Array.isArray(v) ? v.map(walk) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, isSecretKey(k) ? '[REDACTED]' : walk(x)])) : v;
  return walk(json(value));
}

export function assertCoordination(adapter) {
  if (!adapter || adapter.available === false) throw new CoordinationUnavailableError();
  for (const method of ['createWorkOrder', 'claim', 'checkpoint', 'finalize', 'reconstruct', 'discoverResumableWork', 'takeoverResumableWork']) if (typeof adapter[method] !== 'function') throw new Error(`federation adapter missing ${method}`);
  return adapter;
}

export class PostgresFederationAdapter {
  constructor({ pool, now = () => new Date() } = {}) { if (!pool) throw new Error('Postgres pool is required'); this.pool = pool; this.now = now; this.available = true; }
  async tx(fn) { const client = await this.pool.connect(); try { await client.query('BEGIN'); const out = await fn(client); await client.query('COMMIT'); return out; } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; } finally { client.release(); } }
  async createWorkOrder({ workOrderId, project, intent, repository = {} }) {
    workOrderId = required(workOrderId || id('work'), 'workOrderId'); project = required(project, 'project');
    intent = redactFederation(intent); repository = redactFederation(repository);
    return this.tx(async (c) => { const inserted = await c.query(`INSERT INTO federation_work_orders(work_order_id,project,intent,repository) VALUES ($1,$2,$3,$4) ON CONFLICT (work_order_id) DO NOTHING RETURNING *`, [workOrderId, project, intent, repository]); const current = row(inserted) || row(await c.query('SELECT * FROM federation_work_orders WHERE work_order_id=$1 FOR SHARE', [workOrderId])); if (canonicalJson({ project: current.project, intent: current.intent, repository: current.repository }) !== canonicalJson({ project, intent, repository })) throw conflict('work order identity'); return fromWork(current); });
  }
  async getWorkOrder(workOrderId) { const value = row(await this.pool.query('SELECT * FROM federation_work_orders WHERE work_order_id=$1', [required(workOrderId, 'workOrderId')])); return value && fromWork(value); }
  async claim({ workOrderId, executionId = id('exec'), provider, mode = 'background', owner = id('owner'), ttlMs = 300000, repository = {}, parentExecutionId = null }) {
    required(workOrderId, 'workOrderId'); required(provider, 'provider'); required(owner, 'owner'); if (!['foreground', 'background'].includes(mode)) throw new Error('execution mode is invalid'); ttlMs = boundedFederationTtl(ttlMs);
    return this.tx(async (c) => this.claimInTransaction(c, workOrderId, { executionId, provider, mode, owner, ttlMs, repository, parentExecutionId, emitEvent: true }));
  }
  async renew(executionId, claim, ttlMs = 300000) { ttlMs = boundedFederationTtl(ttlMs); return this.tx(async (c) => { const current = await lockClaim(c, executionId, claim); const updated = row(await c.query(`UPDATE federation_executions SET lease_until=clock_timestamp()+($1::bigint * interval '1 millisecond'),updated_at=clock_timestamp() WHERE execution_id=$2 RETURNING *`, [ttlMs, executionId])); return fromExecution(updated); }); }
  async release(executionId, claim) { return this.tx(async (c) => { const current = await lockClaim(c, executionId, claim); const updated = row(await c.query(`UPDATE federation_executions SET state=CASE WHEN state IN ('claimed','running') THEN 'deferred' ELSE state END,lease_until=NULL,updated_at=clock_timestamp() WHERE execution_id=$1 RETURNING *`, [executionId])); await event(c, current.work_order_id, executionId, 'released', {}); return fromExecution(updated); }); }
  async defer(executionId, claim) { return this.release(executionId, claim); }
  async checkpoint(executionId, checkpoint, claim) { const safeCheckpoint = boundedFederationCheckpoint(redactFederation(checkpoint)); return this.tx(async (c) => { const current = await lockClaim(c, executionId, claim); const updated = row(await c.query(`UPDATE federation_executions SET state='running',checkpoint=$1,updated_at=clock_timestamp() WHERE execution_id=$2 RETURNING *`, [safeCheckpoint, executionId])); await event(c, current.work_order_id, executionId, 'checkpointed', { digest: sha256(safeCheckpoint) }); return fromExecution(updated); }); }
  async handoff(executionId, { provider, mode = 'background', owner = id('owner'), ttlMs = 300000, reason = 'continuation', handoffId = id('handoff') } = {}, claim) { required(handoffId, 'handoffId'); required(provider, 'provider'); required(reason, 'reason'); required(owner, 'owner'); if (!['foreground', 'background'].includes(mode)) throw new Error('execution mode is invalid'); ttlMs = boundedFederationTtl(ttlMs); return this.tx(async (c) => { await c.query('SELECT * FROM federation_work_orders WHERE work_order_id=(SELECT work_order_id FROM federation_executions WHERE execution_id=$1) FOR UPDATE', [executionId]); const prior = row(await c.query('SELECT * FROM federation_handoffs WHERE handoff_id=$1 AND from_execution_id=$2', [handoffId, executionId])); if (prior) { const next = row(await c.query('SELECT * FROM federation_executions WHERE execution_id=$1', [prior.to_execution_id])); if (!next) throw new Error('handoff target not found'); if (next.provider !== provider || next.mode !== mode || next.claim_owner !== owner || prior.reason !== reason) throw conflict('handoff idempotency identity'); return fromExecution(next); } const current = await lockClaim(c, executionId, claim); await c.query(`UPDATE federation_executions SET state='handoff',lease_until=NULL,updated_at=clock_timestamp() WHERE execution_id=$1`, [executionId]); const next = await this.claimInTransaction(c, current.work_order_id, { provider, mode, owner, ttlMs, repository: current.repository, parentExecutionId: executionId }); await c.query(`INSERT INTO federation_handoffs(handoff_id,work_order_id,from_execution_id,to_execution_id,checkpoint,reason) VALUES ($1,$2,$3,$4,$5,$6)`, [handoffId, current.work_order_id, executionId, next.id, current.checkpoint == null ? null : boundedFederationCheckpoint(redactFederation(current.checkpoint)), redactFederation(reason)]); return next; }); }
  async continue(executionId, options, claim) { return this.handoff(executionId, options, claim); }
  async finalize(executionId, value, claim) { if (!value || !['success', 'failed'].includes(value.status)) throw new Error('finalize status must be success or failed'); return this.tx(async (c) => { const current = await lockClaim(c, executionId, claim); const checkpoint = redactFederation(value.checkpoint ?? current.checkpoint, value.secrets || []); const safeCheckpoint = checkpoint == null ? null : boundedFederationCheckpoint(checkpoint); const state = value.status === 'failed' ? 'failed' : 'finalized'; const updated = row(await c.query(`UPDATE federation_executions SET state=$1,checkpoint=$2,lease_until=NULL,updated_at=clock_timestamp() WHERE execution_id=$3 RETURNING *`, [state, safeCheckpoint, executionId])); await c.query(`UPDATE federation_work_orders SET state=$1,updated_at=clock_timestamp() WHERE work_order_id=$2`, [value.status === 'failed' ? 'failed' : 'completed', current.work_order_id]); await event(c, current.work_order_id, executionId, 'finalized', redactFederation(value, value.secrets || [])); return fromExecution(updated); }); }
  async reconstruct(workOrderId) { const order = row(await this.pool.query('SELECT * FROM federation_work_orders WHERE work_order_id=$1', [workOrderId])); if (!order) return null; const executions = (await this.pool.query('SELECT * FROM federation_executions WHERE work_order_id=$1 ORDER BY created_at,execution_id', [workOrderId])).rows.map(fromExecution); const handoffs = (await this.pool.query('SELECT * FROM federation_handoffs WHERE work_order_id=$1 ORDER BY created_at,handoff_id', [workOrderId])).rows.map((x) => ({ id: x.handoff_id, fromExecutionId: x.from_execution_id, toExecutionId: x.to_execution_id, checkpoint: x.checkpoint, reason: x.reason, createdAt: stamp(x.created_at) })); return { schema: FEDERATION_SCHEMA, workOrder: fromWork(order), executions, handoffs }; }
  async repositoryDrift(workOrderId, repository) { const order = await this.getWorkOrder(workOrderId); if (!order) throw new Error('work order not found'); return { drifted: canonicalJson(order.repository) !== canonicalJson(repository), expected: order.repository, actual: repository }; }
  async discoverResumableWork({ workOrderId, project }) {
    workOrderId = required(workOrderId, 'workOrderId'); project = required(project, 'project');
    const order = row(await this.pool.query('SELECT * FROM federation_work_orders WHERE work_order_id=$1 AND project=$2', [workOrderId, project]));
    if (!order) return { status: 'missing', eligible: false, workOrderId, project };
    const active = row(await this.pool.query(`SELECT execution_id FROM federation_executions WHERE work_order_id=$1
      AND state IN ('claimed','running') AND lease_until>clock_timestamp() ORDER BY created_at DESC,execution_id DESC LIMIT 1`, [workOrderId]));
    const latest = row(await this.pool.query(`SELECT *,pg_catalog.encode(public.digest(pg_catalog.convert_to(checkpoint::text,'UTF8'),'sha256'),'hex') AS current_checkpoint_digest
      FROM federation_executions WHERE work_order_id=$1 ORDER BY claim_fence DESC NULLS LAST,created_at DESC,execution_id DESC LIMIT 1`, [workOrderId]));
    const digest = latest && row(await this.pool.query(`SELECT payload->>'checkpointDigest' AS checkpoint_digest FROM federation_events
      WHERE work_order_id=$1 AND execution_id=$2 AND event_type='gas-checkpointed' ORDER BY occurred_at DESC,event_id DESC LIMIT 1`, [workOrderId, latest.execution_id]));
    return continuationProjection(order, latest ? { ...latest, recorded_checkpoint_digest: digest?.checkpoint_digest } : null, Boolean(active));
  }
  async takeoverResumableWork({ workOrderId, project, takeoverId, executionId, owner, provider = 'opencode-local', ttlMs = 300000, repository = {}, expectedContinuationId, expectedFence }) {
    workOrderId = required(workOrderId, 'workOrderId'); project = required(project, 'project'); takeoverId = required(takeoverId, 'takeoverId');
    executionId = required(executionId, 'executionId'); owner = required(owner, 'owner'); provider = required(provider, 'provider', 160);
    expectedContinuationId = required(expectedContinuationId, 'expectedContinuationId');
    if (expectedFence === undefined || expectedFence === null) throw new Error('expectedFence must be a bounded safe string');
    expectedFence = required(String(expectedFence), 'expectedFence');
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1000 || ttlMs > 3600000) throw new Error('ttlMs must be between 1000 and 3600000');
    repository = redactFederation(repository);
    return this.tx(async (c) => {
      const order = row(await c.query('SELECT * FROM federation_work_orders WHERE work_order_id=$1 FOR UPDATE', [workOrderId]));
      if (!order || order.project !== project) throw Object.assign(new Error('work order is not authorized for this project'), { category: 'unauthorized' });
      const priorTakeover = row(await c.query('SELECT * FROM federation_handoffs WHERE handoff_id=$1', [takeoverId]));
      if (priorTakeover) {
        const existing = row(await c.query('SELECT *,lease_until>clock_timestamp() AS lease_active FROM federation_executions WHERE execution_id=$1', [priorTakeover.to_execution_id]));
        const source = row(await c.query(`SELECT *,pg_catalog.encode(public.digest(pg_catalog.convert_to(checkpoint::text,'UTF8'),'sha256'),'hex') AS current_checkpoint_digest
          FROM federation_executions WHERE execution_id=$1`, [priorTakeover.from_execution_id]));
        const digest = source && row(await c.query(`SELECT payload->>'checkpointDigest' AS checkpoint_digest FROM federation_events
          WHERE work_order_id=$1 AND execution_id=$2 AND event_type='gas-checkpointed' ORDER BY occurred_at DESC,event_id DESC LIMIT 1`, [workOrderId, source.execution_id]));
        const continuation = continuationProjection(order, source ? { ...source, recorded_checkpoint_digest: digest?.checkpoint_digest } : null, false);
        if (!existing || priorTakeover.work_order_id !== workOrderId || existing.execution_id !== executionId || existing.claim_owner !== owner || existing.provider !== provider || existing.mode !== 'foreground' || continuation.continuationId !== expectedContinuationId || continuation.lastAuthoritativeFence !== expectedFence || canonicalJson(existing.repository) !== canonicalJson(repository)) throw conflict('takeover idempotency identity');
        if (['finalized', 'failed'].includes(existing.state)) return { status: 'completed', eligible: false, takeoverId, workOrderId, executionId };
        if (!existing.lease_active || !['claimed', 'running'].includes(existing.state)) return { status: 'expired', eligible: false, takeoverId, workOrderId, executionId };
        return takeoverResult('duplicate', takeoverId, existing, continuation, order.repository);
      }
      const active = row(await c.query(`SELECT execution_id FROM federation_executions WHERE work_order_id=$1
        AND state IN ('claimed','running') AND lease_until>clock_timestamp() ORDER BY created_at DESC,execution_id DESC LIMIT 1`, [workOrderId]));
      const prior = row(await c.query(`SELECT *,pg_catalog.encode(public.digest(pg_catalog.convert_to(checkpoint::text,'UTF8'),'sha256'),'hex') AS current_checkpoint_digest
        FROM federation_executions WHERE work_order_id=$1 ORDER BY claim_fence DESC NULLS LAST,created_at DESC,execution_id DESC LIMIT 1 FOR UPDATE`, [workOrderId]));
      const digest = prior && row(await c.query(`SELECT payload->>'checkpointDigest' AS checkpoint_digest FROM federation_events
        WHERE work_order_id=$1 AND execution_id=$2 AND event_type='gas-checkpointed' ORDER BY occurred_at DESC,event_id DESC LIMIT 1`, [workOrderId, prior.execution_id]));
      if (prior) prior.recorded_checkpoint_digest = digest?.checkpoint_digest;
      const continuation = continuationProjection(order, prior, Boolean(active));
      if (continuation.status === 'completed') return continuation;
      if (continuation.status === 'active') throw Object.assign(new Error('work order has an active mutation claim'), { category: 'active-conflict' });
      if (continuation.status !== 'resumable') throw Object.assign(new Error('durable continuation is unavailable or invalid'), { category: 'continuation-invalid' });
      if (continuation.continuationId !== expectedContinuationId || continuation.lastAuthoritativeFence !== expectedFence) throw Object.assign(new Error('discovered continuation is stale'), { category: 'stale-continuation' });
      const expectedRepositoryDigest = sha256(order.repository || {}), actualRepositoryDigest = sha256(repository || {});
      if (canonicalJson(order.repository || {}) !== canonicalJson(repository || {})) throw Object.assign(new Error('repository state drifted before takeover'), { category: 'repository-drift', expectedRepositoryDigest, actualRepositoryDigest });
      await c.query(`UPDATE federation_executions SET state='handoff',lease_until=NULL,updated_at=clock_timestamp() WHERE execution_id=$1`, [prior.execution_id]);
      const counter = row(await c.query('UPDATE federation_work_orders SET next_claim_fence=next_claim_fence+1,updated_at=clock_timestamp() WHERE work_order_id=$1 RETURNING next_claim_fence', [workOrderId]));
      const fence = String(counter.next_claim_fence);
      const lineage = normalizeObserverLineage({ workOrderId, executionId, parentExecutionId: prior.execution_id, provider, mode: 'foreground', handoffId: takeoverId, continuationId: continuation.continuationId, checkpointDigest: continuation.checkpointDigest, repositoryDigest: expectedRepositoryDigest, nextOperation: continuation.nextOperation });
      const next = row(await c.query(`INSERT INTO federation_executions(execution_id,work_order_id,provider,mode,state,claim_owner,claim_fence,lease_until,repository,lineage)
        VALUES ($1,$2,$3,'foreground','claimed',$4,$5,clock_timestamp()+($6::bigint * interval '1 millisecond'),$7,$8) RETURNING *`, [executionId, workOrderId, provider, owner, fence, ttlMs, repository, lineage]));
      await c.query(`INSERT INTO federation_handoffs(handoff_id,work_order_id,from_execution_id,to_execution_id,checkpoint,reason)
        VALUES ($1,$2,$3,$4,$5,'interactive-takeover')`, [takeoverId, workOrderId, prior.execution_id, executionId, redactFederation(prior.checkpoint)]);
      await event(c, workOrderId, executionId, 'interactive-takeover', { takeoverId, fromExecutionId: prior.execution_id, continuationId: continuation.continuationId, fence, checkpointDigest: continuation.checkpointDigest, repositoryDigest: expectedRepositoryDigest, mode: 'foreground' });
      return takeoverResult('taken-over', takeoverId, next, continuation, order.repository);
    });
  }
}

function continuationProjection(order, prior, active) {
  if (!prior) return { status: 'unavailable', eligible: false, workOrderId: order.work_order_id, project: order.project };
  const gas = prior.lineage?.gas, checkpoint = prior.checkpoint;
  const terminal = ['completed', 'finalized', 'failed'].includes(order.state) || ['finalized', 'failed'].includes(prior.state);
  const valid = gas && typeof gas === 'object' && safeProjectionId(gas.physicalExecutionId) && safeProjectionId(gas.continuationId) && /^[a-f0-9]{64}$/.test(String(gas.checkpointDigest || '')) && /^[a-f0-9]{64}$/.test(String(gas.canonicalCheckpointDigest || '')) && gas.checkpointDigest === prior.recorded_checkpoint_digest && gas.canonicalCheckpointDigest === prior.current_checkpoint_digest && checkpoint && checkpoint.workOrderId === order.work_order_id && checkpoint.executionId === prior.execution_id && checkpoint.physicalExecutionId === gas.physicalExecutionId && checkpoint.continuationId === gas.continuationId && safeProjectionId(checkpoint.nextOperation, 160);
  const status = active ? 'active' : terminal ? 'completed' : valid && ['claimed', 'running', 'deferred', 'handoff'].includes(prior.state) ? 'resumable' : 'continuation-invalid';
  return {
    status,
    eligible: status === 'resumable',
    workOrderId: order.work_order_id,
    project: order.project,
    previousExecutionId: prior.execution_id,
    previousPhysicalExecutionId: valid ? gas.physicalExecutionId : null,
    continuationId: valid ? gas.continuationId : null,
    lastAuthoritativeFence: prior.claim_fence == null ? null : String(prior.claim_fence),
    checkpointDigest: valid ? gas.checkpointDigest : null,
    lifecycle: prior.state,
    leaseUntil: stamp(prior.lease_until),
    repositoryDigest: sha256(order.repository || {}),
    evidenceDigest: valid ? sha256(Array.isArray(gas.evidence) ? gas.evidence : []) : null,
    nextOperation: valid ? checkpoint.nextOperation : null,
    observerLineage: { schema: 'celestan-observer-lineage-v1', executionId: prior.execution_id, parentExecutionId: prior.lineage?.parentExecutionId || null, provider: prior.provider, mode: prior.mode, checkpointDigest: valid ? gas.checkpointDigest : null }
  };
}

function safeProjectionId(value, max = 500) { return typeof value === 'string' && value.length > 0 && value.length <= max && !/[\0\r\n]/.test(value); }
function boundedFederationTtl(value) { if (!Number.isSafeInteger(value) || value < MIN_FEDERATION_TTL_MS || value > MAX_FEDERATION_TTL_MS) throw new Error(`ttlMs must be between ${MIN_FEDERATION_TTL_MS} and ${MAX_FEDERATION_TTL_MS}`); return value; }
function boundedFederationCheckpoint(value) { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('federation checkpoint must be a JSON object'); const serialized = canonicalJson(value); if (Buffer.byteLength(serialized, 'utf8') > MAX_FEDERATION_CHECKPOINT_BYTES) throw new Error('federation checkpoint exceeds 64 KiB'); if (value.schema !== undefined && (typeof value.schema !== 'string' || value.schema.length > 160)) throw new Error('federation checkpoint schema is invalid'); if (value.version !== undefined && (!Number.isSafeInteger(value.version) || value.version < 1)) throw new Error('federation checkpoint version is invalid'); return value; }

function takeoverResult(status, takeoverId, execution, continuation, repository) {
  const observerLineage = { schema: 'celestan-observer-lineage-v1', executionId: execution.execution_id, parentExecutionId: continuation.previousExecutionId, provider: execution.provider, mode: execution.mode, handoffId: takeoverId, continuationId: continuation.continuationId, checkpointDigest: continuation.checkpointDigest, repositoryDigest: sha256(repository || {}), nextOperation: continuation.nextOperation };
  return { status, takeoverId, workOrderId: execution.work_order_id, executionId: execution.execution_id, previousExecutionId: continuation.previousExecutionId, previousPhysicalExecutionId: continuation.previousPhysicalExecutionId, continuationId: continuation.continuationId, fence: String(execution.claim_fence), leaseUntil: stamp(execution.lease_until), provider: execution.provider, mode: execution.mode, checkpointDigest: continuation.checkpointDigest, repositoryDigest: sha256(repository || {}), evidenceDigest: continuation.evidenceDigest, nextOperation: continuation.nextOperation, observerLineage };
}

async function lockClaim(c, executionId, claim) { const current = row(await c.query(`SELECT e.*,w.next_claim_fence FROM federation_executions e JOIN federation_work_orders w ON w.work_order_id=e.work_order_id WHERE e.execution_id=$1 AND e.claim_owner=$2 AND e.claim_fence=$3 AND e.claim_fence=w.next_claim_fence AND e.lease_until>clock_timestamp() FOR UPDATE OF w,e`, [executionId, claim?.owner, String(claim?.fence)])); if (!current) throw Object.assign(new Error('lost federation fencing ownership'), { category: 'ownership-lost' }); return current; }
PostgresFederationAdapter.prototype.claimInTransaction = async function(c, workOrderId, input) { const order = row(await c.query('SELECT * FROM federation_work_orders WHERE work_order_id=$1 FOR UPDATE', [workOrderId])); if (!order) throw new Error('work order not found'); if (['completed', 'failed'].includes(order.state)) throw conflict('work order is terminal'); const repository = redactFederation(input.repository || {}); if (canonicalJson(order.repository || {}) !== canonicalJson(repository)) throw Object.assign(new Error('repository identity mismatch'), { category: 'repository-drift' }); const active = row(await c.query(`SELECT * FROM federation_executions WHERE work_order_id=$1 AND state IN ('claimed','running') AND lease_until>clock_timestamp() ORDER BY created_at DESC`, [workOrderId])); if (active) throw conflict('overlapping active mutation claim'); const parent = input.parentExecutionId ? row(await c.query('SELECT * FROM federation_executions WHERE execution_id=$1 FOR SHARE', [input.parentExecutionId])) : row(await c.query('SELECT execution_id FROM federation_executions WHERE work_order_id=$1 LIMIT 1', [workOrderId])); if (parent && (!input.parentExecutionId || parent.work_order_id !== workOrderId)) throw Object.assign(new Error('execution lineage is invalid'), { category: 'lineage-invalid' }); if (parent && !input.parentExecutionId) throw Object.assign(new Error('continuation parent is required'), { category: 'lineage-invalid' }); const counter = row(await c.query('UPDATE federation_work_orders SET next_claim_fence=next_claim_fence+1,updated_at=clock_timestamp() WHERE work_order_id=$1 RETURNING next_claim_fence', [workOrderId])); const executionId = input.executionId || id('exec'); const fence = BigInt(counter.next_claim_fence); const value = row(await c.query(`INSERT INTO federation_executions(execution_id,work_order_id,provider,mode,state,claim_owner,claim_fence,lease_until,repository,lineage) VALUES ($1,$2,$3,$4,'claimed',$5,$6,clock_timestamp()+($7::bigint * interval '1 millisecond'),$8,$9) RETURNING *`, [executionId, workOrderId, input.provider, input.mode, input.owner, String(fence), input.ttlMs, repository, normalizeObserverLineage({ workOrderId, executionId, provider: input.provider, mode: input.mode, parentExecutionId: input.parentExecutionId })])); if (input.emitEvent) await event(c, workOrderId, executionId, 'claimed', redactFederation({ owner: input.owner, fence: String(fence), mode: input.mode })); return fromExecution(value); };
async function event(c, workOrderId, executionId, type, payload) { await c.query('INSERT INTO federation_events(event_id,work_order_id,execution_id,event_type,payload) VALUES ($1,$2,$3,$4,$5)', [id('event'), workOrderId, executionId, type, payload]); }
function fromWork(v) { return { id: v.work_order_id, project: v.project, intent: v.intent, repository: v.repository, state: v.state, version: String(v.version), createdAt: stamp(v.created_at), updatedAt: stamp(v.updated_at) }; }
function fromExecution(v) { return { schema: FEDERATION_SCHEMA, id: v.execution_id, workOrderId: v.work_order_id, provider: v.provider, mode: v.mode, state: v.state, claim: v.claim_owner ? { owner: v.claim_owner, fence: String(v.claim_fence), leaseUntil: stamp(v.lease_until) } : null, checkpoint: v.checkpoint, repository: v.repository, lineage: v.lineage, createdAt: stamp(v.created_at), updatedAt: stamp(v.updated_at) }; }
