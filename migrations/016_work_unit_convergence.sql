-- Minimum provider-neutral Work Unit convergence contract. PR providers and
-- cognition remain external capabilities; these rows only bind evidence.
CREATE TABLE IF NOT EXISTS federation_work_units (
  work_unit_id text PRIMARY KEY,
  work_order_id text NOT NULL UNIQUE REFERENCES federation_work_orders(work_order_id),
  project text NOT NULL,
  intended_outcome jsonb NOT NULL,
  invariants jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(invariants)='array'),
  branch text,
  base_commit text CHECK (base_commit IS NULL OR base_commit ~ '^[a-f0-9]{40,64}$'),
  evidence_requirements jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(evidence_requirements)='array'),
  intent_digest text NOT NULL CHECK (intent_digest ~ '^[a-f0-9]{64}$'),
  state text NOT NULL DEFAULT 'ready' CHECK (state IN ('ready','converging','merged','abandoned')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE IF NOT EXISTS federation_convergence_subjects (
  subject_id text PRIMARY KEY,
  work_unit_id text NOT NULL REFERENCES federation_work_units(work_unit_id),
  pull_request_id text NOT NULL,
  head_sha text NOT NULL CHECK (head_sha ~ '^[a-f0-9]{40,64}$'),
  base_sha text CHECK (base_sha IS NULL OR base_sha ~ '^[a-f0-9]{40,64}$'),
  branch text,
  state text NOT NULL DEFAULT 'open' CHECK (state IN ('open','merged','closed')),
  merged_commit_sha text CHECK (merged_commit_sha IS NULL OR merged_commit_sha ~ '^[a-f0-9]{40,64}$'),
  UNIQUE (work_unit_id, pull_request_id, head_sha)
);

CREATE TABLE IF NOT EXISTS federation_convergence_checks (
  check_id text PRIMARY KEY,
  work_unit_id text NOT NULL REFERENCES federation_work_units(work_unit_id),
  pull_request_id text NOT NULL,
  head_sha text NOT NULL CHECK (head_sha ~ '^[a-f0-9]{40,64}$'),
  check_name text NOT NULL,
  implementation_version text NOT NULL,
  intent_digest text NOT NULL CHECK (intent_digest ~ '^[a-f0-9]{64}$'),
  result text NOT NULL CHECK (result IN ('pass','fail','indeterminate')),
  evidence jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(evidence)='array'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (work_unit_id, pull_request_id, head_sha, check_name, implementation_version),
  FOREIGN KEY (work_unit_id, pull_request_id, head_sha)
    REFERENCES federation_convergence_subjects(work_unit_id, pull_request_id, head_sha)
);
