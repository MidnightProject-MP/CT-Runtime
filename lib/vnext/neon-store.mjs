import { Pool } from 'pg';
import { postgresBoundary } from './postgres-boundary.mjs';
import { admissionContext, baselineRequirements, digest, requirementsValue } from './operating-boundary.mjs';

const WORK_STATES = new Set(['actionable', 'waiting', 'review', 'terminal', 'cancelled']);

function json(value) { return value == null ? null : JSON.stringify(value); }

function sameTime(a, b) {
  return a != null && b != null && new Date(a).getTime() === new Date(b).getTime();
}

function workFromRow(row) {
  return {
    work_unit_id: row.work_unit_id,
    objective_ref: row.objective_ref,
    project_id: row.project_id,
    work_revision: Number(row.work_revision),
    requirements: row.requirements,
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
    admission: row.admission,
    execution_id: row.execution_id,
    work_unit_id: row.work_unit_id,
    project_id: row.project_id,
    owner: row.owner,
    authorization_decision_ref: row.authorization_decision_ref || null,
    fence: Number(row.fence),
    state: row.state,
    started_at: row.started_at.toISOString(),
    finished_at: row.finished_at ? row.finished_at.toISOString() : null,
    claim_expires_at: row.claim_expires_at ? row.claim_expires_at.toISOString() : null,
    attempt: Number(row.attempt || 1), failure: row.failure, retry_after: row.retry_after ? row.retry_after.toISOString() : null,
    launch: row.launch ?? null,
  };
}

