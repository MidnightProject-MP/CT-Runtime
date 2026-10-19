-- An authorized cancellation intent is durable before any check point observes
-- it. It is bound to the Work Unit and the material revision the decision was
-- made against. One intent per Work Unit: exact replay returns the recorded
-- receipt, divergent content fails closed while an intent is still pending.
ALTER TABLE vnext_work_units DROP CONSTRAINT vnext_work_units_state_check;
ALTER TABLE vnext_work_units ADD CONSTRAINT vnext_work_units_state_check
  CHECK (state IN ('actionable','waiting','review','terminal','cancelled'));

CREATE TABLE vnext_cancellation_intents (
  work_unit_id text PRIMARY KEY REFERENCES vnext_work_units(work_unit_id),
  project_id text NOT NULL,
  work_revision bigint NOT NULL CHECK (work_revision > 0),
  decision_ref text NOT NULL CHECK (length(decision_ref) BETWEEN 1 AND 160),
  content_digest text NOT NULL CHECK (length(content_digest) = 64),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  consumed_by_execution_id text,
  consumed_at timestamptz,
  CHECK (consumed_by_execution_id IS NULL OR consumed_at IS NOT NULL)
);

CREATE INDEX vnext_cancellation_intents_project_idx
  ON vnext_cancellation_intents(project_id, work_unit_id);
