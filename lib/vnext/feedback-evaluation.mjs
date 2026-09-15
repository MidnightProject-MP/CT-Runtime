import { canonicalJson } from './config.mjs';

export const FEEDBACK_EVALUATION_DISPOSITIONS = Object.freeze([
  'acknowledged',
  'informational',
  'needs_follow_up',
  'suggests_new_work',
  'relates_to_existing_work',
  'question_answered',
  'no_action',
]);

const text = (value, field, max = 4000) => {
  if (value == null) return null;
  if (typeof value !== 'string' || value.length > max || /[\0\r\n]/.test(value)) throw new Error(`${field} must be a bounded safe string`);
  return value;
};
const requiredText = (value, field, max = 4000) => {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} is required`);
  return text(value, field, max);
};

export function feedbackEvaluationId(feedbackId, sourceRevision) {
  if (typeof feedbackId !== 'string' || !feedbackId.trim()) throw new Error('feedback_id is required');
  if (!Number.isInteger(sourceRevision) || sourceRevision < 1) throw new Error('source_revision must be a positive integer');
  return `feedback-evaluation:${feedbackId}:${sourceRevision}`;
}

export function normalizeFeedbackEvaluationJudgment(input = {}) {
  if (!FEEDBACK_EVALUATION_DISPOSITIONS.includes(input.disposition)) throw new Error('invalid feedback evaluation disposition');
  return {
    disposition: input.disposition,
    summary: requiredText(input.summary, 'summary'),
    project_reference: text(input.project_reference, 'project_reference', 500),
    related_work_reference: text(input.related_work_reference, 'related_work_reference', 500),
    proposed_action: text(input.proposed_action, 'proposed_action'),
    response: text(input.response, 'response'),
  };
}

function receiptParts(event) {
  if (!event || typeof event !== 'object') throw new Error('feedback receipt event is required');
  const eventType = event.event_type ?? event.type;
  if (eventType !== 'external_input.received') throw new Error('feedback evaluation requires external_input.received');
  const eventId = event.event_id;
  if (typeof eventId !== 'string' || !eventId.trim()) throw new Error('receipt event_id is required');
  const payload = event.payload ?? event;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('receipt payload must be an object');
  const feedbackId = payload.feedback_id;
  const sourceRevision = Number(payload.source_revision);
  const evaluationId = feedbackEvaluationId(feedbackId, sourceRevision);
  if (eventId !== `human-feedback:${feedbackId}:${sourceRevision}`) throw new Error('receipt event identity is invalid');
  return { eventId, feedbackId, sourceRevision, evaluationId, payload };
}

export async function evaluateFeedbackReceipt(event, context, evaluator) {
  if (!context || typeof context !== 'object') throw new Error('evaluation context is required');
  if (typeof evaluator !== 'function') throw new Error('feedback evaluator is required');
  if (typeof context.loadFeedbackContext !== 'function') throw new Error('bounded feedback context loader is required');
  if (!context.persistence || typeof context.persistence.persistEvaluation !== 'function') throw new Error('feedback evaluation persistence is required');

  const receipt = receiptParts(event);
  const boundedContext = await context.loadFeedbackContext({
    event,
    feedbackId: receipt.feedbackId,
    sourceRevision: receipt.sourceRevision,
  });
  const judgment = normalizeFeedbackEvaluationJudgment(await evaluator({ receipt: event, context: boundedContext }));
  const evaluation = {
    evaluation_id: receipt.evaluationId,
    feedback_id: receipt.feedbackId,
    source_revision: receipt.sourceRevision,
    ...judgment,
    receipt_event_id: receipt.eventId,
    evaluator_version: requiredText(context.evaluatorVersion, 'evaluator_version', 200),
  };
  return context.persistence.persistEvaluation(evaluation);
}

export function canonicalFeedbackEvaluationContent(evaluation) {
  return canonicalJson({
    evaluation_id: evaluation.evaluation_id,
    feedback_id: evaluation.feedback_id,
    source_revision: evaluation.source_revision,
    disposition: evaluation.disposition,
    summary: evaluation.summary,
    project_reference: evaluation.project_reference ?? null,
    related_work_reference: evaluation.related_work_reference ?? null,
    proposed_action: evaluation.proposed_action ?? null,
    response: evaluation.response ?? null,
    receipt_event_id: evaluation.receipt_event_id,
    evaluator_version: evaluation.evaluator_version,
  });
}

export function evaluationConflict(message, evaluation) {
  return Object.assign(new Error(message), { category: 'conflict', code: 'FEEDBACK_EVALUATION_CONFLICT', evaluation });
}
