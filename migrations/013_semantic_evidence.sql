-- Semantic evidence is canonical in PostgreSQL.  The envelope and its
-- content hash are immutable; execution ownership is fenced by the store.
CREATE TABLE IF NOT EXISTS runtime_semantic_evidence (
  envelope_id text PRIMARY KEY,
  execution_id text NOT NULL REFERENCES runtime_executions(execution_id),
  content_hash text NOT NULL CHECK (content_hash ~ '^[a-f0-9]{64}$'),
  envelope jsonb NOT NULL,
  byte_count bigint NOT NULL CHECK (byte_count >= 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS runtime_semantic_evidence_execution_idx
  ON runtime_semantic_evidence(execution_id,created_at,envelope_id);
