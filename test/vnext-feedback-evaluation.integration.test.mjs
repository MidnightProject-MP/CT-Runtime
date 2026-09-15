import test from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { migrate } from '../lib/migration.mjs';
import { migrateVNext } from '../lib/vnext/migration.mjs';
import { evaluateFeedbackReceipt } from '../lib/vnext/feedback-evaluation.mjs';
import { PostgresFeedbackEvaluationStore } from '../lib/vnext/feedback-evaluation-store.mjs';

const connectionString = process.env.TEST_DATABASE_URL;

async function snapshot(pool) {
  const [work, executions, continuations, wakes] = await Promise.all([
    pool.query('SELECT work_unit_id,objective_ref,state,fence,claim_execution_id,claim_owner,claim_fence,continuation,last_execution_id,last_turn FROM vnext_work_units ORDER BY work_unit_id'),
    pool.query('SELECT execution_id,work_unit_id,owner,fence,state,started_at,finished_at FROM vnext_executions ORDER BY execution_id'),
    pool.query('SELECT id,work_unit_id,execution_id,continuation FROM vnext_continuations ORDER BY id'),
    pool.query('SELECT schedule_key,wake_time,reason,priority,project,claimed_at,claim_owner,claim_fence FROM runtime_schedules ORDER BY schedule_key'),
  ]);
  return { work: work.rows, executions: executions.rows, continuations: continuations.rows, wakes: wakes.rows };
}

test('Durable FeedbackEvaluation is idempotent and cannot mutate the outer-loop graph', { skip: !connectionString, timeout: 60000 }, async () => {
  const pool = new Pool({ connectionString, max: 5 });
  const feedbackId = `F-${randomUUID()}`;
  try {
    await migrate({ pool, directory: path.join(import.meta.dirname, '..', 'migrations') });
    await migrateVNext({ pool, directory: path.join(import.meta.dirname, '..', 'vnext-migrations') });
    const store = new PostgresFeedbackEvaluationStore({ pool });
    const event = { event_type: 'external_input.received', event_id: `human-feedback:${feedbackId}:1`, payload: { feedback_id: feedbackId, source_revision: 1, message: 'Please review migration automation', thread_reference: 'thread-1' } };
    const context = {
      evaluatorVersion: 'test-v1',
      async loadFeedbackContext({ event: receipt }) { return { feedback: receipt.payload, project: 'demo', relatedWork: null }; },
      persistence: store,
    };
    const before = await snapshot(pool);
    const judgment = () => ({ disposition: 'suggests_new_work', summary: 'Feedback proposes reviewing migration automation.', proposed_action: 'Review migration deployment automation', response: 'Thanks — I registered the feedback for review.' });
    const first = await evaluateFeedbackReceipt(event, context, judgment);
    assert.equal(first.created, true);
    const second = await evaluateFeedbackReceipt(event, context, judgment);
    assert.equal(second.created, false);
    assert.equal(second.evaluation.evaluation_id, first.evaluation.evaluation_id);

    for (const [revision, disposition] of [[2, 'relates_to_existing_work'], [3, 'needs_follow_up'], [4, 'no_action']]) {
      const nextEvent = { ...event, event_id: `human-feedback:${feedbackId}:${revision}`, payload: { ...event.payload, source_revision: revision } };
      await evaluateFeedbackReceipt(nextEvent, context, () => ({
        disposition,
        summary: `${disposition} judgment`,
        related_work_reference: disposition === 'relates_to_existing_work' ? 'WU-123' : null,
        response: disposition === 'needs_follow_up' ? 'Follow-up recorded.' : null,
      }));
    }

    assert.deepEqual(await snapshot(pool), before);
    const evaluations = await pool.query('SELECT evaluation_id,feedback_id,source_revision,disposition,summary,project_reference,related_work_reference,proposed_action,response,receipt_event_id,evaluator_version,evaluated_at FROM vnext_feedback_evaluations WHERE feedback_id=$1 ORDER BY source_revision', [feedbackId]);
    assert.equal(evaluations.rowCount, 4);
    assert.equal(evaluations.rows[0].evaluation_id, `feedback-evaluation:${feedbackId}:1`);
    assert.equal(evaluations.rows[1].related_work_reference, 'WU-123');
  } finally {
    await pool.end();
  }
});

test('Postgres FeedbackEvaluation persistence rejects divergent judgment for an existing identity', { skip: !connectionString, timeout: 60000 }, async () => {
  const pool = new Pool({ connectionString, max: 3 });
  const feedbackId = `F-conflict-${randomUUID()}`;
  try {
    await migrate({ pool, directory: path.join(import.meta.dirname, '..', 'migrations') });
    await migrateVNext({ pool, directory: path.join(import.meta.dirname, '..', 'vnext-migrations') });
    const store = new PostgresFeedbackEvaluationStore({ pool });
    const base = { evaluation_id: `feedback-evaluation:${feedbackId}:1`, feedback_id: feedbackId, source_revision: 1, disposition: 'no_action', summary: 'first', project_reference: null, related_work_reference: null, proposed_action: null, response: null, receipt_event_id: `human-feedback:${feedbackId}:1`, evaluator_version: 'test-v1' };
    await store.persistEvaluation(base);
    await assert.rejects(() => store.persistEvaluation({ ...base, disposition: 'suggests_new_work', summary: 'different' }), /identity conflict/);
  } finally {
    await pool.end();
  }
});
