import { Pool } from 'pg';

const WORK_STATES = new Set(['actionable', 'waiting', 'review', 'terminal']);
const EXECUTION_STATES = new Set(['created', 'running', 'succeeded', 'failed', 'expired']);

function json(value) { return value == null ? null : JSON.stringify(value); }

function workFromRow(row) {
  return {
    work_unit_id: row.work_unit_id,
    objective_ref: row.objective_ref,
    state: row.state,
    fence: Number(row.fence),
    claim: row.claim_execution_id ? { execution_id: row.claim_execution_id, owner: row.claim_owner, fence: Number(row.claim_fence) } : null,
    continuation: row.continuation,
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
  };
}

export function createNeonStore({ connectionString, pool, applicationName = 'ct-runtime-vnext' } = {}) {
  if (!connectionString && !pool) throw new Error('Neon store requires an explicit PostgreSQL connection string or injected pool');
  const db = pool || new Pool({ connectionString, application_name: applicationName });
  const close = !pool;

  async function reconstruct(event) {
    const workUnitId = event?.work_unit_id || event?.feedback?.work_unit_id;
    if (!workUnitId) return null;
    const result = await db.query('SELECT * FROM vnext_work_units WHERE work_unit_id=$1', [workUnitId]);
    return result.rows[0] ? workFromRow(result.rows[0]) : null;
  }

  async function appendEvent(event) {
    if (!event || typeof event.type !== 'string') throw new Error('event.type is required');
    await db.query('INSERT INTO vnext_events(event_type,payload) VALUES ($1,$2::jsonb)', [event.type, json(event)]);
    return event;
  }

  async function saveWorkUnit(workUnit) {
    if (!WORK_STATES.has(workUnit.state)) throw new Error(`invalid work unit state: ${workUnit.state}`);
    await db.query(`
      INSERT INTO vnext_work_units(work_unit_id,objective_ref,state,fence,claim_execution_id,claim_owner,claim_fence,continuation,last_execution_id,last_turn,created_at,updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10::jsonb,$11,$12)
      ON CONFLICT (work_unit_id) DO UPDATE SET
        objective_ref=EXCLUDED.objective_ref,
        state=EXCLUDED.state,
        fence=EXCLUDED.fence,
        claim_execution_id=EXCLUDED.claim_execution_id,
        claim_owner=EXCLUDED.claim_owner,
        claim_fence=EXCLUDED.claim_fence,
        continuation=EXCLUDED.continuation,
        last_execution_id=EXCLUDED.last_execution_id,
        last_turn=EXCLUDED.last_turn,
        updated_at=EXCLUDED.updated_at`,
      [workUnit.work_unit_id, workUnit.objective_ref, workUnit.state, workUnit.fence,
        workUnit.claim?.execution_id || null, workUnit.claim?.owner || null, workUnit.claim?.fence ?? null,
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
      if (!['actionable', 'waiting'].includes(row.state) || row.claim_execution_id || Number(row.fence) !== expectedPreviousFence) {
        throw new Error('Work Unit changed before execution could be claimed');
      }
      await client.query(`UPDATE vnext_work_units SET state='actionable',fence=$2,claim_execution_id=$3,claim_owner=$4,claim_fence=$2,updated_at=clock_timestamp() WHERE work_unit_id=$1`, [workUnit.work_unit_id, execution.fence, execution.execution_id, execution.owner]);
      const inserted = await client.query(`INSERT INTO vnext_executions(execution_id,work_unit_id,owner,fence,state,started_at,finished_at) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`, [execution.execution_id, execution.work_unit_id, execution.owner, execution.fence, execution.state, execution.started_at, execution.finished_at]);
      await client.query('COMMIT');
      return { workUnit: { ...workUnit, state: 'actionable', fence: execution.fence, claim: { execution_id: execution.execution_id, owner: execution.owner, fence: execution.fence } }, execution: executionFromRow(inserted.rows[0]) };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally { client.release(); }
  }

  async function persistTurn(result) {
    const { workUnit, execution, turn } = result;
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      const current = await client.query('SELECT * FROM vnext_work_units WHERE work_unit_id=$1 FOR UPDATE', [workUnit.work_unit_id]);
      if (!current.rows[0] || Number(current.rows[0].fence) !== execution.fence || current.rows[0].claim_execution_id !== execution.execution_id || current.rows[0].claim_owner !== execution.owner) throw new Error('fencing conflict while persisting turn');
      const exec = await client.query('SELECT * FROM vnext_executions WHERE execution_id=$1 FOR UPDATE', [execution.execution_id]);
      if (!exec.rows[0] || exec.rows[0].state !== 'running') throw new Error('execution is not running');
      await client.query('UPDATE vnext_executions SET state=$2,finished_at=$3 WHERE execution_id=$1', [execution.execution_id, execution.state, execution.finished_at]);
      if (turn.disposition !== 'done') await client.query('INSERT INTO vnext_continuations(work_unit_id,execution_id,continuation) VALUES ($1,$2,$3::jsonb)', [workUnit.work_unit_id, execution.execution_id, json(turn.continuation)]);
      if (turn.outcome_evidence) await client.query('INSERT INTO vnext_evidence_refs(work_unit_id,execution_id,evidence) VALUES ($1,$2,$3::jsonb)', [workUnit.work_unit_id, execution.execution_id, json(turn.outcome_evidence)]);
      await client.query(`UPDATE vnext_work_units SET state=$2,fence=$3,claim_execution_id=NULL,claim_owner=NULL,claim_fence=NULL,continuation=$4::jsonb,last_execution_id=$5,last_turn=$6::jsonb,updated_at=clock_timestamp() WHERE work_unit_id=$1`, [workUnit.work_unit_id, workUnit.state, workUnit.fence, json(workUnit.continuation), workUnit.last_execution_id, json(workUnit.last_turn)]);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally { client.release(); }
  }

  async function persistFailure(failed) {
    const { workUnit, execution } = failed;
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      const current = await client.query('SELECT fence,claim_execution_id FROM vnext_work_units WHERE work_unit_id=$1 FOR UPDATE', [workUnit.work_unit_id]);
      if (!current.rows[0] || Number(current.rows[0].fence) !== execution.fence || current.rows[0].claim_execution_id !== execution.execution_id) throw new Error('fencing conflict while persisting failure');
      await client.query('UPDATE vnext_executions SET state=$2,finished_at=$3 WHERE execution_id=$1 AND state IN (\'created\',\'running\')', [execution.execution_id, execution.state, execution.finished_at]);
      await client.query(`UPDATE vnext_work_units SET state='actionable',claim_execution_id=NULL,claim_owner=NULL,claim_fence=NULL,last_execution_id=$2,updated_at=clock_timestamp() WHERE work_unit_id=$1`, [workUnit.work_unit_id, execution.execution_id]);
      await client.query('COMMIT');
      return failed;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally { client.release(); }
  }

  async function createExecution(execution) {
    if (!EXECUTION_STATES.has(execution.state)) throw new Error(`invalid execution state: ${execution.state}`);
    await db.query('INSERT INTO vnext_executions(execution_id,work_unit_id,owner,fence,state,started_at,finished_at) VALUES ($1,$2,$3,$4,$5,$6,$7)', [execution.execution_id, execution.work_unit_id, execution.owner, execution.fence, execution.state, execution.started_at, execution.finished_at]);
    return execution;
  }

  async function finishExecution(execution) {
    await db.query('UPDATE vnext_executions SET state=$2,finished_at=$3 WHERE execution_id=$1', [execution.execution_id, execution.state, execution.finished_at]);
    return execution;
  }

  async function appendContinuation(workUnitId, executionId, continuation) {
    await db.query('INSERT INTO vnext_continuations(work_unit_id,execution_id,continuation) VALUES ($1,$2,$3::jsonb)', [workUnitId, executionId, json(continuation)]);
    return { work_unit_id: workUnitId, execution_id: executionId, continuation };
  }

  async function appendEvidence(workUnitId, executionId, evidence) {
    await db.query('INSERT INTO vnext_evidence_refs(work_unit_id,execution_id,evidence) VALUES ($1,$2,$3::jsonb)', [workUnitId, executionId, json(evidence)]);
    return { work_unit_id: workUnitId, execution_id: executionId, evidence };
  }

  async function manifest(executionId) {
    const result = await db.query('SELECT state FROM vnext_executions WHERE execution_id=$1', [executionId]);
    const row = result.rows[0];
    return row ? { execution: { status: row.state === 'succeeded' ? 'success' : row.state } } : null;
  }

  async function close() { if (close) await db.end(); }

  return { appendEvent, reconstruct, saveWorkUnit, beginExecution, persistTurn, persistFailure, createExecution, finishExecution, appendContinuation, appendEvidence, manifest, close };
}
