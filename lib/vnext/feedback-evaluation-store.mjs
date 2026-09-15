import { canonicalFeedbackEvaluationContent, evaluationConflict } from './feedback-evaluation.mjs';

const row = (result) => result.rows[0];

export class PostgresFeedbackEvaluationStore {
  constructor({ pool } = {}) {
    if (!pool) throw new Error('Postgres pool is required');
    this.pool = pool;
  }

  async persistEvaluation(evaluation) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const inserted = await client.query(`INSERT INTO vnext_feedback_evaluations
        (evaluation_id,feedback_id,source_revision,disposition,summary,project_reference,related_work_reference,proposed_action,response,receipt_event_id,evaluator_version)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
        ON CONFLICT (feedback_id,source_revision) DO NOTHING RETURNING *`, [
        evaluation.evaluation_id, evaluation.feedback_id, evaluation.source_revision,
        evaluation.disposition, evaluation.summary, evaluation.project_reference,
        evaluation.related_work_reference, evaluation.proposed_action, evaluation.response,
        evaluation.receipt_event_id, evaluation.evaluator_version,
      ]);
      const current = row(inserted) || row(await client.query('SELECT * FROM vnext_feedback_evaluations WHERE feedback_id=$1 AND source_revision=$2 FOR SHARE', [evaluation.feedback_id, evaluation.source_revision]));
      if (!current) throw new Error('feedback evaluation was not persisted');
      const actual = {
        evaluation_id: current.evaluation_id, feedback_id: current.feedback_id, source_revision: current.source_revision,
        disposition: current.disposition, summary: current.summary, project_reference: current.project_reference,
        related_work_reference: current.related_work_reference, proposed_action: current.proposed_action,
        response: current.response, receipt_event_id: current.receipt_event_id, evaluator_version: current.evaluator_version,
      };
      if (canonicalFeedbackEvaluationContent(actual) !== canonicalFeedbackEvaluationContent(evaluation)) throw evaluationConflict('feedback evaluation identity conflict', actual);
      await client.query('COMMIT');
      return { created: Boolean(row(inserted)), evaluation: { ...actual, evaluated_at: current.evaluated_at } };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      if (error?.code === '23505') error.category = 'conflict';
      throw error;
    } finally { client.release(); }
  }
}
