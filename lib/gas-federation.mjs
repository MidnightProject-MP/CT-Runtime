import crypto from 'node:crypto';
import { canonicalJson, sha256 } from './config.mjs';

export const GAS_FEDERATION_SCHEMA = 'celestan-gas-federation-advisory-v1';
export const GAS_FEDERATION_VERSION = 1;
export const GAS_FEDERATION_MAX_BODY_BYTES = 8192;
export const GAS_FEDERATION_MAX_TTL_MS = 30 * 60 * 1000;
export const GAS_FEDERATION_RPC_PATHS = Object.freeze({
  pending: '/rpc/federation_pending_advisories',
  take: '/rpc/federation_take_for_gas',
  checkpoint: '/rpc/federation_checkpoint_for_gas'
});
const FIELDS = ['schema', 'version', 'nonce', 'issuedAt', 'expiresAt', 'instanceId', 'workOrderId', 'handoffId', 'handoffRevision', 'targetExecutionId', 'targetFence', 'checkpointDigest', 'reason'];
const safe = (value, name, max = 200) => { if (typeof value !== 'string' || !value || value.length > max || /[\0\r\n]/.test(value)) throw new Error(`${name} is invalid`); return value; };

export function canonicalAdvisory(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('advisory is required');
  if (Object.keys(value).sort().join(',') !== FIELDS.slice().sort().join(',')) throw new Error('advisory fields are not canonical');
  const result = { ...value, schema: GAS_FEDERATION_SCHEMA, version: GAS_FEDERATION_VERSION };
  safe(result.schema, 'schema'); if (result.version !== 1) throw new Error('advisory version is invalid');
  safe(result.nonce, 'nonce', 128); safe(result.instanceId, 'instanceId', 160); safe(result.workOrderId, 'workOrderId', 160);
  safe(result.handoffId, 'handoffId', 160); safe(result.targetExecutionId, 'targetExecutionId', 160); safe(result.reason, 'reason', 240);
  if (!Number.isSafeInteger(result.handoffRevision) || result.handoffRevision < 1) throw new Error('handoff revision is invalid');
  if (!Number.isSafeInteger(result.targetFence) || result.targetFence < 1) throw new Error('target fence is invalid');
  if (!/^[a-f0-9]{64}$/.test(result.checkpointDigest)) throw new Error('checkpoint digest is invalid');
  if (typeof result.issuedAt !== 'string' || typeof result.expiresAt !== 'string') throw new Error('advisory timestamps are invalid');
  let issuedDate, expiresDate, issuedIso, expiresIso;
  try { issuedDate = new Date(result.issuedAt); expiresDate = new Date(result.expiresAt); issuedIso = issuedDate.toISOString(); expiresIso = expiresDate.toISOString(); } catch { throw new Error('advisory timestamps are invalid'); }
  if (issuedIso !== result.issuedAt || expiresIso !== result.expiresAt) throw new Error('advisory timestamps are not canonical');
  const issued = issuedDate.getTime(), expires = expiresDate.getTime();
  if (!Number.isFinite(issued) || !Number.isFinite(expires) || expires <= issued || expires - issued > GAS_FEDERATION_MAX_TTL_MS) throw new Error('advisory TTL is invalid');
  const body = canonicalJson(result);
  if (Buffer.byteLength(body, 'utf8') > GAS_FEDERATION_MAX_BODY_BYTES) throw new Error('advisory body exceeds bound');
  return result;
}

export function createGasNotifier({ url, secret, fetch = globalThis.fetch } = {}) {
  if (!url || typeof fetch !== 'function' || typeof secret !== 'string' || !secret) throw new Error('GAS notifier requires url, secret, and fetch');
  return async (advisory) => {
    const body = canonicalJson(canonicalAdvisory(advisory));
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = crypto.createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
    const target = new URL(url);
    target.searchParams.set('timestamp', timestamp);
    target.searchParams.set('signature', signature);
    const response = await fetch(target, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
    let result = null;
    try { result = JSON.parse(await response.text()); } catch {}
    const classification = result?.status || 'invalid-response';
    return { status: response.status, ok: response.ok && (classification === 'checkpointed' || classification === 'already-consumed'), classification, reason: result?.reason || null, digest: sha256(body) };
  };
}

export async function persistThenNotify({ persist, notify, advisory } = {}) {
  if (typeof persist !== 'function' || typeof notify !== 'function') throw new Error('persist and notify functions are required');
  const persisted = await persist(canonicalAdvisory(advisory));
  return { persisted, notification: persisted?.state === 'pending' ? await notify(canonicalAdvisory(advisory)) : null };
}

export class PostgresGasAdvisoryAdapter {
  constructor(pool) { if (!pool) throw new Error('Postgres pool is required'); this.pool = pool; }
  async persist(advisory) {
    const value = canonicalAdvisory(advisory);
    const body = canonicalJson(value);
    const digest = sha256(body);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query(`INSERT INTO federation_advisories
        (advisory_id,nonce,advisory_body,body_digest,advisory_schema,version,issued_at,expires_at,instance_id,work_order_id,
         handoff_id,handoff_revision,target_execution_id,target_fence,checkpoint_digest,reason,state)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,'pending')
         ON CONFLICT (nonce) DO NOTHING RETURNING advisory_id`,
      [value.nonce, value.nonce, body, digest, value.schema, value.version, value.issuedAt, value.expiresAt,
         value.instanceId, value.workOrderId, value.handoffId, value.handoffRevision, value.targetExecutionId,
         value.targetFence, value.checkpointDigest, value.reason]);
      if (!result.rowCount) {
        const existing = (await client.query('SELECT body_digest,state FROM federation_advisories WHERE nonce=$1 FOR UPDATE', [value.nonce])).rows[0];
        if (!existing || existing.body_digest !== digest) throw new Error('advisory nonce replay');
        await client.query('COMMIT');
        return { advisoryId: value.nonce, state: existing.state, duplicate: true };
      }
      const handoff = (await client.query(`SELECT h.*, s.checkpoint AS source_checkpoint, w.next_claim_fence
        FROM federation_handoffs h
        JOIN federation_executions s ON s.execution_id=h.from_execution_id
        JOIN federation_work_orders w ON w.work_order_id=h.work_order_id
        WHERE h.handoff_id=$1 AND h.work_order_id=$2 AND h.revision=$3
        FOR UPDATE`, [value.handoffId, value.workOrderId, value.handoffRevision])).rows[0];
      const target = (await client.query(`SELECT * FROM federation_executions
        WHERE execution_id=$1 AND work_order_id=$2 FOR UPDATE`, [value.targetExecutionId, value.workOrderId])).rows[0];
      if (!handoff || !target || handoff.to_execution_id !== value.targetExecutionId || String(target.claim_fence) !== String(value.targetFence) || String(handoff.next_claim_fence) !== String(value.targetFence) || !['claimed', 'running'].includes(target.state) || target.claim_owner !== value.instanceId || sha256(handoff.source_checkpoint || null) !== value.checkpointDigest) throw new Error('advisory target or source checkpoint is stale');
      await client.query('COMMIT');
      return { advisoryId: value.nonce, state: 'pending', duplicate: false };
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
    finally { client.release(); }
  }
}

export async function persistGasAdvisoryThenNotify({ pool, notify, advisory } = {}) {
  if (!pool || typeof notify !== 'function') throw new Error('pool and notify are required');
   const persisted = await new PostgresGasAdvisoryAdapter(pool).persist(advisory);
   return { persisted, notification: persisted.state === 'pending' ? await notify(canonicalAdvisory(advisory)) : null };
}
