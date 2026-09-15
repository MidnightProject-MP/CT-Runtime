CREATE TABLE IF NOT EXISTS public.vnext_feedback_evaluations (
  evaluation_id text PRIMARY KEY,
  feedback_id text NOT NULL,
  source_revision bigint NOT NULL CHECK (source_revision >= 1),
  disposition text NOT NULL CHECK (disposition IN (
    'acknowledged', 'informational', 'needs_follow_up', 'suggests_new_work',
    'relates_to_existing_work', 'question_answered', 'no_action'
  )),
  summary text NOT NULL,
  project_reference text,
  related_work_reference text,
  proposed_action text,
  response text,
  receipt_event_id text NOT NULL,
  evaluator_version text NOT NULL,
  evaluated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (feedback_id, source_revision),
  UNIQUE (receipt_event_id)
);

CREATE INDEX IF NOT EXISTS vnext_feedback_evaluations_feedback_idx
  ON public.vnext_feedback_evaluations(feedback_id, source_revision);

CREATE OR REPLACE FUNCTION public.vnext_feedback_evaluations_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'FeedbackEvaluation is immutable';
END;
$$;

DROP TRIGGER IF EXISTS vnext_feedback_evaluations_immutable_trg ON public.vnext_feedback_evaluations;
CREATE TRIGGER vnext_feedback_evaluations_immutable_trg
  BEFORE UPDATE OR DELETE ON public.vnext_feedback_evaluations
  FOR EACH ROW EXECUTE FUNCTION public.vnext_feedback_evaluations_immutable();
