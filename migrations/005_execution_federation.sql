-- Execution Federation L1.  These tables are coordination authority; GAS/hosts
-- retain only their local evidence and provider metadata.
CREATE TABLE IF NOT EXISTS federation_work_orders (
  work_order_id text PRIMARY KEY,
  project text NOT NULL,
  intent jsonb NOT NULL,
  repository jsonb NOT NULL DEFAULT '{}'::jsonb,
  state text NOT NULL DEFAULT 'ready',
  next_claim_fence bigint NOT NULL DEFAULT 0,
  version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE IF NOT EXISTS federation_executions (
  execution_id text PRIMARY KEY,
  work_order_id text NOT NULL REFERENCES federation_work_orders(work_order_id),
  provider text NOT NULL,
  mode text NOT NULL CHECK (mode IN ('foreground','background')),
  state text NOT NULL DEFAULT 'claimed',
  claim_owner text,
  claim_fence bigint,
  lease_until timestamptz,
  checkpoint jsonb,
  repository jsonb NOT NULL DEFAULT '{}'::jsonb,
  lineage jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS federation_executions_work_order_idx ON federation_executions(work_order_id,created_at);
CREATE TABLE IF NOT EXISTS federation_handoffs (
  handoff_id text PRIMARY KEY,
  work_order_id text NOT NULL REFERENCES federation_work_orders(work_order_id),
  from_execution_id text NOT NULL REFERENCES federation_executions(execution_id),
  to_execution_id text,
  checkpoint jsonb,
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE IF NOT EXISTS federation_events (
  event_id text PRIMARY KEY,
  work_order_id text NOT NULL REFERENCES federation_work_orders(work_order_id),
  execution_id text,
  event_type text NOT NULL,
  payload jsonb NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS federation_events_order_idx ON federation_events(work_order_id,occurred_at,event_id);

-- Keep upgrades of the initial prototype safe when the table already exists.
ALTER TABLE federation_work_orders ADD COLUMN IF NOT EXISTS next_claim_fence bigint NOT NULL DEFAULT 0;
