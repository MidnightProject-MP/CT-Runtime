-- Claim fences identify attempts, not material requirements revisions. Existing
-- rows retain a legacy identity baseline, not an acceptance grant.
ALTER TABLE vnext_work_units ADD COLUMN work_revision bigint NOT NULL DEFAULT 1 CHECK (work_revision > 0);
ALTER TABLE vnext_work_units ADD COLUMN requirements jsonb NOT NULL DEFAULT '{"baseline":"legacy-objective-reference"}'::jsonb
  CHECK (jsonb_typeof(requirements) = 'object' AND octet_length(requirements::text) <= 16384);
-- Captured by admission, never supplied by the worker; NULL historical attempts
-- cannot furnish a new acceptance snapshot.
ALTER TABLE vnext_executions ADD COLUMN admission jsonb;
