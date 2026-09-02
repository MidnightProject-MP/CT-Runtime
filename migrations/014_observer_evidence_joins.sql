CREATE TABLE IF NOT EXISTS observer_evidence_joins (
  execution_id text PRIMARY KEY REFERENCES runtime_executions(execution_id),
  binding_hash text NOT NULL CHECK (binding_hash ~ '^[a-f0-9]{64}$'),
  claim_references text[] NOT NULL,
  envelope jsonb NOT NULL,
  join_record jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS observer_evidence_joins_binding_idx
  ON observer_evidence_joins(binding_hash);
