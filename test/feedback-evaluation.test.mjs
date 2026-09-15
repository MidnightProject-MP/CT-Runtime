import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateFeedbackReceipt, feedbackEvaluationId, normalizeFeedbackEvaluationJudgment } from '../lib/vnext/feedback-evaluation.mjs';

const receipt = (feedbackId = 'F1', revision = 1, message = 'hello') => ({
  event_type: 'external_input.received',
  event_id: `human-feedback:${feedbackId}:${revision}`,
  payload: { feedback_id: feedbackId, source_revision: revision, message },
});

function harness() {
  const persisted = [];
  return {
    persisted,
    context: {
      evaluatorVersion: 'test-v1',
      async loadFeedbackContext(input) { return { feedback: input.event.payload, project: 'demo', relatedWork: null }; },
      persistence: {
        async persistEvaluation(value) {
          const existing = persisted.find((item) => item.feedback_id === value.feedback_id && item.source_revision === value.source_revision);
          if (existing) return { created: false, evaluation: existing };
          const evaluation = { ...value, evaluated_at: '2026-09-14T00:00:00.000Z' };
          persisted.push(evaluation);
          return { created: true, evaluation };
        },
      },
    },
  };
}

test('feedback evaluation identity is deterministic', () => {
  assert.equal(feedbackEvaluationId('F1', 2), 'feedback-evaluation:F1:2');
});

test('feedback evaluation accepts exactly the bounded disposition vocabulary', () => {
  assert.equal(normalizeFeedbackEvaluationJudgment({ disposition: 'suggests_new_work', summary: 'review migration automation' }).disposition, 'suggests_new_work');
  assert.throws(() => normalizeFeedbackEvaluationJudgment({ disposition: 'create_work', summary: 'bad' }), /invalid feedback evaluation disposition/);
});

test('first evaluation persists one authoritative judgment and supplies identity/provenance outside the evaluator output', async () => {
  const { context, persisted } = harness();
  const result = await evaluateFeedbackReceipt(receipt(), context, ({ context: bounded }) => ({
    disposition: 'needs_follow_up', summary: bounded.feedback.message, proposed_action: 'inspect the deployment path',
  }));
  assert.equal(result.created, true);
  assert.deepEqual(persisted[0], result.evaluation);
  assert.equal(result.evaluation.evaluation_id, 'feedback-evaluation:F1:1');
  assert.equal(result.evaluation.receipt_event_id, 'human-feedback:F1:1');
  assert.equal(result.evaluation.evaluator_version, 'test-v1');
});

test('same receipt evaluates to one persisted evaluation', async () => {
  const { context, persisted } = harness();
  const evaluator = () => ({ disposition: 'informational', summary: 'received' });
  const first = await evaluateFeedbackReceipt(receipt(), context, evaluator);
  const second = await evaluateFeedbackReceipt(receipt(), context, evaluator);
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(persisted.length, 1);
  assert.equal(second.evaluation.evaluation_id, first.evaluation.evaluation_id);
});

test('revision creates a distinct evaluation', async () => {
  const { context, persisted } = harness();
  const evaluator = ({ receipt: event }) => ({ disposition: event.payload.source_revision === 1 ? 'no_action' : 'needs_follow_up', summary: `revision ${event.payload.source_revision}` });
  await evaluateFeedbackReceipt(receipt('F1', 1), context, evaluator);
  const second = await evaluateFeedbackReceipt(receipt('F1', 2), context, evaluator);
  assert.equal(second.created, true);
  assert.equal(persisted.length, 2);
  assert.notEqual(persisted[0].evaluation_id, persisted[1].evaluation_id);
});

test('invalid receipt and evaluator output fail closed', async () => {
  const { context } = harness();
  await assert.rejects(() => evaluateFeedbackReceipt({ ...receipt(), event_id: 'wrong' }, context, () => ({ disposition: 'no_action', summary: 'x' })), /identity is invalid/);
  await assert.rejects(() => evaluateFeedbackReceipt(receipt(), context, () => ({ disposition: 'invalid', summary: 'x' })), /invalid feedback evaluation disposition/);
});
