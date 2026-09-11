CREATE TABLE IF NOT EXISTS vnext_settlement_attempts (
  execution_id text PRIMARY KEY REFERENCES vnext_executions(execution_id),
  work_unit_id text NOT NULL REFERENCES vnext_work_units(work_unit_id),
  event_id text NOT NULL,
  fence bigint NOT NULL,
  result jsonb NOT NULL,
  committed_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE UNIQUE INDEX IF NOT EXISTS vnext_settlement_attempt_identity_idx
  ON vnext_settlement_attempts(work_unit_id, event_id);

ALTER TABLE vnext_events ADD COLUMN IF NOT EXISTS processing_status text NOT NULL DEFAULT 'received'
  CHECK (processing_status IN ('received','processing','completed'));
ALTER TABLE vnext_events ADD COLUMN IF NOT EXISTS processing_execution_id text;
ALTER TABLE vnext_events ADD COLUMN IF NOT EXISTS processing_completed_at timestamptz;
CREATE INDEX IF NOT EXISTS vnext_events_processing_idx ON vnext_events(processing_status, created_at);
