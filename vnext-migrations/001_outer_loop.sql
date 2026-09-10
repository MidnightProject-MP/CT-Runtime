CREATE TABLE IF NOT EXISTS vnext_work_units (
  work_unit_id text PRIMARY KEY,
  objective_ref text NOT NULL,
  state text NOT NULL CHECK (state IN ('actionable','waiting','review','terminal')),
  fence bigint NOT NULL DEFAULT 0 CHECK (fence >= 0),
  claim_execution_id text,
  claim_owner text,
  claim_fence bigint,
  continuation jsonb,
  last_execution_id text,
  last_turn jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((claim_execution_id IS NULL AND claim_owner IS NULL AND claim_fence IS NULL) OR (claim_execution_id IS NOT NULL AND claim_owner IS NOT NULL AND claim_fence IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS vnext_executions (
  execution_id text PRIMARY KEY,
  work_unit_id text NOT NULL REFERENCES vnext_work_units(work_unit_id),
  owner text NOT NULL,
  fence bigint NOT NULL,
  state text NOT NULL CHECK (state IN ('created','running','succeeded','failed','expired')),
  started_at timestamptz NOT NULL,
  finished_at timestamptz
);

CREATE TABLE IF NOT EXISTS vnext_continuations (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  work_unit_id text NOT NULL REFERENCES vnext_work_units(work_unit_id),
  execution_id text NOT NULL REFERENCES vnext_executions(execution_id),
  continuation jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE IF NOT EXISTS vnext_evidence_refs (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  work_unit_id text NOT NULL REFERENCES vnext_work_units(work_unit_id),
  execution_id text NOT NULL REFERENCES vnext_executions(execution_id),
  evidence jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE IF NOT EXISTS vnext_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_type text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX IF NOT EXISTS vnext_executions_work_unit_idx ON vnext_executions(work_unit_id, started_at DESC);
CREATE INDEX IF NOT EXISTS vnext_continuations_work_unit_idx ON vnext_continuations(work_unit_id, created_at DESC);
CREATE INDEX IF NOT EXISTS vnext_evidence_work_unit_idx ON vnext_evidence_refs(work_unit_id, created_at DESC);
CREATE INDEX IF NOT EXISTS vnext_events_created_idx ON vnext_events(created_at);
