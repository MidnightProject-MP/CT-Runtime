CREATE TABLE IF NOT EXISTS observer_model_telemetry_envelopes (
  envelope_id text PRIMARY KEY,
  execution_id text NOT NULL REFERENCES runtime_executions(execution_id),
  sequence bigint NOT NULL CHECK (sequence >= 1),
  envelope jsonb NOT NULL,
  recorded_at timestamptz NOT NULL,
  UNIQUE (execution_id, sequence)
);
CREATE INDEX IF NOT EXISTS observer_model_telemetry_execution_idx ON observer_model_telemetry_envelopes(execution_id,sequence,envelope_id);

CREATE TABLE IF NOT EXISTS observer_artifacts (
  artifact_id text PRIMARY KEY,
  execution_id text REFERENCES runtime_executions(execution_id),
  artifact_kind text NOT NULL,
  artifact_key text NOT NULL,
  content jsonb NOT NULL,
  markdown text,
  content_hash text NOT NULL,
  recorded_at timestamptz NOT NULL,
  UNIQUE (artifact_kind, artifact_key)
);
CREATE INDEX IF NOT EXISTS observer_artifacts_execution_idx ON observer_artifacts(execution_id,artifact_kind,recorded_at);
