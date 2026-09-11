import { Pool } from 'pg';

const WORK_STATES = new Set(['actionable', 'waiting', 'review', 'terminal']);

function json(value) { return value == null ? null : JSON.stringify(value); }
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}

function workFromRow(row) {
  return {
    work_unit_id: row.work_unit_id,
    objective_ref: row.objective_ref,
    state: row.state,
    fence: Number(row.fence),
    claim: row.claim_execution_id ? { execution_id: row.claim_execution_id, owner: row.claim_owner, fence: Number(row.claim_fence), claim_expires_at: row.claim_expires_at ? row.claim_expires_at.toISOString() : null } : null,
    continuation: row.continuation,
    claim_expires_at: row.claim_expires_at ? row.claim_expires_at.toISOString() : null,
    attempt: Number(row.attempt || 0), failure: row.failure, retry_after: row.retry_after ? row.retry_after.toISOString() : null,
    last_execution_id: row.last_execution_id,
    last_turn: row.last_turn,
    created_at: row.created_at.toISOString(),
  };
}

function executionFromRow(row) {
  return {
    execution_id: row.execution_id,
    work_unit_id: row.work_unit_id,
    owner: row.owner,
    fence: Number(row.fence),
    state: row.state,
    started_at: row.started_at.toISOString(),
    finished_at: row.finished_at ? row.finished_at.toISOString() : null,
    claim_expires_at: row.claim_expires_at ? row.claim_expires_at.toISOString() : null,
    attempt: Number(row.attempt || 1), failure: row.failure, retry_after: row.retry_after ? row.retry_after.toISOString() : null,
  };
}

