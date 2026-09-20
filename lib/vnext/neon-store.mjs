import { Pool } from 'pg';

const WORK_STATES = new Set(['actionable', 'waiting', 'review', 'terminal']);

function json(value) { return value == null ? null : JSON.stringify(value); }

function sameTime(a, b) {
  return a != null && b != null && new Date(a).getTime() === new Date(b).getTime();
}

function workFromRow(row) {
  return {
    work_unit_id: row.work_unit_id,
    objective_ref: row.objective_ref,
    project_id: row.project_id,
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
    project_id: row.project_id,
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
    const result = await db.query('INSERT INTO vnext_events(event_id,event_type,payload) VALUES ($1,$2,$3::jsonb) ON CONFLICT DO NOTHING RETURNING event_id', [event.event_id, event.type, json(event)]);
    return { ...event, consumed: result.rowCount === 1 };
  }

  // Creation is intentionally insert-only. Existing Work Units can only change
  // through fenced transition operations below.
  async function createWorkUnit(workUnit) {
    if (!WORK_STATES.has(workUnit.state)) throw new Error(`invalid work unit state: ${workUnit.state}`);
    if (!workUnit.project_id) throw new Error('project_id is required');
    await db.query(`
      INSERT INTO vnext_work_units(work_unit_id,objective_ref,project_id,state,fence,claim_execution_id,claim_owner,claim_fence,claim_expires_at,attempt,failure,retry_after,continuation,last_execution_id,last_turn,created_at,updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13::jsonb,$14,$15::jsonb,$16,$17)`,
      [workUnit.work_unit_id, workUnit.objective_ref, workUnit.project_id, workUnit.state, workUnit.fence,
        workUnit.claim?.execution_id || null, workUnit.claim?.owner || null, workUnit.claim?.fence ?? null, workUnit.claim_expires_at || workUnit.claim?.claim_expires_at || null, workUnit.attempt || 0, json(workUnit.failure), workUnit.retry_after || null,
        json(workUnit.continuation), workUnit.last_execution_id || null, json(workUnit.last_turn), workUnit.created_at, new Date().toISOString()]);
    return workUnit;
  }

  async function beginExecution(workUnit, execution) {
    if (execution.work_unit_id !== workUnit.work_unit_id) throw new Error('execution belongs to a different Work Unit');
    if (execution.project_id !== workUnit.project_id) throw new Error('execution belongs to a different project');
    if (!execution.project_id) throw new Error('project_id is required');
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      const current = await client.query('SELECT * FROM vnext_work_units WHERE work_unit_id=$1 FOR UPDATE', [workUnit.work_unit_id]);
      if (!current.rows[0]) throw new Error('Work Unit does not exist');
      const row = current.rows[0];
      const expectedPreviousFence = execution.fence - 1;
      const expired = row.claim_execution_id && row.claim_expires_at && new Date(row.claim_expires_at).getTime() <= Date.now();
      if (!['actionable', 'waiting'].includes(row.state) || (row.claim_execution_id && !expired) || Number(row.fence) !== expectedPreviousFence) throw new Error('Work Unit changed before execution could be claimed');

      // Serialize project authority on the project row: lock any existing
      // authority, revoke an expired holder, then race-proof the new insert.
      const existingAuthority = await client.query('SELECT * FROM vnext_project_mutation_authority WHERE project_id=$1 FOR UPDATE', [execution.project_id]);
      if (existingAuthority.rows[0]) {
        const authorityRow = existingAuthority.rows[0];
        const authorityExpired = new Date(authorityRow.claim_expires_at).getTime() <= Date.now();
        if (!authorityExpired) throw new Error('E_PROJECT_AUTH_HELD: project mutation authority is already held');
        await client.query("UPDATE vnext_executions SET state='expired',finished_at=clock_timestamp() WHERE execution_id=$1 AND state IN ('created','running')", [authorityRow.execution_id]);
        await client.query("UPDATE vnext_work_units SET state='waiting',claim_execution_id=NULL,claim_owner=NULL,claim_fence=NULL,claim_expires_at=NULL,updated_at=clock_timestamp() WHERE work_unit_id=$1 AND claim_execution_id=$2 AND claim_fence=$3", [authorityRow.work_unit_id, authorityRow.execution_id, authorityRow.fence]);
        await client.query('DELETE FROM vnext_project_mutation_authority WHERE project_id=$1', [execution.project_id]);
      }

      const inserted = await client.query(`INSERT INTO vnext_executions(execution_id,work_unit_id,project_id,owner,fence,state,started_at,finished_at,claim_expires_at,attempt,failure,retry_after) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12) RETURNING *`, [execution.execution_id, execution.work_unit_id, execution.project_id, execution.owner, execution.fence, execution.state, execution.started_at, execution.finished_at, execution.claim_expires_at, execution.attempt, json(execution.failure), execution.retry_after]);
      const authorityInserted = await client.query('INSERT INTO vnext_project_mutation_authority(project_id,work_unit_id,execution_id,fence,owner,claim_expires_at) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING RETURNING *', [execution.project_id, workUnit.work_unit_id, execution.execution_id, execution.fence, execution.owner, execution.claim_expires_at]);
      if (authorityInserted.rowCount !== 1) throw new Error('E_PROJECT_AUTH_HELD: project mutation authority is already held');

      if (expired) await client.query("UPDATE vnext_executions SET state='expired',finished_at=clock_timestamp() WHERE execution_id=$1 AND state IN ('created','running')", [row.claim_execution_id]);
      await client.query(`UPDATE vnext_work_units SET state='actionable',fence=$2,claim_execution_id=$3,claim_owner=$4,claim_fence=$2,claim_expires_at=$5,attempt=$6,updated_at=clock_timestamp() WHERE work_unit_id=$1`, [workUnit.work_unit_id, execution.fence, execution.execution_id, execution.owner, execution.claim_expires_at, execution.attempt]);
      await client.query('COMMIT');
      return { workUnit: { ...workUnit, project_id: execution.project_id, state: 'actionable', fence: execution.fence, claim_expires_at: execution.claim_expires_at, attempt: execution.attempt, claim: { execution_id: execution.execution_id, owner: execution.owner, fence: execution.fence, claim_expires_at: execution.claim_expires_at } }, execution: executionFromRow(inserted.rows[0]) };
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
    finally { client.release(); }
  }

  async function persistTurn(result) {
    const { workUnit, execution, turn } = result;
    if (execution.work_unit_id !== workUnit.work_unit_id) throw new Error('execution belongs to a different Work Unit');
    if (execution.project_id !== workUnit.project_id) throw new Error('execution belongs to a different project');
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      const current = await client.query('SELECT * FROM vnext_work_units WHERE work_unit_id=$1 FOR UPDATE', [workUnit.work_unit_id]);
      if (!current.rows[0] || Number(current.rows[0].fence) !== execution.fence || current.rows[0].claim_execution_id !== execution.execution_id || current.rows[0].claim_owner !== execution.owner || Number(current.rows[0].claim_fence) !== execution.fence || !sameTime(current.rows[0].claim_expires_at, execution.claim_expires_at)) throw new Error('fencing conflict while persisting turn');
      const authority = await client.query('SELECT * FROM vnext_project_mutation_authority WHERE project_id=$1 FOR UPDATE', [execution.project_id]);
      if (!authority.rows[0] || authority.rows[0].work_unit_id !== workUnit.work_unit_id || authority.rows[0].execution_id !== execution.execution_id || Number(authority.rows[0].fence) !== execution.fence || authority.rows[0].owner !== execution.owner) throw new Error('fencing conflict while persisting turn');
      if (new Date(authority.rows[0].claim_expires_at).getTime() <= Date.now()) throw new Error('fencing conflict while persisting turn: project mutation authority expired');
      const exec = await client.query('SELECT * FROM vnext_executions WHERE execution_id=$1 AND work_unit_id=$2 AND project_id=$3 AND owner=$4 AND fence=$5 FOR UPDATE', [execution.execution_id, workUnit.work_unit_id, workUnit.project_id, execution.owner, execution.fence]);
      if (!exec.rows[0] || exec.rows[0].state !== 'running' || !sameTime(exec.rows[0].claim_expires_at, execution.claim_expires_at)) throw new Error('execution is not running');
      await client.query('UPDATE vnext_executions SET state=$2,finished_at=$3,failure=$4::jsonb,retry_after=$5 WHERE execution_id=$1 AND work_unit_id=$6 AND project_id=$7 AND owner=$8 AND fence=$9', [execution.execution_id, execution.state, execution.finished_at, json(execution.failure), execution.retry_after, workUnit.work_unit_id, workUnit.project_id, execution.owner, execution.fence]);
      if (turn.disposition !== 'done') await client.query('INSERT INTO vnext_continuations(work_unit_id,execution_id,continuation) VALUES ($1,$2,$3::jsonb)', [workUnit.work_unit_id, execution.execution_id, json(turn.continuation)]);
      if (turn.outcome_evidence) await client.query('INSERT INTO vnext_evidence_refs(work_unit_id,execution_id,evidence) VALUES ($1,$2,$3::jsonb)', [workUnit.work_unit_id, execution.execution_id, json(turn.outcome_evidence)]);
      await client.query(`UPDATE vnext_work_units SET state=$2,fence=$3,claim_execution_id=NULL,claim_owner=NULL,claim_fence=NULL,claim_expires_at=NULL,attempt=$4,failure=$5::jsonb,retry_after=$6,continuation=$7::jsonb,last_execution_id=$8,last_turn=$9::jsonb,updated_at=clock_timestamp() WHERE work_unit_id=$1`, [workUnit.work_unit_id, workUnit.state, workUnit.fence, workUnit.attempt, json(workUnit.failure), workUnit.retry_after, json(workUnit.continuation), workUnit.last_execution_id, json(workUnit.last_turn)]);
      await client.query('DELETE FROM vnext_project_mutation_authority WHERE project_id=$1 AND work_unit_id=$2 AND execution_id=$3 AND fence=$4', [execution.project_id, workUnit.work_unit_id, execution.execution_id, execution.fence]);
      await client.query('COMMIT');
      return result;
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
    finally { client.release(); }
  }

  async function persistFailure(failed) {
    const { workUnit, execution } = failed;
    if (execution.work_unit_id !== workUnit.work_unit_id) throw new Error('execution belongs to a different Work Unit');
    if (execution.project_id !== workUnit.project_id) throw new Error('execution belongs to a different project');
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      const current = await client.query('SELECT * FROM vnext_work_units WHERE work_unit_id=$1 FOR UPDATE', [workUnit.work_unit_id]);
      const authority = await client.query('SELECT * FROM vnext_project_mutation_authority WHERE project_id=$1 FOR UPDATE', [execution.project_id]);
      const exec = await client.query('SELECT * FROM vnext_executions WHERE execution_id=$1 AND work_unit_id=$2 AND project_id=$3 AND owner=$4 AND fence=$5 FOR UPDATE', [execution.execution_id, workUnit.work_unit_id, workUnit.project_id, execution.owner, execution.fence]);
      if (!current.rows[0] || !authority.rows[0] || authority.rows[0].work_unit_id !== workUnit.work_unit_id || authority.rows[0].execution_id !== execution.execution_id || Number(authority.rows[0].fence) !== execution.fence || authority.rows[0].owner !== execution.owner || Number(current.rows[0].fence) !== execution.fence || current.rows[0].claim_execution_id !== execution.execution_id || current.rows[0].claim_owner !== execution.owner || Number(current.rows[0].claim_fence) !== execution.fence || !sameTime(current.rows[0].claim_expires_at, execution.claim_expires_at) || !exec.rows[0] || !['created', 'running'].includes(exec.rows[0].state) || !sameTime(exec.rows[0].claim_expires_at, execution.claim_expires_at)) throw new Error('fencing conflict while persisting failure');
      if (new Date(authority.rows[0].claim_expires_at).getTime() <= Date.now()) throw new Error('fencing conflict while persisting failure: project mutation authority expired');
      await client.query('UPDATE vnext_executions SET state=$2,finished_at=$3,failure=$4::jsonb,retry_after=$5 WHERE execution_id=$1 AND work_unit_id=$6 AND project_id=$7 AND owner=$8 AND fence=$9', [execution.execution_id, execution.state, execution.finished_at, json(execution.failure), execution.retry_after, workUnit.work_unit_id, workUnit.project_id, execution.owner, execution.fence]);
      await client.query(`UPDATE vnext_work_units SET state=$2,fence=$3,claim_execution_id=NULL,claim_owner=NULL,claim_fence=NULL,claim_expires_at=NULL,attempt=$4,failure=$5::jsonb,retry_after=$6,continuation=$7::jsonb,last_execution_id=$8,last_turn=$9::jsonb,updated_at=clock_timestamp() WHERE work_unit_id=$1`, [workUnit.work_unit_id, workUnit.state, workUnit.fence, workUnit.attempt, json(workUnit.failure), workUnit.retry_after, json(workUnit.continuation), workUnit.last_execution_id, json(workUnit.last_turn)]);
      await client.query('DELETE FROM vnext_project_mutation_authority WHERE project_id=$1 AND work_unit_id=$2 AND execution_id=$3 AND fence=$4', [execution.project_id, workUnit.work_unit_id, execution.execution_id, execution.fence]);
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

  return { appendEvent, reconstruct, createWorkUnit, beginExecution, persistTurn, persistFailure, manifest, close };
}