export function createNeonStore({ connectionString, pool, applicationName = 'ct-runtime-vnext', authorizationVerifier = null, acceptanceVerifier = null, cancellationVerifier = null, pilotIntervalMs = 60000, maxConcurrency = null, now = Date.now } = {}) {
  if (!connectionString && !pool) throw new Error('Neon store requires an explicit PostgreSQL connection string or injected pool');
  if (maxConcurrency != null && (!Number.isInteger(maxConcurrency) || maxConcurrency < 1)) throw new Error('maxConcurrency must be a positive integer when configured');
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
      INSERT INTO vnext_work_units(work_unit_id,objective_ref,project_id,state,fence,claim_execution_id,claim_owner,claim_fence,claim_expires_at,attempt,failure,retry_after,continuation,last_execution_id,last_turn,created_at,updated_at,requirements)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13::jsonb,$14,$15::jsonb,$16,$17,$18::jsonb)`,
      [workUnit.work_unit_id, workUnit.objective_ref, workUnit.project_id, workUnit.state, workUnit.fence,
        workUnit.claim?.execution_id || null, workUnit.claim?.owner || null, workUnit.claim?.fence ?? null, workUnit.claim_expires_at || workUnit.claim?.claim_expires_at || null, workUnit.attempt || 0, json(workUnit.failure), workUnit.retry_after || null,
        json(workUnit.continuation), workUnit.last_execution_id || null, json(workUnit.last_turn), workUnit.created_at, new Date().toISOString(), json(requirementsValue(workUnit.requirements ?? baselineRequirements))]);
    return workUnit;
  }

  // Always serialize a project's transitions before taking Work Unit or
  // Execution row locks. Expired-holder cleanup may touch a different Work
  // Unit, so locking the candidate row first can deadlock with settlement.
  // A hash collision only serializes unrelated projects; it cannot grant authority.
  async function lockProject(client, projectId) {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`ct-runtime:vnext-project:${projectId}`]);
  }

  function cancellationDigest({ executionId, projectId, workUnitId, fence, decisionRef, reconciliationRequired = false }) {
    return digest({ execution_id: executionId, project_id: projectId, work_unit_id: workUnitId, fence, decision_ref: decisionRef, reconciliation_required: reconciliationRequired === true });
  }

  // Cancellation settlement is an explicit outcome: the attempt's result is
  // never accepted, its history stays, and any effect uncertainty remains
  // subject to reconciliation. It consumes the intent in the same transaction
  // that clears the claim and releases project exclusion.
  async function settleCancellation(client, workRow, executionRow, intent, failure = null) {
    const block = (await client.query('SELECT * FROM vnext_project_reconciliation_blocks WHERE project_id=$1 FOR UPDATE', [workRow.project_id])).rows[0];
    const uncertain = failure?.reconciliation_required === true || block?.execution_id === executionRow.execution_id;
    const failureValue = { message: 'Cancelled by an authorized intent.', reason: 'cancelled', ...(uncertain ? { reconciliation_required: true } : {}) };
    await client.query("UPDATE vnext_executions SET state='failed',finished_at=clock_timestamp(),failure=$2::jsonb,retry_after=NULL WHERE execution_id=$1", [executionRow.execution_id, json(failureValue)]);
    await client.query(`UPDATE vnext_work_units SET state='cancelled',claim_execution_id=NULL,claim_owner=NULL,claim_fence=NULL,claim_expires_at=NULL,failure=$2::jsonb,retry_after=NULL,last_execution_id=$3,updated_at=clock_timestamp() WHERE work_unit_id=$1`, [workRow.work_unit_id, uncertain ? json(failureValue) : null, executionRow.execution_id]);
    await client.query('UPDATE vnext_cancellation_intents SET consumed_by_execution_id=$2,consumed_at=clock_timestamp() WHERE work_unit_id=$1 AND work_revision=$3 AND consumed_at IS NULL', [workRow.work_unit_id, executionRow.execution_id, intent.work_revision]);
    if (uncertain && !block) {
      await client.query(`INSERT INTO vnext_project_reconciliation_blocks(project_id,work_unit_id,execution_id,fence,reason)
        VALUES ($1,$2,$3,$4,'external-effect-uncertain')`, [workRow.project_id, workRow.work_unit_id, executionRow.execution_id, executionRow.fence]);
    }
    await client.query('DELETE FROM vnext_project_mutation_authority WHERE project_id=$1 AND work_unit_id=$2 AND execution_id=$3 AND fence=$4', [workRow.project_id, workRow.work_unit_id, executionRow.execution_id, executionRow.fence]);
    await client.query('UPDATE vnext_pilot_progress SET next_wake_at=NULL,updated_at=clock_timestamp() WHERE work_unit_id=$1', [workRow.work_unit_id]);
    return { work_unit_id: workRow.work_unit_id, execution_id: executionRow.execution_id, cancellation_ref: intent.decision_ref, state: 'cancelled', effect_uncertainty: uncertain };
  }

  async function lockPendingCancellation(client, workUnitId, workRevision = null) {
    const query = workRevision == null
      ? 'SELECT * FROM vnext_cancellation_intents WHERE work_unit_id=$1 AND consumed_at IS NULL FOR UPDATE'
      : 'SELECT * FROM vnext_cancellation_intents WHERE work_unit_id=$1 AND work_revision=$2 AND consumed_at IS NULL FOR UPDATE';
    const params = workRevision == null ? [workUnitId] : [workUnitId, workRevision];
    return (await client.query(query, params)).rows[0] || null;
  }

  // A configured writer establishes the durable policy before admission so a
  // capacity refusal cannot roll the policy back with the refused attempt.
  // Initialization runs in its own transaction, serialized on the pool lock:
  // concurrent establishment resolves to one row, and a conflicting value
  // fails closed without writing. Admission takes the pool lock again and
  // re-reads the row, so an operator change between the two is never ignored.
  async function ensurePoolPolicy() {
    if (maxConcurrency == null) return;
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', ['ct-runtime:vnext-concurrency-pool']);
      const row = (await client.query("SELECT max_concurrency FROM vnext_pool_policy WHERE policy='coordinator-concurrency' FOR UPDATE")).rows[0];
      if (row) {
        const durable = row.max_concurrency == null ? null : Number(row.max_concurrency);
        if (durable !== maxConcurrency) throw new Error(`E_POOL_POLICY_CONFLICT: durable pool policy (${durable ?? 'unbounded'}) does not match coordinator configuration (${maxConcurrency})`);
      } else {
        await client.query("INSERT INTO vnext_pool_policy(policy,max_concurrency) VALUES ('coordinator-concurrency',$1) ON CONFLICT DO NOTHING", [maxConcurrency]);
      }
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
    finally { client.release(); }
  }

  async function beginExecution(workUnit, execution, authorizationDecision = null) {
    workUnit = structuredClone(workUnit);
    execution = structuredClone(execution);
    authorizationDecision = structuredClone(authorizationDecision);
    if (execution.work_unit_id !== workUnit.work_unit_id) throw new Error('execution belongs to a different Work Unit');
    if (execution.project_id !== workUnit.project_id) throw new Error('execution belongs to a different project');
    if (!execution.project_id) throw new Error('project_id is required');
    authorizationDecision = authorizationDecision || (execution.authorization_decision_ref ? { ref: execution.authorization_decision_ref } : null);
    if (!authorizationDecision?.ref || execution.authorization_decision_ref !== authorizationDecision.ref) throw new Error('mutation-bearing execution requires its authorization decision reference');
    if (typeof authorizationVerifier !== 'function') throw new Error('authorization verifier is required for mutation-bearing execution');
    await ensurePoolPolicy();
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      await lockProject(client, execution.project_id);
      const current = await client.query('SELECT * FROM vnext_work_units WHERE work_unit_id=$1 FOR UPDATE', [workUnit.work_unit_id]);
      if (!current.rows[0]) throw new Error('Work Unit does not exist');
      const row = current.rows[0];
      if (row.project_id !== execution.project_id) throw new Error('execution belongs to a different stored project');
      const expectedPreviousFence = execution.fence - 1;
      const expired = row.claim_execution_id && row.claim_expires_at && new Date(row.claim_expires_at).getTime() <= Date.now();
      if (row.claim_execution_id && !expired && !sameTime(row.claim_expires_at, execution.claim_expires_at)) throw new Error('execution claim expiration does not match Work Unit claim');
      if (!['actionable', 'waiting'].includes(row.state) || (row.claim_execution_id && !expired) || Number(row.fence) !== expectedPreviousFence) throw new Error('Work Unit changed before execution could be claimed');
      if (await lockPendingCancellation(client, workUnit.work_unit_id)) throw new Error('E_CANCELLED: Work Unit has a pending cancellation intent');
      if ((workUnit.work_revision ?? 1) !== Number(row.work_revision)) throw new Error('work revision changed before admission');
      const progress = (await client.query('SELECT * FROM vnext_pilot_progress WHERE work_unit_id=$1 FOR UPDATE', [workUnit.work_unit_id])).rows[0];
      let inputSeq = 0;
      let chosen = null;
      if (progress) {
        inputSeq = Number(workUnit.pilot?.input_seq);
        const latest = (await client.query('SELECT COALESCE(max(input_seq),0) AS seq FROM vnext_pilot_inputs WHERE work_unit_id=$1', [workUnit.work_unit_id])).rows[0];
        if (!Number.isSafeInteger(inputSeq) || inputSeq !== Number(latest.seq) || Number(progress.considered_proposal_id) !== workUnit.pilot.considered_proposal_id) throw new Error('pilot admission snapshot changed');
        if (workUnit.pilot.pending_proposal) {
          chosen = (await client.query('SELECT c.*,e.admission,e.finished_at FROM vnext_continuations c JOIN vnext_executions e USING(execution_id) WHERE c.id=$1 AND c.work_unit_id=$2 AND e.state=\'succeeded\' AND e.execution_id=$3 FOR UPDATE OF c,e', [workUnit.pilot.pending_proposal.id, workUnit.work_unit_id, row.last_execution_id])).rows[0];
          if (!chosen || Number(chosen.id) <= Number(progress.considered_proposal_id) || chosen.admission?.work_revision !== Number(row.work_revision)) throw new Error('continuation proposal changed before admission');
        }
        const freshInput = inputSeq > Number(progress.consumed_input_seq);
        const due = progress.next_wake_at && progress.next_wake_at.getTime() <= now();
        const continuationDue = chosen?.continuation.mode === 'immediate' && chosen.finished_at.getTime() + pilotIntervalMs <= now();
        if (!freshInput && !due && !continuationDue) throw new Error('pilot admission is not justified by current coordinator policy');
      }
      const admittedWork = { ...workFromRow(row), ...(workUnit.pilot ? { pilot: structuredClone(workUnit.pilot) } : {}) };
      const admission = admissionContext(admittedWork, execution, inputSeq);
      const verified = await authorizationVerifier(structuredClone(authorizationDecision), structuredClone({ workUnit: { ...admittedWork, fence: execution.fence }, execution: { ...execution, admission } }));
      if (verified !== true) throw new Error('authorization decision is not valid for this Execution');

      // With the project lock held, admission refuses any live effect authority.
      // An expired authority is never taken over here: elapsed time is not stop
      // confirmation. A present row means the predecessor attempt was never
      // settled by recovery, and only recovery (which deletes the row) may
      // release it after proving stop or recording reconciliation.
      const reconciliation = await client.query('SELECT * FROM vnext_project_reconciliation_blocks WHERE project_id=$1 FOR UPDATE', [execution.project_id]);
      if (reconciliation.rows[0]) throw new Error('E_RECONCILIATION_REQUIRED: project has unresolved external-effect uncertainty');
      const existingAuthority = await client.query('SELECT * FROM vnext_project_mutation_authority WHERE project_id=$1 FOR UPDATE', [execution.project_id]);
      if (existingAuthority.rows[0]) {
        if (new Date(existingAuthority.rows[0].claim_expires_at).getTime() > Date.now()) throw new Error('E_PROJECT_AUTH_HELD: project mutation authority is already held');
        throw new Error('E_RECONCILIATION_REQUIRED: expired external effects require stop confirmation or reconciliation');
      }
      // An expired claim still bound to an unsettled attempt is
      // stop-unconfirmed: the Work Unit's next claim may only follow a
      // recovery settlement, which clears the claim in the same transaction
      // that records the proof. A claim bound to an already-settled
      // (legacy pre-A8) execution is inert bookkeeping and stays supersedable.
      if (expired) {
        const predecessor = (await client.query('SELECT state FROM vnext_executions WHERE execution_id=$1', [row.claim_execution_id])).rows[0];
        if (!predecessor || ['created', 'running'].includes(predecessor.state)) throw new Error('E_RECONCILIATION_REQUIRED: expired external effects require stop confirmation or reconciliation');
      }

      // Pool accounting derives from the mutation authorities themselves: each
      // row is one occupied slot for exactly as long as the attempt holds
      // authority (including an expired, stop-unconfirmed predecessor, which
      // releases only through recovery). There is no second table to orphan.
      // The pool lock serializes policy resolution, count, and admission while
      // each admission still holds only its own project lock, so lock order
      // stays project-then-pool everywhere and cannot deadlock. Settlement
      // never takes the pool lock: a committed authority delete is simply
      // absent from the next count. Establishment already committed in its own
      // transaction (ensurePoolPolicy), so a refused admission never rolls the
      // shared bound back; this read only adopts or verifies it.
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', ['ct-runtime:vnext-concurrency-pool']);
      const policyRow = (await client.query("SELECT max_concurrency FROM vnext_pool_policy WHERE policy='coordinator-concurrency'")).rows[0];
      const effective = policyRow ? (policyRow.max_concurrency == null ? null : Number(policyRow.max_concurrency)) : null;
      if (maxConcurrency != null && maxConcurrency !== effective) {
        throw new Error(`E_POOL_POLICY_CONFLICT: durable pool policy (${effective ?? 'unbounded'}) does not match coordinator configuration (${maxConcurrency})`);
      }
      if (effective != null) {
        const used = Number((await client.query('SELECT count(*) AS count FROM vnext_project_mutation_authority')).rows[0].count);
        if (used >= effective) throw new Error('E_CONCURRENCY_LIMIT: the coordinator concurrency pool is exhausted');
      }

      const inserted = await client.query(`INSERT INTO vnext_executions(execution_id,work_unit_id,project_id,owner,fence,state,started_at,finished_at,claim_expires_at,authorization_decision_ref,attempt,failure,retry_after) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13) RETURNING *`, [execution.execution_id, execution.work_unit_id, execution.project_id, execution.owner, execution.fence, execution.state, execution.started_at, execution.finished_at, execution.claim_expires_at, execution.authorization_decision_ref, execution.attempt, json(execution.failure), execution.retry_after]);
      await client.query('UPDATE vnext_executions SET admission=$2::jsonb WHERE execution_id=$1', [execution.execution_id, json(admission)]);
      inserted.rows[0].admission = admission;
      if (chosen) {
        await client.query('UPDATE vnext_pilot_progress SET considered_proposal_id=$2 WHERE work_unit_id=$1', [workUnit.work_unit_id, chosen.id]);
        admittedWork.pilot.considered_proposal_id = Number(chosen.id);
      }
      const authorityInserted = await client.query('INSERT INTO vnext_project_mutation_authority(project_id,work_unit_id,execution_id,fence,owner,claim_expires_at,authorization_decision_ref) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING RETURNING *', [execution.project_id, workUnit.work_unit_id, execution.execution_id, execution.fence, execution.owner, execution.claim_expires_at, execution.authorization_decision_ref]);
      if (authorityInserted.rowCount !== 1) throw new Error('E_PROJECT_AUTH_HELD: project mutation authority is already held');

      await client.query(`UPDATE vnext_work_units SET state='actionable',fence=$2,claim_execution_id=$3,claim_owner=$4,claim_fence=$2,claim_expires_at=$5,attempt=$6,updated_at=clock_timestamp() WHERE work_unit_id=$1`, [workUnit.work_unit_id, execution.fence, execution.execution_id, execution.owner, execution.claim_expires_at, execution.attempt]);
      await client.query('COMMIT');
      return { workUnit: { ...admittedWork, project_id: execution.project_id, state: 'actionable', fence: execution.fence, claim_expires_at: execution.claim_expires_at, attempt: execution.attempt, claim: { execution_id: execution.execution_id, owner: execution.owner, fence: execution.fence, claim_expires_at: execution.claim_expires_at } }, execution: executionFromRow(inserted.rows[0]) };
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
      await lockProject(client, execution.project_id);
      const current = await client.query('SELECT * FROM vnext_work_units WHERE work_unit_id=$1 FOR UPDATE', [workUnit.work_unit_id]);
      const authority = await client.query('SELECT * FROM vnext_project_mutation_authority WHERE project_id=$1 FOR UPDATE', [execution.project_id]);
      const exec = await client.query('SELECT * FROM vnext_executions WHERE execution_id=$1 AND work_unit_id=$2 AND project_id=$3 AND owner=$4 AND fence=$5 FOR UPDATE', [execution.execution_id, workUnit.work_unit_id, workUnit.project_id, execution.owner, execution.fence]);
      if (!current.rows[0] || !authority.rows[0] || authority.rows[0].work_unit_id !== workUnit.work_unit_id || authority.rows[0].execution_id !== execution.execution_id || Number(authority.rows[0].fence) !== execution.fence || authority.rows[0].owner !== execution.owner || authority.rows[0].authorization_decision_ref !== execution.authorization_decision_ref || Number(current.rows[0].fence) !== execution.fence || current.rows[0].claim_execution_id !== execution.execution_id || current.rows[0].claim_owner !== execution.owner || Number(current.rows[0].claim_fence) !== execution.fence || !sameTime(current.rows[0].claim_expires_at, execution.claim_expires_at) || !exec.rows[0] || exec.rows[0].authorization_decision_ref !== execution.authorization_decision_ref || !['created', 'running'].includes(exec.rows[0].state) || !sameTime(exec.rows[0].claim_expires_at, execution.claim_expires_at)) throw new Error('fencing conflict while persisting failure');
      if (new Date(authority.rows[0].claim_expires_at).getTime() <= Date.now()) throw new Error('fencing conflict while persisting failure: project mutation authority expired');
      const admissionRevision = Number(exec.rows[0]?.admission?.work_revision ?? current.rows[0].work_revision);
      const cancellation = await lockPendingCancellation(client, workUnit.work_unit_id, admissionRevision);
      if (cancellation) {
        const cancelled = await settleCancellation(client, current.rows[0], exec.rows[0], cancellation, execution.failure ?? workUnit.failure);
        await client.query('COMMIT');
        return { ...failed, cancelled: true, state: 'cancelled', cancellation_ref: cancellation.decision_ref };
      }
      await client.query('UPDATE vnext_executions SET state=$2,finished_at=$3,failure=$4::jsonb,retry_after=$5 WHERE execution_id=$1 AND work_unit_id=$6 AND project_id=$7 AND owner=$8 AND fence=$9', [execution.execution_id, execution.state, execution.finished_at, json(execution.failure), execution.retry_after, workUnit.work_unit_id, workUnit.project_id, execution.owner, execution.fence]);
      await client.query(`UPDATE vnext_work_units SET state=$2,fence=$3,claim_execution_id=NULL,claim_owner=NULL,claim_fence=NULL,claim_expires_at=NULL,attempt=$4,failure=$5::jsonb,retry_after=$6,continuation=$7::jsonb,last_execution_id=$8,last_turn=$9::jsonb,updated_at=clock_timestamp() WHERE work_unit_id=$1`, [workUnit.work_unit_id, workUnit.state, workUnit.fence, workUnit.attempt, json(workUnit.failure), workUnit.retry_after, json(workUnit.continuation), workUnit.last_execution_id, json(workUnit.last_turn)]);
      const uncertain = failed.execution.failure?.reconciliation_required === true || failed.workUnit.failure?.reconciliation_required === true;
      if (uncertain) {
        await client.query(`INSERT INTO vnext_project_reconciliation_blocks(project_id,work_unit_id,execution_id,fence,reason)
          VALUES ($1,$2,$3,$4,'external-effect-uncertain')`, [execution.project_id, workUnit.work_unit_id, execution.execution_id, execution.fence]);
      }
      await client.query('DELETE FROM vnext_project_mutation_authority WHERE project_id=$1 AND work_unit_id=$2 AND execution_id=$3 AND fence=$4', [execution.project_id, workUnit.work_unit_id, execution.execution_id, execution.fence]);
      await client.query('COMMIT');
      return failed;
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
    finally { client.release(); }
  }

  // Explicit cancellation settlement for an attempt no longer owned by a live
  // runner: recovery calls it after proving the process group stopped. The
  // result is never accepted; effect uncertainty still blocks project reuse.
  async function persistCancelled(cancelled, { recovery = false } = {}) {
    const { workUnit, execution, reconciliationRequired = false } = cancelled;
    if (execution.work_unit_id !== workUnit.work_unit_id) throw new Error('execution belongs to a different Work Unit');
    if (execution.project_id !== workUnit.project_id) throw new Error('execution belongs to a different project');
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      await lockProject(client, execution.project_id);
      const current = await client.query('SELECT * FROM vnext_work_units WHERE work_unit_id=$1 FOR UPDATE', [workUnit.work_unit_id]);
      const authority = await client.query('SELECT * FROM vnext_project_mutation_authority WHERE project_id=$1 FOR UPDATE', [execution.project_id]);
      const exec = await client.query('SELECT * FROM vnext_executions WHERE execution_id=$1 AND work_unit_id=$2 AND project_id=$3 AND owner=$4 AND fence=$5 FOR UPDATE', [execution.execution_id, workUnit.work_unit_id, workUnit.project_id, execution.owner, execution.fence]);
      const admissionRevision = Number(exec.rows[0]?.admission?.work_revision ?? current.rows[0]?.work_revision ?? 1);
      const intent = (await client.query('SELECT * FROM vnext_cancellation_intents WHERE work_unit_id=$1 AND work_revision=$2 FOR UPDATE', [workUnit.work_unit_id, admissionRevision])).rows[0];
      if (!intent) throw new Error('no cancellation intent exists for this attempt revision');
      const key = `cancelled:${execution.execution_id}`;
      const hash = cancellationDigest({ executionId: execution.execution_id, projectId: execution.project_id, workUnitId: workUnit.work_unit_id, fence: execution.fence, decisionRef: intent.decision_ref, reconciliationRequired });
      const prior = (await client.query('SELECT payload FROM vnext_events WHERE event_id=$1', [key])).rows[0]?.payload;
      if (prior) {
        if (prior.digest !== hash) throw new Error('cancellation settlement content conflict');
        await client.query('COMMIT');
        return prior.result;
      }
      if (intent.consumed_at) throw new Error('cancellation intent was already consumed by another attempt');
      if (!current.rows[0] || !authority.rows[0] || authority.rows[0].work_unit_id !== workUnit.work_unit_id || authority.rows[0].execution_id !== execution.execution_id || Number(authority.rows[0].fence) !== execution.fence || authority.rows[0].owner !== execution.owner || authority.rows[0].authorization_decision_ref !== execution.authorization_decision_ref || Number(current.rows[0].fence) !== execution.fence || current.rows[0].claim_execution_id !== execution.execution_id || current.rows[0].claim_owner !== execution.owner || Number(current.rows[0].claim_fence) !== execution.fence || !sameTime(current.rows[0].claim_expires_at, execution.claim_expires_at) || !exec.rows[0] || exec.rows[0].authorization_decision_ref !== execution.authorization_decision_ref || !['created', 'running'].includes(exec.rows[0].state) || !sameTime(exec.rows[0].claim_expires_at, execution.claim_expires_at)) throw new Error('fencing conflict while settling cancellation');
      if (recovery && !(current.rows[0].claim_expires_at && current.rows[0].claim_expires_at.getTime() <= Date.now())) throw new Error('fencing conflict while settling cancellation: claim is still active');
      if (!recovery && new Date(authority.rows[0].claim_expires_at).getTime() <= Date.now()) throw new Error('fencing conflict while settling cancellation: project mutation authority expired');
      const result = await settleCancellation(client, current.rows[0], exec.rows[0], intent, { reconciliation_required: reconciliationRequired === true });
      await client.query('INSERT INTO vnext_events(event_id,event_type,payload) VALUES ($1,$2,$3::jsonb)', [key, 'execution.cancelled', JSON.stringify({ digest: hash, result })]);
      await client.query('COMMIT');
      return result;
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
    finally { client.release(); }
  }

  // An attempt whose admission no longer matches the current material
  // requirements cannot settle. This explicitly retires that attempt — keeping
  // its history — and releases exclusion for the current revision instead of
  // leaving the project frozen behind an unreconcilable claim.
  async function persistSuperseded(superseded, { recovery = false } = {}) {
    const { workUnit, execution } = superseded;
    if (execution.work_unit_id !== workUnit.work_unit_id) throw new Error('execution belongs to a different Work Unit');
    if (execution.project_id !== workUnit.project_id) throw new Error('execution belongs to a different project');
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      await lockProject(client, execution.project_id);
      const current = await client.query('SELECT * FROM vnext_work_units WHERE work_unit_id=$1 FOR UPDATE', [workUnit.work_unit_id]);
      const authority = await client.query('SELECT * FROM vnext_project_mutation_authority WHERE project_id=$1 FOR UPDATE', [execution.project_id]);
      const exec = await client.query('SELECT * FROM vnext_executions WHERE execution_id=$1 AND work_unit_id=$2 AND project_id=$3 AND owner=$4 AND fence=$5 FOR UPDATE', [execution.execution_id, workUnit.work_unit_id, workUnit.project_id, execution.owner, execution.fence]);
      const key = `superseded:${execution.execution_id}`;
      // Request identity uses only the stable attempt binding. The observed
      // superseding revision belongs to the recorded result: a later revision
      // must not retroactively change a committed transition's identity.
      const hash = digest({ execution_id: execution.execution_id, work_unit_id: workUnit.work_unit_id, project_id: execution.project_id, fence: execution.fence });
      const prior = (await client.query('SELECT payload FROM vnext_events WHERE event_id=$1', [key])).rows[0]?.payload;
      if (prior) {
        if (prior.digest !== hash) throw new Error('supersession content conflict');
        await client.query('COMMIT');
        return prior.result;
      }
      if (!current.rows[0] || !authority.rows[0] || authority.rows[0].work_unit_id !== workUnit.work_unit_id || authority.rows[0].execution_id !== execution.execution_id || Number(authority.rows[0].fence) !== execution.fence || authority.rows[0].owner !== execution.owner || authority.rows[0].authorization_decision_ref !== execution.authorization_decision_ref || Number(current.rows[0].fence) !== execution.fence || current.rows[0].claim_execution_id !== execution.execution_id || current.rows[0].claim_owner !== execution.owner || Number(current.rows[0].claim_fence) !== execution.fence || !sameTime(current.rows[0].claim_expires_at, execution.claim_expires_at) || !exec.rows[0] || exec.rows[0].authorization_decision_ref !== execution.authorization_decision_ref || !['created', 'running'].includes(exec.rows[0].state) || !sameTime(exec.rows[0].claim_expires_at, execution.claim_expires_at)) throw new Error('fencing conflict while superseding attempt');
      if (!recovery && new Date(authority.rows[0].claim_expires_at).getTime() <= Date.now()) throw new Error('fencing conflict while superseding attempt: project mutation authority expired');
      if (recovery && !(current.rows[0].claim_expires_at && current.rows[0].claim_expires_at.getTime() <= Date.now())) throw new Error('fencing conflict while recovering supersession: claim is still active');
      const workRevision = Number(current.rows[0].work_revision);
      if (!exec.rows[0].admission || workRevision <= Number(exec.rows[0].admission.work_revision)) throw new Error('attempt is not superseded by a newer work revision');
      const result = { work_unit_id: workUnit.work_unit_id, execution_id: execution.execution_id, fence: execution.fence, superseded_by_revision: workRevision, state: 'actionable' };
      await client.query("UPDATE vnext_executions SET state='failed',finished_at=clock_timestamp(),failure=$2::jsonb,retry_after=NULL WHERE execution_id=$1", [execution.execution_id, json({ message: 'Execution superseded by a material requirements revision.', reason: 'requirements-revision' })]);
      await client.query("UPDATE vnext_work_units SET state='actionable',claim_execution_id=NULL,claim_owner=NULL,claim_fence=NULL,claim_expires_at=NULL,failure=NULL,retry_after=NULL,last_execution_id=$2,updated_at=clock_timestamp() WHERE work_unit_id=$1", [workUnit.work_unit_id, execution.execution_id]);
      await client.query('UPDATE vnext_pilot_progress SET next_wake_at=clock_timestamp(),updated_at=clock_timestamp() WHERE work_unit_id=$1', [workUnit.work_unit_id]);
      await client.query('DELETE FROM vnext_project_mutation_authority WHERE project_id=$1 AND work_unit_id=$2 AND execution_id=$3 AND fence=$4', [execution.project_id, workUnit.work_unit_id, execution.execution_id, execution.fence]);
      await client.query('INSERT INTO vnext_events(event_id,event_type,payload) VALUES ($1,$2,$3::jsonb)', [key, 'execution.superseded', JSON.stringify({ digest: hash, result })]);
      await client.query('COMMIT');
      return result;
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
    finally { client.release(); }
  }

  async function reconcileFailure({ projectId, workUnitId, executionId, fence, resolution } = {}) {
    if (!projectId || !workUnitId || !executionId || !Number.isInteger(fence) || fence < 1) throw new Error('reconciliation identity is required');
    if (!['no_effect', 'effect_applied'].includes(resolution)) throw new Error('reconciliation resolution must be no_effect or effect_applied');
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      await lockProject(client, projectId);
      const key = `reconciliation:${executionId}`;
      const hash = digest({ projectId, workUnitId, executionId, fence, resolution });
      const prior = (await client.query('SELECT payload FROM vnext_events WHERE event_id=$1', [key])).rows[0]?.payload;
      if (prior) {
        if (prior.digest !== hash) throw new Error('reconciliation content conflict');
        await client.query('COMMIT');
        return prior.result;
      }
      const block = await client.query('SELECT * FROM vnext_project_reconciliation_blocks WHERE project_id=$1 FOR UPDATE', [projectId]);
      if (!block.rows[0] || block.rows[0].work_unit_id !== workUnitId || block.rows[0].execution_id !== executionId || Number(block.rows[0].fence) !== fence) throw new Error('reconciliation identity does not match durable project block');
      const execution = await client.query('SELECT * FROM vnext_executions WHERE execution_id=$1 AND work_unit_id=$2 AND project_id=$3 AND fence=$4 FOR UPDATE', [executionId, workUnitId, projectId, fence]);
      if (!execution.rows[0] || execution.rows[0].state !== 'failed' || execution.rows[0].failure?.reconciliation_required !== true) throw new Error('execution is not awaiting reconciliation');
      const work = await client.query('SELECT * FROM vnext_work_units WHERE work_unit_id=$1 AND project_id=$2 FOR UPDATE', [workUnitId, projectId]);
      // Reconciliation depends on the authoritative block and failed-attempt
      // binding, not on the mutable presentation state: intent updates may
      // legitimately change the label while the block is pending.
      if (!work.rows[0] || work.rows[0].last_execution_id !== executionId) throw new Error('Work Unit is not awaiting reconciliation');
      // Resolving effect uncertainty is not an authorization to reactivate.
      // When the block belongs to a cancelled revision, the Work Unit stays
      // cancelled until a new material revision is authorized.
      const cancelledRevision = (await client.query('SELECT work_revision FROM vnext_cancellation_intents WHERE work_unit_id=$1 AND consumed_by_execution_id=$2', [workUnitId, executionId])).rows[0];
      const cancellationGoverns = cancelledRevision && Number(cancelledRevision.work_revision) === Number(work.rows[0].work_revision);
      const nextState = cancellationGoverns ? 'cancelled' : resolution === 'no_effect' ? 'actionable' : 'review';
      const result = { projectId, workUnitId, executionId, fence, resolution, state: nextState };
      await client.query('UPDATE vnext_work_units SET state=$2,failure=NULL,retry_after=NULL,updated_at=clock_timestamp() WHERE work_unit_id=$1', [workUnitId, nextState]);
      await client.query('DELETE FROM vnext_project_reconciliation_blocks WHERE project_id=$1 AND work_unit_id=$2 AND execution_id=$3 AND fence=$4', [projectId, workUnitId, executionId, fence]);
      // The resolution is the coordinator's recovery opportunity: with the
      // uncertainty gone, an affected non-cancelled Work Unit gets a fresh
      // coordinator-owned due time so a cold restart can discover and resume it.
      if (resolution === 'no_effect' && nextState !== 'cancelled') await client.query('UPDATE vnext_pilot_progress SET next_wake_at=clock_timestamp(),updated_at=clock_timestamp() WHERE work_unit_id=$1', [workUnitId]);
      await client.query('INSERT INTO vnext_events(event_id,event_type,payload) VALUES ($1,$2,$3::jsonb)', [key, 'reconciliation.recorded', JSON.stringify({ digest: hash, result })]);
      await client.query('COMMIT');
      return result;
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
    finally { client.release(); }
  }

  // Durable launch identity: recorded between admission and worker completion.
  // Exact replay with the same identity is idempotent; divergent content for the
  // same attempt fails closed. An active claim and unexpired authority are
  // required, so a settled or superseded attempt can never acquire a record
  // retroactively.
  async function recordLaunch(workUnit, execution, identity) {
    if (!identity || !Number.isInteger(identity.pid) || identity.pid <= 1 || !Number.isInteger(identity.pgid) || identity.pgid <= 1) throw new Error('launch identity requires pid and pgid');
    if (identity.start_ticks != null && !/^\d+$/.test(String(identity.start_ticks))) throw new Error('launch identity start_ticks must be numeric');
    if (identity.boot_id != null && (typeof identity.boot_id !== 'string' || identity.boot_id.length > 128)) throw new Error('launch identity boot_id must be bounded');
    if (typeof identity.started_at !== 'string' || Number.isNaN(Date.parse(identity.started_at))) throw new Error('launch identity requires started_at');
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      await lockProject(client, execution.project_id);
      const current = (await client.query('SELECT * FROM vnext_work_units WHERE work_unit_id=$1 FOR UPDATE', [workUnit.work_unit_id])).rows[0];
      const authority = (await client.query('SELECT * FROM vnext_project_mutation_authority WHERE project_id=$1 FOR UPDATE', [execution.project_id])).rows[0];
      const stored = (await client.query('SELECT * FROM vnext_executions WHERE execution_id=$1 FOR UPDATE', [execution.execution_id])).rows[0];
      if (!current || !authority || !stored || authority.work_unit_id !== workUnit.work_unit_id || authority.execution_id !== execution.execution_id || Number(authority.fence) !== execution.fence || authority.owner !== execution.owner || authority.authorization_decision_ref !== execution.authorization_decision_ref || Number(current.fence) !== execution.fence || current.claim_execution_id !== execution.execution_id || current.claim_owner !== execution.owner || !sameTime(current.claim_expires_at, execution.claim_expires_at) || stored.work_unit_id !== workUnit.work_unit_id || stored.project_id !== execution.project_id || stored.owner !== execution.owner || stored.authorization_decision_ref !== execution.authorization_decision_ref || Number(stored.fence) !== execution.fence || !['created', 'running'].includes(stored.state)) throw new Error('fencing conflict while recording launch');
      if (new Date(authority.claim_expires_at).getTime() <= Date.now()) throw new Error('fencing conflict while recording launch: project mutation authority expired');
      if (stored.launch && digest(stored.launch) !== digest(identity)) throw new Error('launch content conflict');
      if (!stored.launch) await client.query('UPDATE vnext_executions SET launch=$2::jsonb WHERE execution_id=$1', [execution.execution_id, JSON.stringify(identity)]);
      await client.query('COMMIT');
      return { execution_id: execution.execution_id, launch: identity };
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
    finally { client.release(); }
  }

  // In-doubt attempts: an expired claim still bound to an execution that never
  // reached a terminal state and whose project has no pending reconciliation.
  // These are what a restarted coordinator must classify before any admission.
  async function listInDoubtAttempts(projectId) {
    const rows = (await db.query(`SELECT w.work_unit_id, e.execution_id FROM vnext_executions e JOIN vnext_work_units w ON w.claim_execution_id = e.execution_id
      WHERE e.project_id=$1 AND w.claim_expires_at IS NOT NULL AND w.claim_expires_at <= clock_timestamp() AND e.state IN ('created','running')
        AND NOT EXISTS (SELECT 1 FROM vnext_project_reconciliation_blocks r WHERE r.project_id=e.project_id)
      ORDER BY w.updated_at, w.work_unit_id LIMIT 100`, [projectId])).rows;
    const attempts = [];
    for (const row of rows) {
      const workRow = (await db.query('SELECT * FROM vnext_work_units WHERE work_unit_id=$1', [row.work_unit_id])).rows[0];
      const executionRow = (await db.query('SELECT * FROM vnext_executions WHERE execution_id=$1', [row.execution_id])).rows[0];
      if (workRow && executionRow) attempts.push({ work: workFromRow(workRow), execution: executionFromRow(executionRow) });
    }
    return attempts;
  }

  // Pool occupancy is a derived view of the authority rows - exactly the one
  // fact that says an attempt occupies a slot - so inspection can never
  // disagree with enforcement.
  async function listReservations() {
    const rows = (await db.query('SELECT project_id,work_unit_id,execution_id,fence,owner FROM vnext_project_mutation_authority ORDER BY project_id LIMIT 100')).rows;
    return rows.map((row) => ({ project_id: row.project_id, work_unit_id: row.work_unit_id, execution_id: row.execution_id, fence: Number(row.fence), owner: row.owner }));
  }

  // Settlement of an expired in-doubt attempt. 'not-launched' proves no worker
  // was ever confirmed and is the only outcome that may retry; 'uncertain'
  // records a durable reconciliation block before anything may run again.
  // Exact replay returns the recorded outcome; divergent content fails closed.
  async function recoverAttempt({ projectId, workUnitId, executionId, fence, resolution, reason } = {}) {
    if (!projectId || !workUnitId || !executionId || !Number.isInteger(fence) || fence < 1) throw new Error('recovery identity is required');
    if (!['not-launched', 'uncertain'].includes(resolution)) throw new Error('recovery resolution must be not-launched or uncertain');
    if (resolution === 'uncertain' && (typeof reason !== 'string' || !reason.trim() || reason.length > 200)) throw new Error('uncertain recovery requires a bounded reason');
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      await lockProject(client, projectId);
      const key = `recovered:${executionId}`;
      const hash = digest({ projectId, workUnitId, executionId, fence, resolution, reason: resolution === 'uncertain' ? reason : null });
      const prior = (await client.query('SELECT payload FROM vnext_events WHERE event_id=$1', [key])).rows[0]?.payload;
      if (prior) {
        if (prior.digest !== hash) throw new Error('recovery content conflict');
        await client.query('COMMIT');
        return prior.result;
      }
      const work = (await client.query('SELECT * FROM vnext_work_units WHERE work_unit_id=$1 AND project_id=$2 FOR UPDATE', [workUnitId, projectId])).rows[0];
      const execution = (await client.query('SELECT * FROM vnext_executions WHERE execution_id=$1 AND work_unit_id=$2 AND project_id=$3 AND fence=$4 FOR UPDATE', [executionId, workUnitId, projectId, fence])).rows[0];
      if (!work || work.claim_execution_id !== executionId || Number(work.claim_fence) !== fence || !work.claim_expires_at || work.claim_expires_at.getTime() > Date.now()) throw new Error('recovery identity does not match an expired durable claim');
      if (!execution || !['created', 'running'].includes(execution.state) || execution.authorization_decision_ref == null) throw new Error('execution is not awaiting recovery');
      if (resolution === 'not-launched' && execution.launch != null) throw new Error('not-launched resolution conflicts with a recorded launch identity');
      if ((await client.query('SELECT 1 FROM vnext_project_reconciliation_blocks WHERE project_id=$1 FOR UPDATE', [projectId])).rowCount) throw new Error('project reconciliation is already pending');
      const authority = (await client.query('SELECT * FROM vnext_project_mutation_authority WHERE project_id=$1 FOR UPDATE', [projectId])).rows[0];
      if (authority && (authority.work_unit_id !== workUnitId || authority.execution_id !== executionId || Number(authority.fence) !== fence)) throw new Error('fencing conflict while recovering attempt');
      const notLaunched = resolution === 'not-launched';
      const attemptNumber = Number(work.attempt || execution.attempt || 1);
      const retryable = notLaunched && attemptNumber < 3;
      const failure = notLaunched
        ? { message: 'Execution was never launched; safely retryable.', reason: 'not-launched', recovered: true }
        : { message: 'Dispatch outcome requires reconciliation before resuming.', reason, recovered: true, reconciliation_required: true };
      const stateName = retryable ? 'waiting' : 'review';
      const result = { projectId, workUnitId, executionId, fence, resolution, state: stateName, attempt: attemptNumber };
      await client.query("UPDATE vnext_executions SET state='failed',finished_at=clock_timestamp(),failure=$2::jsonb,retry_after=NULL WHERE execution_id=$1", [executionId, json(failure)]);
      await client.query('UPDATE vnext_work_units SET state=$2,claim_execution_id=NULL,claim_owner=NULL,claim_fence=NULL,claim_expires_at=NULL,failure=$3::jsonb,retry_after=$4,last_execution_id=$5,updated_at=clock_timestamp() WHERE work_unit_id=$1', [workUnitId, stateName, json(failure), retryable ? new Date().toISOString() : null, executionId]);
      if (retryable) await client.query('UPDATE vnext_pilot_progress SET next_wake_at=clock_timestamp(),updated_at=clock_timestamp() WHERE work_unit_id=$1', [workUnitId]);
      if (!notLaunched) await client.query("INSERT INTO vnext_project_reconciliation_blocks(project_id,work_unit_id,execution_id,fence,reason) VALUES ($1,$2,$3,$4,'external-effect-uncertain')", [projectId, workUnitId, executionId, fence]);
      if (authority) await client.query('DELETE FROM vnext_project_mutation_authority WHERE project_id=$1 AND execution_id=$2 AND fence=$3', [projectId, executionId, fence]);
      await client.query('INSERT INTO vnext_events(event_id,event_type,payload) VALUES ($1,$2,$3::jsonb)', [key, 'execution.recovered', JSON.stringify({ digest: hash, result })]);
      await client.query('COMMIT');
      return result;
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
    finally { client.release(); }
  }

  async function manifest(executionId) {
    const result = await db.query('SELECT state FROM vnext_executions WHERE execution_id=$1', [executionId]);
    const row = result.rows[0];
    return row ? { execution: { status: row.state === 'succeeded' ? 'success' : row.state } } : null;
  }

  async function close() { if (ownsPool) await db.end(); }

  return { appendEvent, reconstruct, createWorkUnit, beginExecution, persistFailure, persistCancelled, persistSuperseded, reconcileFailure, recordLaunch, listInDoubtAttempts, listReservations, recoverAttempt, manifest, close,
    ...postgresBoundary({ db, lockProject, workFromRow, executionFromRow, acceptanceVerifier, cancellationVerifier, settleCancellation, cancellationDigest }) };
}