export function createNeonStore({ connectionString, pool, applicationName = 'ct-runtime-vnext' } = {}) {
  if (!connectionString && !pool) throw new Error('Neon store requires an explicit PostgreSQL connection string or injected pool');
  const db = pool || new Pool({ connectionString, application_name: applicationName });
  const ownsPool = !pool;

  async function reconstruct(event) {
    const workUnitId = event?.work_unit_id || event?.feedback?.work_unit_id;
    if (!workUnitId) return null;
    const result = await db.query('SELECT * FROM vnext_work_units WHERE work_unit_id=$1', [workUnitId]);
    return result.rows[0] ? workFromRow(result.rows[0]) : null;
  }

  async function appendEvent(event) {
    if (!event || typeof event.type !== 'string') throw new Error('event.type is required');
    if (typeof event.event_id !== 'string' || !event.event_id) throw new Error('event.event_id is required');
    const payload = json(event);
    const result = await db.query('INSERT INTO vnext_events(event_id,event_type,payload) VALUES ($1,$2,$3::jsonb) ON CONFLICT DO NOTHING RETURNING event_id', [event.event_id, event.type, payload]);
    if (result.rowCount === 0) {
      const existing = (await db.query('SELECT event_type,payload FROM vnext_events WHERE event_id=$1', [event.event_id])).rows[0];
      if (!existing || existing.event_type !== event.type || JSON.stringify(canonical(existing.payload)) !== JSON.stringify(canonical(event))) throw new Error('event identity conflict');
    }
    return { ...event, consumed: result.rowCount === 1, receipt: (await db.query('SELECT * FROM vnext_events WHERE event_id=$1', [event.event_id])).rows[0] };
  }

  async function markEventProcessing({ eventId, executionId, completed = false } = {}) {
    const status = completed ? 'completed' : 'processing';
    const updated = await db.query(`UPDATE vnext_events SET processing_status=$2,processing_execution_id=$3,processing_completed_at=CASE WHEN $2='completed' THEN clock_timestamp() ELSE processing_completed_at END WHERE event_id=$1 AND processing_status <> 'completed' RETURNING processing_status,processing_execution_id`, [eventId, status, executionId]);
    if (updated.rowCount) return { status: updated.rows[0].processing_status, execution_id: updated.rows[0].processing_execution_id };
    const row = (await db.query('SELECT processing_status,processing_execution_id FROM vnext_events WHERE event_id=$1', [eventId])).rows[0];
    return row ? { status: row.processing_status, execution_id: row.processing_execution_id } : { status: 'missing' };
  }

  async function discoverUnprocessedEvents({ limit = 100 } = {}) {
    return (await db.query("SELECT * FROM vnext_events WHERE processing_status <> 'completed' ORDER BY created_at,event_id LIMIT $1", [limit])).rows;
  }

  // Creation is intentionally insert-only. Existing Work Units can only change
  // through fenced transition operations below.
  async function createWorkUnit(workUnit) {
    if (!WORK_STATES.has(workUnit.state)) throw new Error(`invalid work unit state: ${workUnit.state}`);
    await db.query(`
      INSERT INTO vnext_work_units(work_unit_id,objective_ref,state,fence,claim_execution_id,claim_owner,claim_fence,claim_expires_at,attempt,failure,retry_after,continuation,last_execution_id,last_turn,created_at,updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12::jsonb,$13,$14::jsonb,$15,$16)`,
      [workUnit.work_unit_id, workUnit.objective_ref, workUnit.state, workUnit.fence,
         workUnit.claim?.execution_id || null, workUnit.claim?.owner || null, workUnit.claim?.fence ?? null, workUnit.claim_expires_at || workUnit.claim?.claim_expires_at || null, workUnit.attempt || 0, json(workUnit.failure), workUnit.retry_after || null,
         json(workUnit.continuation), workUnit.last_execution_id || null, json(workUnit.last_turn), workUnit.created_at, new Date().toISOString()]);
    return workUnit;
  }

  async function beginExecution(workUnit, execution) {
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      const current = await client.query('SELECT * FROM vnext_work_units WHERE work_unit_id=$1 FOR UPDATE', [workUnit.work_unit_id]);
      if (!current.rows[0]) throw new Error('Work Unit does not exist');
      const row = current.rows[0];
      const expectedPreviousFence = execution.fence - 1;
      const expired = row.claim_execution_id && row.claim_expires_at && new Date(row.claim_expires_at).getTime() <= Date.now();
      if (!['actionable', 'waiting'].includes(row.state) || (row.claim_execution_id && !expired) || Number(row.fence) !== expectedPreviousFence) throw new Error('Work Unit changed before execution could be claimed');
      if (expired) await client.query("UPDATE vnext_executions SET state='expired',finished_at=clock_timestamp() WHERE execution_id=$1 AND state IN ('created','running')", [row.claim_execution_id]);
      await client.query(`UPDATE vnext_work_units SET state='actionable',fence=$2,claim_execution_id=$3,claim_owner=$4,claim_fence=$2,claim_expires_at=$5,attempt=$6,updated_at=clock_timestamp() WHERE work_unit_id=$1`, [workUnit.work_unit_id, execution.fence, execution.execution_id, execution.owner, execution.claim_expires_at, execution.attempt]);
      const inserted = await client.query(`INSERT INTO vnext_executions(execution_id,work_unit_id,owner,fence,state,started_at,finished_at,claim_expires_at,attempt,failure,retry_after) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11) RETURNING *`, [execution.execution_id, execution.work_unit_id, execution.owner, execution.fence, execution.state, execution.started_at, execution.finished_at, execution.claim_expires_at, execution.attempt, json(execution.failure), execution.retry_after]);
      await client.query('COMMIT');
      return { workUnit: { ...workUnit, state: 'actionable', fence: execution.fence, claim_expires_at: execution.claim_expires_at, attempt: execution.attempt, claim: { execution_id: execution.execution_id, owner: execution.owner, fence: execution.fence, claim_expires_at: execution.claim_expires_at } }, execution: executionFromRow(inserted.rows[0]) };
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
    finally { client.release(); }
  }

  async function recoverExpiredClaims({ now = new Date(), limit = 100 } = {}) {
    const client = await db.connect();
    const recovered = [];
    try {
      await client.query('BEGIN');
      const candidates = await client.query(`
        SELECT w.work_unit_id,w.claim_execution_id,w.fence
        FROM vnext_work_units w
        JOIN vnext_executions e ON e.execution_id=w.claim_execution_id
        WHERE w.claim_expires_at <= $1 AND e.state IN ('created','running')
        ORDER BY w.claim_expires_at,w.work_unit_id
        LIMIT $2
        FOR UPDATE SKIP LOCKED`, [now, limit]);
      for (const row of candidates.rows) {
        const expiredAt = new Date(now).toISOString();
        const updated = await client.query(`
          UPDATE vnext_executions
          SET state='expired',finished_at=$2
          WHERE execution_id=$1 AND state IN ('created','running')
          RETURNING execution_id`, [row.claim_execution_id, expiredAt]);
        if (updated.rowCount === 1) recovered.push({ work_unit_id: row.work_unit_id, execution_id: row.claim_execution_id, fence: Number(row.fence), expired_at: expiredAt });
      }
      await client.query('COMMIT');
      return recovered;
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
    finally { client.release(); }
  }

  async function persistTurn(result) {
    const { workUnit, execution, turn } = result;
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      const current = await client.query('SELECT * FROM vnext_work_units WHERE work_unit_id=$1 FOR UPDATE', [workUnit.work_unit_id]);
      if (!current.rows[0] || Number(current.rows[0].fence) !== execution.fence || current.rows[0].claim_execution_id !== execution.execution_id || current.rows[0].claim_owner !== execution.owner || Number(current.rows[0].claim_fence) !== execution.fence) throw new Error('fencing conflict while persisting turn');
      const exec = await client.query('SELECT * FROM vnext_executions WHERE execution_id=$1 FOR UPDATE', [execution.execution_id]);
      if (!exec.rows[0] || exec.rows[0].state !== 'running') throw new Error('execution is not running');
       await client.query('UPDATE vnext_executions SET state=$2,finished_at=$3,failure=$4::jsonb,retry_after=$5 WHERE execution_id=$1', [execution.execution_id, execution.state, execution.finished_at, json(execution.failure), execution.retry_after]);
      if (result.settlement?.event_id) await client.query('INSERT INTO vnext_settlement_attempts(execution_id,work_unit_id,event_id,fence,result) VALUES ($1,$2,$3,$4,$5::jsonb)', [execution.execution_id, workUnit.work_unit_id, result.settlement.event_id, execution.fence, json({ workUnit, execution, turn })]);
      if (turn.disposition !== 'done') await client.query('INSERT INTO vnext_continuations(work_unit_id,execution_id,continuation) VALUES ($1,$2,$3::jsonb)', [workUnit.work_unit_id, execution.execution_id, json(turn.continuation)]);
      if (turn.outcome_evidence) await client.query('INSERT INTO vnext_evidence_refs(work_unit_id,execution_id,evidence) VALUES ($1,$2,$3::jsonb)', [workUnit.work_unit_id, execution.execution_id, json(turn.outcome_evidence)]);
       await client.query(`UPDATE vnext_work_units SET state=$2,fence=$3,claim_execution_id=NULL,claim_owner=NULL,claim_fence=NULL,claim_expires_at=NULL,attempt=$4,failure=$5::jsonb,retry_after=$6,continuation=$7::jsonb,last_execution_id=$8,last_turn=$9::jsonb,updated_at=clock_timestamp() WHERE work_unit_id=$1`, [workUnit.work_unit_id, workUnit.state, workUnit.fence, workUnit.attempt, json(workUnit.failure), workUnit.retry_after, json(workUnit.continuation), workUnit.last_execution_id, json(workUnit.last_turn)]);
      await client.query('COMMIT');
      return result;
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
    finally { client.release(); }
  }

  async function readbackSettlement({ workUnitId, executionId, eventId, fence, owner } = {}) {
    try {
      const row = (await db.query(
        'SELECT result FROM vnext_settlement_attempts WHERE execution_id=$1 AND work_unit_id=$2 AND event_id=$3 AND fence=$4',
        [executionId, workUnitId, eventId, fence],
      )).rows[0];
      if (row) return { status: 'committed', committed: true, ...row.result };
      const current = (await db.query(`SELECT e.state,e.owner,e.fence AS execution_fence,w.fence,w.claim_execution_id
        FROM vnext_executions e JOIN vnext_work_units w ON w.work_unit_id=e.work_unit_id WHERE e.execution_id=$1`, [executionId])).rows[0];
      if (current?.state === 'running' && Number(current.execution_fence) === Number(fence) && (!owner || current.owner === owner) && current.claim_execution_id === executionId) return { status: 'same-authority-active', committed: false };
      if (current && (Number(current.execution_fence) !== Number(fence) || Number(current.fence) > Number(fence) || current.claim_execution_id !== executionId)) return { status: 'superseded', committed: false };
      return { status: 'definitively-uncommitted', committed: false };
    } catch {
      return { status: 'inconclusive', committed: false };
    }
  }

  async function persistFailure(failed) {
    const { workUnit, execution } = failed;
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      const current = await client.query('SELECT fence,claim_execution_id,claim_owner,claim_fence FROM vnext_work_units WHERE work_unit_id=$1 FOR UPDATE', [workUnit.work_unit_id]);
      if (!current.rows[0] || Number(current.rows[0].fence) !== execution.fence || current.rows[0].claim_execution_id !== execution.execution_id || current.rows[0].claim_owner !== execution.owner || Number(current.rows[0].claim_fence) !== execution.fence) throw new Error('fencing conflict while persisting failure');
       const updated = await client.query("UPDATE vnext_executions SET state=$2,finished_at=$3,failure=$6::jsonb,retry_after=$7 WHERE execution_id=$1 AND owner=$4 AND fence=$5 AND state IN ('created','running')", [execution.execution_id, execution.state, execution.finished_at, execution.owner, execution.fence, json(execution.failure), execution.retry_after]);
      if (updated.rowCount !== 1) throw new Error('execution is not active for failure persistence');
       await client.query(`UPDATE vnext_work_units SET state=$3,claim_execution_id=NULL,claim_owner=NULL,claim_fence=NULL,claim_expires_at=NULL,attempt=$6,failure=$4::jsonb,retry_after=$5,last_execution_id=$2,updated_at=clock_timestamp() WHERE work_unit_id=$1`, [workUnit.work_unit_id, execution.execution_id, workUnit.state, json(workUnit.failure), workUnit.retry_after, workUnit.attempt]);
      await client.query('COMMIT');
      return failed;
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
    finally { client.release(); }
  }

  async function manifest(executionId) {
    const result = await db.query('SELECT state FROM vnext_executions WHERE execution_id=$1', [executionId]);
    const row = result.rows[0];
    return row ? { execution: { status: row.state === 'succeeded' ? 'success' : row.state } } : null;
  }

  async function close() { if (ownsPool) await db.end(); }

  return { appendEvent, markEventProcessing, discoverUnprocessedEvents, reconstruct, createWorkUnit, beginExecution, recoverExpiredClaims, persistTurn, readbackSettlement, persistFailure, manifest, close };
}
