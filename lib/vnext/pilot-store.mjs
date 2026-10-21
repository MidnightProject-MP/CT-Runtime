import { createHash } from 'node:crypto';
import { createNeonStore } from './neon-store.mjs';
import { createAssignment, validateAssignment } from './assignment-contract.mjs';
import { digest } from './operating-boundary.mjs';

const identifier = (value, name) => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(value)) throw new Error(`${name} must be a safe identifier`);
  return value;
};

function assignmentFromRow(row) {
  const binding = {
    purpose: row.purpose,
    work_unit_id: row.work_unit_id,
    project_id: row.project_id,
    objective_ref: row.objective_ref,
    work_revision: Number(row.work_revision),
    input_seq: Number(row.input_seq),
    sequence: Number(row.sequence),
    predecessor_execution_id: row.predecessor_execution_id,
    subject_execution_id: row.subject_execution_id,
    subject_digest: row.subject_digest,
    subject_attempt: row.subject_attempt == null ? null : Number(row.subject_attempt),
    model: row.model,
    agent: row.agent,
    access_class: row.access_class,
    permissions: row.permissions,
  };
  const assignmentDigest = digest(binding);
  if (row.assignment_digest !== assignmentDigest) throw new Error('durable assignment binding digest is invalid');
  return validateAssignment({ assignment_id: row.assignment_id, assignment_digest: assignmentDigest,
    assignment_work_unit_id: row.assignment_work_unit_id, ...binding });
}

// Compatibility helper: worker timestamps never write coordinator due times.
export function nextWakeFor(turn, { earliest }) {
  return null;
}

