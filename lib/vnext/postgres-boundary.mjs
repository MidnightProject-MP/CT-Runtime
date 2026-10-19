import { acceptanceContext, validateAcceptanceDecision, digest, settlement, settlementIdentity, requirementsValue } from './operating-boundary.mjs';

// Shares the core store's project lock namespace and row projections. All reads
// used for acceptance are made under the same serialization as intake/admission.
export function postgresBoundary({ db, lockProject, workFromRow, executionFromRow, acceptanceVerifier, cancellationVerifier, settleCancellation, cancellationDigest }) {
  async function transaction(workId, operation) {
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      const identity = await client.query('SELECT project_id FROM vnext_work_units WHERE work_unit_id=$1', [workId]);
      if (!identity.rows[0]) throw new Error('Work Unit does not exist');
      await lockProject(client, identity.rows[0].project_id);
      const row = (await client.query('SELECT * FROM vnext_work_units WHERE work_unit_id=$1 FOR UPDATE', [workId])).rows[0];
      const value = await operation(client, workFromRow(row));
      await client.query('COMMIT');
      return value;
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
    finally { client.release(); }
  }
  async function receipt(client, eventId, contentDigest) {
    const prior = (await client.query('SELECT payload FROM vnext_events WHERE event_id=$1', [eventId])).rows[0]?.payload;
    if (prior && prior.digest !== contentDigest) throw new Error('receipt content conflict');
    return prior?.result;
  }
  async function saveReceipt(client, eventId, type, contentDigest, result) {
    await client.query('INSERT INTO vnext_events(event_id,event_type,payload) VALUES ($1,$2,$3::jsonb)', [eventId, type, JSON.stringify({ digest: contentDigest, result })]);
  }
  async function inspectReceipt(eventId, contentDigest) {
    const client = await db.connect();
    try { return await receipt(client, eventId, contentDigest); }
    finally { client.release(); }
  }
  async function inspectCancellation(workUnitId) {
    const client = await db.connect();
    try { return (await client.query('SELECT * FROM vnext_cancellation_intents WHERE work_unit_id=$1', [workUnitId])).rows[0]; }
    finally { client.release(); }
  }
  async function assertUnclaimed(client, work) {
    if (work.claim) throw new Error('acceptance cannot run against claimed work');
    if ((await client.query('SELECT 1 FROM vnext_project_mutation_authority WHERE project_id=$1 FOR UPDATE', [work.project_id])).rowCount) throw new Error('project authority is held');
    if ((await client.query('SELECT 1 FROM vnext_project_reconciliation_blocks WHERE project_id=$1 FOR UPDATE', [work.project_id])).rowCount) throw new Error('reconciliation is required');
  }
  async function snapshot(client, work) {
    await assertUnclaimed(client, work);
    const exec = (await client.query('SELECT * FROM vnext_executions WHERE execution_id=$1 FOR UPDATE', [work.last_execution_id])).rows[0];
    const refs = await client.query('SELECT evidence FROM vnext_evidence_refs WHERE work_unit_id=$1 AND execution_id=$2 ORDER BY id FOR UPDATE', [work.work_unit_id, work.last_execution_id]);
    const input = await client.query('SELECT COALESCE(max(input_seq),0) AS seq FROM vnext_pilot_inputs WHERE work_unit_id=$1', [work.work_unit_id]);
    const record = (await client.query('SELECT payload FROM vnext_events WHERE event_id=$1 FOR SHARE', [`handoff:${work.last_execution_id}`])).rows[0]?.payload?.result;
    const pilot = await client.query('SELECT 1 FROM vnext_pilot_progress WHERE work_unit_id=$1 FOR UPDATE', [work.work_unit_id]);
    if (pilot.rowCount) {
      const result = (await client.query('SELECT turn FROM vnext_pilot_results WHERE work_unit_id=$1 AND execution_id=$2 FOR SHARE', [work.work_unit_id, work.last_execution_id])).rows[0];
      if (!result || digest(result.turn) !== digest(work.last_turn)) throw new Error('pilot result does not match completion claim');
    }
    return acceptanceContext(work, exec && executionFromRow(exec), refs.rows.map(r => r.evidence), Number(input.rows[0].seq), record);
  }
  return {
    async persistTurn(input, { recovery = false } = {}) {
      const result = structuredClone(input);
      if (result.execution.work_unit_id !== result.workUnit.work_unit_id) throw new Error('execution belongs to a different Work Unit');
      if (result.execution.project_id !== result.workUnit.project_id) throw new Error('execution belongs to a different project');
      const key = `handoff:${result.execution.execution_id}`;
      const hash = settlementIdentity(result);
      try {
        return await transaction(result.workUnit.work_unit_id, async (client, work) => {
          const prior = await receipt(client, key, hash);
          if (prior) return prior;
          const execution = result.execution;
          if (work.project_id !== execution.project_id || result.workUnit.project_id !== work.project_id || execution.work_unit_id !== work.work_unit_id || work.fence !== execution.fence || work.claim?.execution_id !== execution.execution_id || work.claim?.owner !== execution.owner || work.claim?.claim_expires_at !== execution.claim_expires_at) throw new Error('fencing conflict while persisting turn');
          // Crash recovery settles a completed attempt only after its claim and
          // authority have provably expired; an active claim belongs to a live
          // runner and is never settled behind it.
          if (recovery && !(work.claim_expires_at && new Date(work.claim_expires_at).getTime() <= Date.now())) throw new Error('fencing conflict while recovering settlement: claim is still active');
          const a = (await client.query('SELECT * FROM vnext_project_mutation_authority WHERE project_id=$1 FOR UPDATE', [work.project_id])).rows[0];
          if (!a || a.work_unit_id !== work.work_unit_id || a.execution_id !== execution.execution_id || Number(a.fence) !== execution.fence || a.owner !== execution.owner || a.authorization_decision_ref !== execution.authorization_decision_ref || a.claim_expires_at.toISOString() !== execution.claim_expires_at) throw new Error('fencing conflict while persisting turn: project mutation authority expired or changed');
          if (!recovery && a.claim_expires_at.getTime() <= Date.now()) throw new Error('fencing conflict while persisting turn: project mutation authority expired or changed');
          const e = (await client.query('SELECT * FROM vnext_executions WHERE execution_id=$1 FOR UPDATE', [execution.execution_id])).rows[0];
          if (!e || e.state !== 'running' || e.authorization_decision_ref !== execution.authorization_decision_ref) throw new Error('execution is not running');
          // A pending authorized cancellation settles explicitly: the result is
          // not accepted, no continuation or evidence is written, and effect
          // uncertainty (if any) stays with the project.
          const cancellation = (await client.query('SELECT * FROM vnext_cancellation_intents WHERE work_unit_id=$1 AND consumed_at IS NULL FOR UPDATE', [work.work_unit_id])).rows[0];
          if (cancellation) {
            const cancelled = await settleCancellation(client, work, e, cancellation);
            await saveReceipt(client, `cancelled:${execution.execution_id}`, 'execution.cancelled', cancellationDigest({ executionId: execution.execution_id, projectId: execution.project_id, workUnitId: work.work_unit_id, fence: execution.fence, decisionRef: cancellation.decision_ref }), cancelled);
            return { cancelled: true, ...cancelled };
          }
          const derived = settlement(result, work, executionFromRow(e));
          const { turn } = derived;
          await client.query("UPDATE vnext_executions SET state='succeeded',finished_at=$2,failure=NULL,retry_after=NULL WHERE execution_id=$1", [execution.execution_id, derived.execution.finished_at]);
          if (turn.disposition !== 'done') await client.query('INSERT INTO vnext_continuations(work_unit_id,execution_id,continuation) VALUES ($1,$2,$3::jsonb)', [work.work_unit_id, execution.execution_id, JSON.stringify(turn.continuation)]);
          if (turn.outcome_evidence) await client.query('INSERT INTO vnext_evidence_refs(work_unit_id,execution_id,evidence) VALUES ($1,$2,$3::jsonb)', [work.work_unit_id, execution.execution_id, JSON.stringify(turn.outcome_evidence)]);
          const progress = (await client.query('SELECT * FROM vnext_pilot_progress WHERE work_unit_id=$1 FOR UPDATE', [work.work_unit_id])).rows[0];
          if (progress) {
            await client.query('UPDATE vnext_pilot_progress SET consumed_input_seq=$2,next_wake_at=NULL,updated_at=clock_timestamp() WHERE work_unit_id=$1', [work.work_unit_id, e.admission.input_seq]);
            await client.query('INSERT INTO vnext_pilot_results(execution_id,work_unit_id,turn) VALUES ($1,$2,$3::jsonb)', [execution.execution_id, work.work_unit_id, JSON.stringify(turn)]);
            const pending = await client.query('SELECT 1 FROM vnext_pilot_inputs WHERE work_unit_id=$1 AND input_seq>$2 LIMIT 1', [work.work_unit_id, e.admission.input_seq]);
            if (pending.rowCount) derived.workUnit.state = 'actionable';
          }
          await client.query('UPDATE vnext_work_units SET state=$2,claim_execution_id=NULL,claim_owner=NULL,claim_fence=NULL,claim_expires_at=NULL,failure=NULL,retry_after=NULL,continuation=$3::jsonb,last_execution_id=$4,last_turn=$5::jsonb,updated_at=clock_timestamp() WHERE work_unit_id=$1', [work.work_unit_id, derived.workUnit.state, JSON.stringify(derived.workUnit.continuation), execution.execution_id, JSON.stringify(turn)]);
          await client.query('DELETE FROM vnext_project_mutation_authority WHERE project_id=$1', [work.project_id]);
          await saveReceipt(client, key, 'execution.settled', hash, derived);
          return derived;
        });
      } catch (error) {
        // A lost COMMIT reply is inspected, never converted to execution failure.
        const prior = await inspectReceipt(key, hash);
        if (prior) return prior;
        const intent = await inspectCancellation(result.workUnit.work_unit_id);
        if (intent) {
          const cancelled = await inspectReceipt(`cancelled:${result.execution.execution_id}`, cancellationDigest({ executionId: result.execution.execution_id, projectId: result.execution.project_id, workUnitId: result.workUnit.work_unit_id, fence: result.execution.fence, decisionRef: intent.decision_ref }));
          if (cancelled) return { cancelled: true, ...cancelled };
        }
        throw error;
      }
    },
    getAcceptanceContext(workId) { return transaction(workId, snapshot); },
    async acceptWork(workId, input) {
      const decision = structuredClone(input);
      if (!decision?.ref || typeof decision.ref !== 'string' || decision.ref.length > 160) throw new Error('acceptance requires an explicit decision reference');
      const key = `acceptance:${decision.ref}`;
      const hash = digest({ workId, decision });
      try {
        return await transaction(workId, async (client, work) => {
          const prior = await receipt(client, key, hash);
          if (prior) return prior;
          if (work.state !== 'review') throw new Error('work is not settled for acceptance');
          const current = await snapshot(client, work);
          validateAcceptanceDecision(decision, current);
          if (typeof acceptanceVerifier !== 'function') throw new Error('acceptance verifier is required');
          if (await acceptanceVerifier(decision, structuredClone(current)) !== true) throw new Error('acceptance decision is not valid for this Work Unit');
          const value = { work_unit_id: workId, state: 'terminal', execution_id: work.last_execution_id, acceptance_ref: decision.ref, snapshotDigest: current.snapshotDigest };
          // Validate all collisions before changing the row; unique insertion is
          // also fail-closed for collisions in a different project's transaction.
          await saveReceipt(client, key, 'work.accepted', hash, value);
          await client.query("UPDATE vnext_work_units SET state='terminal',updated_at=clock_timestamp() WHERE work_unit_id=$1 AND state='review'", [workId]);
          return value;
        });
      } catch (error) {
        const prior = await inspectReceipt(key, hash);
        if (prior) return prior;
        throw error;
      }
    },
    async reviseWorkRequirements(workId, { expectedRevision, requirements }) {
      const value = requirementsValue(requirements);
      return transaction(workId, async (client, work) => {
        if (work.work_revision !== expectedRevision) throw new Error('work revision conflict');
        // Updating intent must not destroy the disposition required to resolve
        // an existing reconciliation block.
        await client.query(`UPDATE vnext_work_units w SET work_revision=work_revision+1,requirements=$2::jsonb,
          state=CASE WHEN w.claim_execution_id IS NULL
            AND NOT EXISTS (SELECT 1 FROM vnext_project_reconciliation_blocks r WHERE r.project_id=w.project_id AND r.work_unit_id=w.work_unit_id)
            THEN 'actionable' ELSE w.state END,updated_at=clock_timestamp() WHERE w.work_unit_id=$1`, [workId, JSON.stringify(value)]);
        if (!work.claim) await client.query('UPDATE vnext_pilot_progress SET next_wake_at=clock_timestamp() WHERE work_unit_id=$1', [workId]);
        return { work_revision: expectedRevision + 1, requirements: value };
      });
    },
    // Authorized cancellation intent: distinct decision surface, durable before
    // any check point observes it. Exact replay returns the receipt; divergent
    // content fails closed. Idle work settles cancelled in the same transaction;
    // claimed work stays pending until its attempt settles.
    async recordCancellation({ projectId, workUnitId, expectedRevision, decision } = {}) {
      if (typeof projectId !== 'string' || !projectId || typeof workUnitId !== 'string' || !workUnitId) throw new Error('cancellation requires projectId and workUnitId');
      if (!Number.isInteger(expectedRevision) || expectedRevision < 1) throw new Error('cancellation requires the observed work revision');
      const value = structuredClone(decision);
      if (!value?.ref || typeof value.ref !== 'string' || !value.ref.trim() || value.ref.length > 160) throw new Error('cancellation requires an explicit decision reference');
      const key = `cancellation:${value.ref}`;
      const hash = digest({ projectId, workUnitId, workRevision: expectedRevision, decision: value });
      try {
        return await transaction(workUnitId, async (client, work) => {
          if (work.project_id !== projectId) throw new Error('Work Unit does not exist in this project');
          const prior = await receipt(client, key, hash);
          if (prior) return { ...prior, created: false };
          if (Number(work.work_revision) !== expectedRevision) throw new Error('work revision changed before cancellation');
          if (work.state === 'terminal') throw new Error('terminal work cannot be cancelled');
          if (work.state === 'cancelled') throw new Error('work is already cancelled');
          if ((await client.query('SELECT 1 FROM vnext_cancellation_intents WHERE work_unit_id=$1 FOR UPDATE', [workUnitId])).rowCount) throw new Error('a cancellation intent is already pending');
          if (typeof cancellationVerifier !== 'function') throw new Error('cancellation verifier is required');
          if (await cancellationVerifier(structuredClone(value), structuredClone({ projectId, workUnitId, workRevision: expectedRevision })) !== true) throw new Error('cancellation decision is not valid for this Work Unit');
          const pending = Boolean(work.claim);
          await client.query('INSERT INTO vnext_cancellation_intents(work_unit_id,project_id,work_revision,decision_ref,content_digest) VALUES ($1,$2,$3,$4,$5)', [workUnitId, projectId, expectedRevision, value.ref, hash]);
          if (!pending) {
            await client.query('UPDATE vnext_cancellation_intents SET consumed_at=clock_timestamp() WHERE work_unit_id=$1', [workUnitId]);
            await client.query("UPDATE vnext_work_units SET state='cancelled',updated_at=clock_timestamp() WHERE work_unit_id=$1", [workUnitId]);
            await client.query('UPDATE vnext_pilot_progress SET next_wake_at=NULL,updated_at=clock_timestamp() WHERE work_unit_id=$1', [workUnitId]);
          }
          const settled = { work_unit_id: workUnitId, state: pending ? 'pending' : 'cancelled', work_revision: expectedRevision, decision_ref: value.ref, execution_id: work.claim?.execution_id ?? null };
          await saveReceipt(client, key, 'work.cancellation-recorded', hash, settled);
          return { ...settled, created: true };
        });
      } catch (error) {
        const prior = await inspectReceipt(key, hash).catch(() => null);
        if (prior) return { ...prior, created: false };
        throw error;
      }
    },
    async getCancellationIntent(workId) {
      if (typeof workId !== 'string' || !workId) throw new Error('workUnitId is required');
      const row = await inspectCancellation(workId);
      if (!row) return null;
      return { work_unit_id: row.work_unit_id, project_id: row.project_id, work_revision: Number(row.work_revision), decision_ref: row.decision_ref, pending: row.consumed_at === null, recorded_at: row.recorded_at.toISOString(), consumed_at: row.consumed_at?.toISOString() ?? null };
    },
    async assertEffectAdmissible({ projectId, workUnitId, workRevision } = {}) {
      if (typeof projectId !== 'string' || !projectId || typeof workUnitId !== 'string' || !workUnitId || !Number.isInteger(workRevision) || workRevision < 1) throw new Error('effect admission requires projectId, workUnitId, and workRevision');
      const client = await db.connect();
      let found;
      try { found = await client.query('SELECT 1 FROM vnext_cancellation_intents WHERE project_id=$1 AND work_unit_id=$2 AND work_revision=$3 AND consumed_at IS NULL', [projectId, workUnitId, workRevision]); }
      finally { client.release(); }
      if (found.rowCount) throw new Error('E_CANCELLED: cancellation intent is pending for this revision');
      return true;
    },
  };
}
