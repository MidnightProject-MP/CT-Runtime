-- Project identity is required for all newly-created vNext state. Existing
-- rows must have an explicit deterministic mapping before this migration can
-- become authoritative; fail closed rather than inventing project ownership.
ALTER TABLE public.vnext_work_units
  ADD COLUMN IF NOT EXISTS project_id text;

ALTER TABLE public.vnext_executions
  ADD COLUMN IF NOT EXISTS project_id text;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.vnext_work_units WHERE project_id IS NULL) THEN
    RAISE EXCEPTION 'vNext migration requires project_id for existing work units; no deterministic backfill is defined';
  END IF;
  IF EXISTS (SELECT 1 FROM public.vnext_executions WHERE project_id IS NULL) THEN
    RAISE EXCEPTION 'vNext migration requires project_id for existing executions; no deterministic backfill is defined';
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.vnext_project_mutation_authority (
  project_id text PRIMARY KEY,
  work_unit_id text NOT NULL REFERENCES public.vnext_work_units(work_unit_id),
  execution_id text NOT NULL REFERENCES public.vnext_executions(execution_id),
  fence bigint NOT NULL CHECK (fence >= 1),
  claim_expires_at timestamptz NOT NULL,
  acquired_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX IF NOT EXISTS vnext_project_mutation_authority_execution_idx
  ON public.vnext_project_mutation_authority(execution_id);

CREATE INDEX IF NOT EXISTS vnext_project_mutation_authority_work_unit_idx
  ON public.vnext_project_mutation_authority(work_unit_id);

CREATE INDEX IF NOT EXISTS vnext_work_units_project_idx
  ON public.vnext_work_units(project_id);

CREATE INDEX IF NOT EXISTS vnext_executions_project_idx
  ON public.vnext_executions(project_id);