// A narrow pilot adapter over the existing store, not a second lifecycle.
export function createPilotStore({ pool, authorizationVerifier, acceptanceVerifier, cancellationVerifier, assignmentDecisionVerifier, intervalMs = 60000, maxConcurrency = null, now = null }) {
  if (!pool || !Number.isInteger(intervalMs) || intervalMs < 1000) throw new Error('pool and intervalMs >= 1000 are required');
  if (now != null && typeof now !== 'function') throw new Error('now must be a function when supplied');
  const core = createNeonStore({ pool, authorizationVerifier, acceptanceVerifier, cancellationVerifier, assignmentDecisionVerifier, pilotIntervalMs: intervalMs, maxConcurrency, ...(now ? { now } : {}) });
  let methods;
  async function reconstructPilot(wake) {
    const work = await core.reconstruct(wake);
    if (!work) return null;
    const progress = await pool.query('SELECT * FROM vnext_pilot_progress WHERE work_unit_id=$1', [work.work_unit_id]);
    if (!progress.rows[0]) throw new Error('work is not enrolled in the pilot');
    const inputs = await pool.query('SELECT input_seq,receipt_id,message,received_at FROM vnext_pilot_inputs WHERE work_unit_id=$1 ORDER BY input_seq LIMIT 101', [work.work_unit_id]);
    if (inputs.rowCount > 100) throw new Error('pilot input bound reached; context compaction requires review');
    if (inputs.rows.reduce((n, row) => n + Buffer.byteLength(row.message), 0) > 131072) throw new Error('pilot input context exceeds 128 KiB');
    const history = await pool.query('SELECT execution_id,turn,recorded_at FROM vnext_pilot_results WHERE work_unit_id=$1 ORDER BY recorded_at DESC LIMIT 10', [work.work_unit_id]);
    const p = progress.rows[0];
    const proposals = await pool.query(`SELECT c.id,c.execution_id,c.continuation,e.finished_at FROM vnext_continuations c JOIN vnext_executions e USING(execution_id)
      WHERE c.work_unit_id=$1 AND c.id>$2 AND e.execution_id=$3 AND e.state='succeeded' AND (e.admission->>'work_revision')::bigint=$4 ORDER BY c.id LIMIT 1`, [work.work_unit_id, p.considered_proposal_id, work.last_execution_id, work.work_revision]);
    const proposal = proposals.rows[0];
    const reconstructed = { ...work, pilot: {
      consumed_input_seq: Number(p.consumed_input_seq),
      input_seq: Number(inputs.rows.at(-1)?.input_seq ?? 0),
      next_wake_at: p.next_wake_at?.toISOString() ?? null,
      considered_proposal_id: Number(p.considered_proposal_id ?? 0),
      pending_proposal: proposal ? { ...proposal, id: Number(proposal.id), runnable_at: new Date(proposal.finished_at.getTime() + intervalMs).toISOString() } : null,
      inputs: inputs.rows,
      recent_results: history.rows.reverse(),
    }};
    const assigned = await pool.query('SELECT a.*,w.objective_ref FROM vnext_assignments a JOIN vnext_work_units w ON w.work_unit_id=a.work_unit_id WHERE a.assignment_work_unit_id=$1', [work.work_unit_id]);
    if (assigned.rows[0]) {
      const assignment = assignmentFromRow(assigned.rows[0]);
      const assignmentContext = await reconstructPilot({ work_unit_id: assignment.work_unit_id });
      const related = await pool.query(`SELECT assignment_id,purpose,status,subject_execution_id,subject_digest,report,decision,decision_ref,created_at,updated_at
        FROM vnext_assignments WHERE work_unit_id=$1 ORDER BY created_at,assignment_id`, [assignment.work_unit_id]);
      assignmentContext.assignments = related.rows;
      return { ...reconstructed, assignment, assignment_context: assignmentContext };
    }
    return reconstructed;
  }
  async function findNextEligible(projectId) {
    identifier(projectId, 'projectId');
    // Runnable discovery is distinct from pending decisions. reconstruct()
    // exposes pending conditions too, but they do not spin the executor.
    // The database clock is authoritative unless a coordinator clock is
    // explicitly supplied for deterministic tests.
    const clock = now
      ? { due: 'to_timestamp($3::double precision / 1000)', values: [projectId, intervalMs, now()] }
      : { due: 'clock_timestamp()', values: [projectId, intervalMs] };
    const result = await pool.query(`SELECT w.work_unit_id FROM vnext_work_units w JOIN vnext_pilot_progress p USING(work_unit_id)
        WHERE w.project_id=$1 AND w.state IN ('actionable','waiting') AND w.claim_execution_id IS NULL
        AND NOT EXISTS (SELECT 1 FROM vnext_assignments a WHERE a.assignment_work_unit_id=w.work_unit_id)
        AND (w.retry_after IS NULL OR w.retry_after <= ${clock.due})
        AND NOT EXISTS (SELECT 1 FROM vnext_project_mutation_authority a WHERE a.project_id=w.project_id)
      AND NOT EXISTS (SELECT 1 FROM vnext_project_reconciliation_blocks r WHERE r.project_id=w.project_id)
      AND ((p.next_wake_at IS NOT NULL AND p.next_wake_at <= ${clock.due}) OR EXISTS
        (SELECT 1 FROM vnext_pilot_inputs i WHERE i.work_unit_id=w.work_unit_id AND i.input_seq>p.consumed_input_seq) OR EXISTS
        (SELECT 1 FROM vnext_continuations c JOIN vnext_executions e ON e.execution_id=c.execution_id
          WHERE c.work_unit_id=w.work_unit_id AND e.state='succeeded' AND e.execution_id=w.last_execution_id
            AND (e.admission->>'work_revision')::bigint=w.work_revision
            AND c.continuation->>'mode'='immediate' AND e.finished_at + ($2 * interval '1 millisecond') <= ${clock.due}
            AND c.id > p.considered_proposal_id))
      ORDER BY p.updated_at,w.work_unit_id LIMIT 1`, clock.values);
    return result.rows[0]?.work_unit_id ?? null;
  }
  async function queueAssignment(target, purpose, profileMap, { subjectExecutionId = null, subjectDigest = null, subjectAttempt = null, sequence = 1 } = {}) {
    const profile = profileMap?.[purpose];
    const inputSeq = Number(target.pilot?.input_seq ?? 0);
    const preliminary = createAssignment({ workUnit: target, purpose, profile, inputSeq, subjectExecutionId, subjectDigest, subjectAttempt, sequence, executionProfile: profileMap?.execution });
    const assignmentWorkUnitId = `assignment-work-${createHash('sha256').update(preliminary.assignment_id).digest('hex').slice(0, 40)}`;
    const assignment = createAssignment({ workUnit: target, purpose, profile, inputSeq, subjectExecutionId, subjectDigest, subjectAttempt, sequence, executionProfile: profileMap?.execution, assignmentWorkUnitId });
    await core.createAssignment({ assignment, assignmentWorkUnit: { work_unit_id: assignmentWorkUnitId, objective_ref: target.objective_ref, project_id: target.project_id } });
    return assignment;
  }
  async function planNext(projectId, profileMap, { maxNonProgress = 2 } = {}) {
    identifier(projectId, 'projectId');
    if (!Number.isInteger(maxNonProgress) || maxNonProgress < 1 || maxNonProgress > 10) throw new Error('maxNonProgress must be between 1 and 10');
    if (!profileMap) {
      if ((await pool.query('SELECT 1 FROM vnext_assignments WHERE project_id=$1 LIMIT 1', [projectId])).rowCount) throw new Error('assignmentProfiles are required once purpose-bound assignments exist');
      const workUnitId = await findNextEligible(projectId);
      return workUnitId ? { kind: 'dispatch', workUnitId, assignment: null } : { kind: 'none' };
    }
    const ledger = await methods.coordinatorLedger(projectId);
    if (ledger.block || ledger.authority) return { kind: 'blocked', reason: ledger.block ? 'external-effect-uncertain' : 'project-authority-held' };
    const pendingCancellation = (ledger.cancellations ?? []).find(cancel => cancel.consumed_at == null
      && Number(ledger.works.find(work => work.work_unit_id === cancel.work_unit_id)?.work_revision) === Number(cancel.work_revision));
    if (pendingCancellation) return { kind: 'blocked', reason: 'cancellation-pending', work_unit_id: pendingCancellation.work_unit_id };
    const assignments = ledger.assignments ?? [];
    const pending = assignments.find(row => row.status === 'reported');
    if (pending) return { kind: 'decision', assignment: assignmentFromRow(pending), report: pending.report };
    const queued = assignments.find(row => row.status === 'queued');
    if (queued) {
      if (!['actionable','waiting'].includes(queued.assignment_task_state)) return { kind: 'blocked', reason: 'assignment-attempt-not-replayable', work_unit_id: queued.work_unit_id };
      return { kind: 'dispatch', workUnitId: queued.assignment_work_unit_id, assignment: assignmentFromRow(queued) };
    }
    for (const row of ledger.works) {
      const work = await reconstructPilot({ work_unit_id: row.work_unit_id });
      if (!work || work.claim || ['terminal','cancelled'].includes(work.state)) continue;
      const related = assignments.filter(a => a.work_unit_id === work.work_unit_id && Number(a.work_revision) === Number(work.work_revision));
      if (work.state === 'review' && work.last_turn?.disposition === 'done') {
        const existingReview = related.filter(a => a.purpose === 'review' && a.subject_execution_id === work.last_execution_id).sort((a,b) => Date.parse(b.created_at)-Date.parse(a.created_at))[0];
        if (existingReview?.status === 'superseded') return { kind: 'blocked', reason: 'review-assignment-superseded', work_unit_id: work.work_unit_id };
        if (existingReview?.status === 'decided') {
          if (existingReview.decision?.outcome === 'recommend_accept') return { kind: 'accept', workUnitId: work.work_unit_id };
          if (existingReview.decision?.outcome === 'request_changes') {
            const reconsiderations = related.filter(a => a.purpose === 'review' && ['decided','superseded'].includes(a.status) && a.decision
              && ['request_changes','non_progress'].includes(a.decision?.outcome)).length;
            if (reconsiderations >= maxNonProgress) return { kind: 'blocked', reason: 'reconsideration-exhausted', work_unit_id: work.work_unit_id };
            // Settlement reopens the objective; this is retained for old ledgers
            // and exact replay after the report/decision transaction.
            continue;
          }
          if (existingReview.decision?.outcome === 'non_progress') {
            const subjectDigest = digest({ work_revision: work.work_revision, execution_id: work.last_execution_id,
              review_assignment_id: existingReview.assignment_id, review_report: existingReview.report, review_decision: existingReview.decision });
            const diagnosis = related.find(a => a.purpose === 'diagnosis' && a.subject_digest === subjectDigest);
            if (diagnosis?.status === 'superseded') return { kind: 'blocked', reason: 'diagnosis-assignment-superseded', work_unit_id: work.work_unit_id };
            if (diagnosis?.status === 'decided') return { kind: 'blocked', reason: diagnosis.decision?.outcome === 'stop' ? 'diagnosis-stopped' : 'reconsideration-exhausted', work_unit_id: work.work_unit_id };
            const attempts = related.filter(a => a.purpose === 'diagnosis' && ['decided','superseded'].includes(a.status) && a.decision).length;
            if (attempts >= maxNonProgress) return { kind: 'blocked', reason: 'reconsideration-exhausted', work_unit_id: work.work_unit_id };
            const assignment = await queueAssignment(work, 'diagnosis', profileMap, { subjectExecutionId: work.last_execution_id, subjectDigest, subjectAttempt: Math.max(1, Number(work.attempt) || 1), sequence: attempts + 1 });
            return { kind: 'dispatch', workUnitId: assignment.assignment_work_unit_id, assignment };
          }
          continue;
        }
        if (!existingReview) {
          let snapshotDigest;
          try { snapshotDigest = (await core.getAcceptanceStatusSnapshot(work.work_unit_id)).snapshotDigest; }
          catch { return { kind: 'blocked', reason: 'completion-snapshot-unavailable', work_unit_id: work.work_unit_id }; }
          const assignment = await queueAssignment(work, 'review', profileMap, { subjectExecutionId: work.last_execution_id, subjectDigest: snapshotDigest, subjectAttempt: Math.max(1, Number(work.attempt) || 1) });
          return { kind: 'dispatch', workUnitId: assignment.assignment_work_unit_id, assignment };
        }
        continue;
      }
      if (work.state === 'review' && work.failure) {
        const subjectDigest = digest({ work_revision: work.work_revision, execution_id: work.last_execution_id, failure: work.failure });
        const diagnosis = related.find(a => a.purpose === 'diagnosis' && a.subject_digest === subjectDigest);
        if (diagnosis?.status === 'superseded') return { kind: 'blocked', reason: 'diagnosis-assignment-superseded', work_unit_id: work.work_unit_id };
        if (diagnosis?.status === 'decided') {
          if (diagnosis.decision?.outcome === 'retry_with_changes') continue;
          continue;
        }
        const attempts = related.filter(a => a.purpose === 'diagnosis' && ['decided','superseded'].includes(a.status) && a.decision).length;
        if (attempts >= maxNonProgress) return { kind: 'blocked', reason: 'reconsideration-exhausted', work_unit_id: work.work_unit_id };
        const assignment = await queueAssignment(work, 'diagnosis', profileMap, { subjectExecutionId: work.last_execution_id, subjectDigest, subjectAttempt: Math.max(1, Number(work.attempt) || 1), sequence: attempts + 1 });
        return { kind: 'dispatch', workUnitId: assignment.assignment_work_unit_id, assignment };
      }
      const latestDecision = related.filter(a => a.status === 'decided' && ['review','diagnosis'].includes(a.purpose))
        .sort((a,b) => Date.parse(b.updated_at)-Date.parse(a.updated_at))[0];
      const freshInput = Number(work.pilot?.input_seq ?? 0) > Number(work.pilot?.consumed_input_seq ?? 0);
      const needsStewardship = freshInput || (latestDecision?.purpose === 'review' && latestDecision.decision?.outcome === 'request_changes');
      if (needsStewardship) {
        const trigger = { revision: work.work_revision, input_seq: work.pilot?.input_seq ?? 0,
          predecessor_execution_id: work.last_execution_id, decision_ref: latestDecision?.decision?.ref ?? null,
          feedback: latestDecision ? { report: latestDecision.report, decision: latestDecision.decision } : null };
        const subjectDigest = digest(trigger);
        const existing = related.find(a => a.purpose === 'stewardship' && a.subject_digest === subjectDigest);
        if (existing?.status === 'superseded') return { kind: 'blocked', reason: 'stewardship-assignment-superseded', work_unit_id: work.work_unit_id };
        if (existing?.status === 'decided') {
          if (existing.decision?.outcome === 'no_work') continue;
          // A proposed bounded response now admits exactly one execution.
        } else if (!existing) {
          const assignment = await queueAssignment(work, 'stewardship', profileMap, { subjectExecutionId: work.last_execution_id, subjectDigest });
          return { kind: 'dispatch', workUnitId: assignment.assignment_work_unit_id, assignment };
        }
      }
      if (work.state === 'waiting' && !freshInput) continue;
      if (await findNextEligible(projectId) === work.work_unit_id) {
        const sequence = Math.max(1, Number(work.attempt) + 1);
        const profile = profileMap?.execution;
        const subjectDigest = digest({ work_revision: work.work_revision, input_seq: work.pilot?.input_seq ?? 0,
          predecessor_execution_id: work.last_execution_id, sequence });
        const assignment = createAssignment({ workUnit: work, purpose: 'execution', profile,
          inputSeq: work.pilot?.input_seq ?? 0, subjectExecutionId: work.last_execution_id,
          subjectDigest, subjectAttempt: sequence, sequence, executionProfile: profile });
        return { kind: 'dispatch', workUnitId: work.work_unit_id, assignment };
      }
    }
    return { kind: 'none' };
  }
  methods = {
    ...core,
    appendEvent(event) {
      if (!event || typeof event.type !== 'string' || typeof event.event_id !== 'string') throw new Error('event type and event_id are required');
      return core.appendEvent(event);
    },
    async acceptWork(workUnitId, decision) {
      const work = await core.reconstruct({ work_unit_id: workUnitId });
      if (!work) throw new Error('Work Unit does not exist');
      const hasPurposeAssignments = (await pool.query('SELECT 1 FROM vnext_assignments WHERE work_unit_id=$1 LIMIT 1', [workUnitId])).rowCount > 0;
      if (hasPurposeAssignments) {
        const reviewer = await pool.query(`SELECT 1 FROM vnext_assignments
          WHERE work_unit_id=$1 AND work_revision=$2 AND purpose='review' AND subject_execution_id=$3
            AND status='decided' AND decision->>'outcome'='recommend_accept' LIMIT 1`, [workUnitId, work.work_revision, work.last_execution_id]);
        if (!reviewer.rowCount) throw new Error('independent review recommendation is required before acceptance');
      }
      return core.acceptWork(workUnitId, decision);
    },
    async coordinatorLedger(projectId) {
      identifier(projectId, 'projectId');
      const works = (await pool.query(`SELECT w.work_unit_id,w.objective_ref,w.project_id,w.state,w.fence,w.work_revision,
        w.claim_execution_id,w.claim_owner,w.claim_fence,w.claim_expires_at,w.last_execution_id,w.last_turn,w.continuation,w.failure,w.retry_after,w.created_at,w.updated_at,
        p.next_wake_at,p.consumed_input_seq,p.considered_proposal_id,
        COALESCE((SELECT max(i.input_seq) FROM vnext_pilot_inputs i WHERE i.work_unit_id=w.work_unit_id),0) AS latest_input_seq
         FROM vnext_work_units w JOIN vnext_pilot_progress p USING(work_unit_id)
         WHERE w.project_id=$1 AND NOT EXISTS (SELECT 1 FROM vnext_assignments a WHERE a.assignment_work_unit_id=w.work_unit_id)
         ORDER BY w.created_at,w.work_unit_id LIMIT 100`, [projectId])).rows;
      const ids = works.map(row => row.work_unit_id);
      const [executions, results, evidence, cancellations, continuations, accepted, assignments, block, authority, eligibleId] = await Promise.all([
        ids.length ? pool.query(`SELECT execution_id,work_unit_id,project_id,owner,state,fence,attempt,started_at,finished_at,failure,retry_after,admission
          FROM vnext_executions WHERE work_unit_id=ANY($1::text[]) ORDER BY started_at,execution_id`, [ids]) : { rows: [] },
        ids.length ? pool.query(`SELECT execution_id,work_unit_id,turn,recorded_at FROM vnext_pilot_results WHERE work_unit_id=ANY($1::text[]) ORDER BY recorded_at,execution_id`, [ids]) : { rows: [] },
        ids.length ? pool.query(`SELECT execution_id,evidence FROM vnext_evidence_refs WHERE work_unit_id=ANY($1::text[]) ORDER BY id`, [ids]) : { rows: [] },
        ids.length ? pool.query(`SELECT work_unit_id,work_revision,decision_ref,recorded_at,consumed_at FROM vnext_cancellation_intents WHERE project_id=$1 ORDER BY recorded_at`, [projectId]) : { rows: [] },
        ids.length ? pool.query(`SELECT DISTINCT ON (c.work_unit_id) c.work_unit_id,c.id,c.continuation,
          e.finished_at + ($2 * interval '1 millisecond') AS runnable_at
          FROM vnext_continuations c JOIN vnext_executions e USING(execution_id)
          JOIN vnext_work_units w ON w.work_unit_id=c.work_unit_id
          JOIN vnext_pilot_progress p ON p.work_unit_id=c.work_unit_id
          WHERE c.work_unit_id=ANY($1::text[]) AND e.state='succeeded' AND e.execution_id=w.last_execution_id
            AND (e.admission->>'work_revision')::bigint=w.work_revision AND c.id>p.considered_proposal_id
          ORDER BY c.work_unit_id,c.id DESC`, [ids, intervalMs]) : { rows: [] },
        ids.length ? pool.query(`SELECT event_id,created_at AS recorded_at,payload->'result' AS result FROM vnext_events
          WHERE event_type='work.accepted' AND payload->'result'->>'work_unit_id'=ANY($1::text[])
          ORDER BY created_at,id`, [ids]) : { rows: [] },
        ids.length ? pool.query(`SELECT a.*,w.objective_ref,aw.state AS assignment_task_state FROM vnext_assignments a
          JOIN vnext_work_units w ON w.work_unit_id=a.work_unit_id
          JOIN vnext_work_units aw ON aw.work_unit_id=a.assignment_work_unit_id
          WHERE a.work_unit_id=ANY($1::text[]) ORDER BY a.created_at,a.assignment_id`, [ids]) : { rows: [] },
        pool.query('SELECT project_id,work_unit_id,execution_id,fence,reason,created_at FROM vnext_project_reconciliation_blocks WHERE project_id=$1', [projectId]),
        pool.query('SELECT project_id,work_unit_id,execution_id,fence,owner,claim_expires_at FROM vnext_project_mutation_authority WHERE project_id=$1', [projectId]),
        findNextEligible(projectId),
      ]);
      const acceptedWorkIds = new Set(accepted.rows.map(row => row.result?.work_unit_id).filter(Boolean));
      const acceptanceSnapshots = await Promise.all(works.filter(work => work.state === 'terminal' && acceptedWorkIds.has(work.work_unit_id)).map(async work => {
        try {
          const snapshot = await core.getAcceptanceStatusSnapshot(work.work_unit_id);
          return [work.work_unit_id, {
            execution_id: snapshot.execution.execution_id,
            work_revision: Number(snapshot.workUnit.work_revision),
            snapshot_digest: snapshot.snapshotDigest,
          }];
        } catch (error) {
          if (/work is not settled for acceptance|stale revision|stored evidence|stored result/.test(String(error?.message ?? error))) {
            return [work.work_unit_id, null];
          }
          throw error;
        }
      }));
      return {
        project_id: projectId,
        works,
        executions: executions.rows,
        results: results.rows,
        evidence: evidence.rows,
        cancellations: cancellations.rows,
        continuations: continuations.rows,
        accepted: accepted.rows.map(row => row.result ? {
          ...row.result,
          event_id: row.event_id,
          recorded_at: row.recorded_at,
        } : null).filter(Boolean),
        acceptance_snapshots: Object.fromEntries(acceptanceSnapshots),
        assignments: assignments.rows,
        block: block.rows[0] ?? null,
        authority: authority.rows[0] ?? null,
        eligible_id: eligibleId,
      };
    },
    async submit({ projectId, threadId, receiptId, message }) {
      identifier(projectId, 'projectId'); identifier(threadId, 'threadId'); identifier(receiptId, 'receiptId');
      if (typeof message !== 'string' || !message.trim() || message.length > 16000) throw new Error('message must contain 1..16000 characters');
      const workId = `pilot-${createHash('sha256').update(JSON.stringify([projectId, threadId])).digest('hex').slice(0,40)}`;
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`ct-runtime:vnext-project:${projectId}`]);
        await client.query(`INSERT INTO vnext_work_units(work_unit_id,objective_ref,project_id,state,fence,created_at,updated_at)
          VALUES ($1,$1,$2,'actionable',0,clock_timestamp(),clock_timestamp()) ON CONFLICT DO NOTHING`, [workId, projectId]);
        await client.query('INSERT INTO vnext_pilot_progress(work_unit_id,next_wake_at) VALUES ($1,clock_timestamp()) ON CONFLICT DO NOTHING', [workId]);
        const inserted = await client.query('INSERT INTO vnext_pilot_inputs(receipt_id,work_unit_id,message) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING RETURNING input_seq', [receiptId,workId,message]);
        const existing = await client.query('SELECT * FROM vnext_pilot_inputs WHERE receipt_id=$1', [receiptId]);
        if (existing.rows[0]?.work_unit_id !== workId || existing.rows[0]?.message !== message) throw new Error('receipt identity conflict');
        if (inserted.rowCount === 1) await client.query(`UPDATE vnext_work_units w SET state='actionable',updated_at=clock_timestamp()
          WHERE w.work_unit_id=$1 AND w.state IN ('terminal','review') AND w.claim_execution_id IS NULL
          AND NOT EXISTS (SELECT 1 FROM vnext_project_reconciliation_blocks r WHERE r.project_id=w.project_id AND r.work_unit_id=w.work_unit_id)`, [workId]);
        await client.query('COMMIT');
        return { work_unit_id: workId, created: inserted.rowCount === 1, input_seq: Number(existing.rows[0].input_seq) };
      } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; }
      finally { client.release(); }
    },
    async nextEligible(projectId) {
      return findNextEligible(projectId);
    },
    async planNext(projectId, profileMap, options) {
      return planNext(projectId, profileMap, options);
    },
    async pendingAssignment(projectId, assignmentId) {
      identifier(projectId, 'projectId'); identifier(assignmentId, 'assignmentId');
      const result = await pool.query(`SELECT a.*,w.objective_ref FROM vnext_assignments a JOIN vnext_work_units w ON w.work_unit_id=a.work_unit_id
        WHERE a.project_id=$1 AND a.assignment_id=$2 AND a.status='reported'`, [projectId, assignmentId]);
      const row = result.rows[0];
      return row ? { assignment: assignmentFromRow(row), report: row.report } : null;
    },
    async reconstruct(wake) {
      return reconstructPilot(wake);
    },
    async status(projectId) {
      const rows = await pool.query(`SELECT w.work_unit_id,w.state,w.last_turn,w.failure,w.claim_execution_id,w.claim_expires_at,
        p.next_wake_at,p.consumed_input_seq,p.considered_proposal_id,
        (SELECT max(i.input_seq) FROM vnext_pilot_inputs i WHERE i.work_unit_id=w.work_unit_id) AS latest_input_seq
        FROM vnext_work_units w JOIN vnext_pilot_progress p USING(work_unit_id) WHERE w.project_id=$1
        AND NOT EXISTS (SELECT 1 FROM vnext_assignments a WHERE a.assignment_work_unit_id=w.work_unit_id)
        ORDER BY w.created_at LIMIT 100`, [projectId]);
      return rows.rows;
    },
  };
  return methods;
}
