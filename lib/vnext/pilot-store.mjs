import { createHash } from 'node:crypto';
import { createNeonStore } from './neon-store.mjs';

const identifier = (value, name) => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(value)) throw new Error(`${name} must be a safe identifier`);
  return value;
};

// A narrow pilot adapter over the existing store, not a second lifecycle.
export function createPilotStore({ pool, authorizationVerifier, intervalMs = 60000 }) {
  if (!pool || !Number.isInteger(intervalMs) || intervalMs < 1000) throw new Error('pool and intervalMs >= 1000 are required');
  const core = createNeonStore({ pool, authorizationVerifier, allowExpiredTakeover: false });
  return {
    ...core,
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
        if (inserted.rowCount === 1) await client.query("UPDATE vnext_work_units SET state='actionable',updated_at=clock_timestamp() WHERE work_unit_id=$1 AND state='terminal'", [workId]);
        await client.query('COMMIT');
        return { work_unit_id: workId, created: inserted.rowCount === 1, input_seq: Number(existing.rows[0].input_seq) };
      } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; }
      finally { client.release(); }
    },
    async nextEligible(projectId) {
      identifier(projectId, 'projectId');
      const result = await pool.query(`SELECT w.work_unit_id FROM vnext_work_units w JOIN vnext_pilot_progress p USING(work_unit_id)
        WHERE w.project_id=$1 AND w.state IN ('actionable','waiting') AND w.claim_execution_id IS NULL
        AND NOT EXISTS (SELECT 1 FROM vnext_project_mutation_authority a WHERE a.project_id=w.project_id)
        AND NOT EXISTS (SELECT 1 FROM vnext_project_reconciliation_blocks r WHERE r.project_id=w.project_id)
        AND ((p.next_wake_at IS NOT NULL AND p.next_wake_at <= clock_timestamp()) OR EXISTS
          (SELECT 1 FROM vnext_pilot_inputs i WHERE i.work_unit_id=w.work_unit_id AND i.input_seq>p.consumed_input_seq))
        ORDER BY p.updated_at,w.work_unit_id LIMIT 1`, [projectId]);
      return result.rows[0]?.work_unit_id ?? null;
    },
    async admitEmailDelivery({ projectId, outboxId, recipient }) {
      identifier(projectId, 'projectId');
      identifier(outboxId, 'outboxId');
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        // The project advisory lock is the same serialization/fencing boundary
        // used by execution acquisition and reconciliation. This transaction is
        // the durable linearization point for consequential email delivery:
        // either reconciliation wins first and delivery is refused, or delivery
        // admission wins first and a later reconciliation block is ordered after it.
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`ct-runtime:vnext-project:${projectId}`]);
        const mailbox = await client.query(
          'SELECT project_id,allowed_sender FROM vnext_email_mailboxes WHERE mailbox_id=(SELECT mailbox_id FROM vnext_email_outbox WHERE outbox_id=$1 FOR UPDATE)',
          [outboxId],
        );
        const outbox = await client.query(
          "SELECT * FROM vnext_email_outbox WHERE outbox_id=$1 AND state IN ('pending','uncertain') FOR UPDATE",
          [outboxId],
        );
        if (!outbox.rows[0]) throw new Error('email outbox item is not deliverable');
        if (outbox.rows[0].to_address !== recipient) throw new Error('outbox recipient conflict');
        if (mailbox.rows[0]?.project_id !== projectId || mailbox.rows[0]?.allowed_sender !== recipient) throw new Error('email mailbox project or recipient conflict');
        const blocked = await client.query(
          'SELECT 1 FROM vnext_project_reconciliation_blocks WHERE project_id=$1 FOR UPDATE',
          [projectId],
        );
        if (blocked.rowCount) {
          await client.query('ROLLBACK');
          return null;
        }
        const admitted = await client.query(
          "UPDATE vnext_email_outbox SET state='uncertain',attempt=attempt+1 WHERE outbox_id=$1 AND state IN ('pending','uncertain') RETURNING *",
          [outboxId],
        );
        if (admitted.rowCount !== 1) throw new Error('email outbox item changed before delivery admission');
        await client.query('COMMIT');
        return admitted.rows[0];
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    },
    async reconstruct(wake) {
      const work = await core.reconstruct(wake);
      if (!work) return null;
      const progress = await pool.query('SELECT * FROM vnext_pilot_progress WHERE work_unit_id=$1', [work.work_unit_id]);
      if (!progress.rows[0]) throw new Error('work is not enrolled in the pilot');
      const inputs = await pool.query('SELECT input_seq,receipt_id,message,received_at FROM vnext_pilot_inputs WHERE work_unit_id=$1 ORDER BY input_seq LIMIT 101', [work.work_unit_id]);
      if (inputs.rowCount > 100) throw new Error('pilot input bound reached; context compaction requires review');
      if (inputs.rows.reduce((n, row) => n + Buffer.byteLength(row.message), 0) > 131072) throw new Error('pilot input context exceeds 128 KiB');
      const history = await pool.query('SELECT execution_id,turn,recorded_at FROM vnext_pilot_results WHERE work_unit_id=$1 ORDER BY recorded_at DESC LIMIT 10', [work.work_unit_id]);
      const p = progress.rows[0];
      return { ...work, pilot: {
        consumed_input_seq: Number(p.consumed_input_seq),
        input_seq: Number(inputs.rows.at(-1)?.input_seq ?? 0),
        next_wake_at: p.next_wake_at?.toISOString() ?? null,
        inputs: inputs.rows,
        recent_results: history.rows.reverse(),
      }};
    },
    async persistTurn(result) {
      const requested = result.turn.requested_next_wake;
      const earliest = Date.now() + intervalMs;
      const nextWake = result.turn.disposition === 'done' ? null
        : requested ? new Date(Math.max(earliest, Date.parse(requested))).toISOString()
        : result.turn.disposition === 'continue' ? new Date(earliest).toISOString() : null;
      result.workUnit.pilot.next_wake_at = nextWake;
      return core.persistTurn(result);
    },
    async status(projectId) {
      const rows = await pool.query(`SELECT w.work_unit_id,w.state,w.last_turn,w.failure,w.claim_execution_id,w.claim_expires_at,
        p.next_wake_at,p.consumed_input_seq,
        (SELECT max(i.input_seq) FROM vnext_pilot_inputs i WHERE i.work_unit_id=w.work_unit_id) AS latest_input_seq
        FROM vnext_work_units w JOIN vnext_pilot_progress p USING(work_unit_id) WHERE w.project_id=$1 ORDER BY w.created_at LIMIT 100`, [projectId]);
      return rows.rows;
    },
  };
}
