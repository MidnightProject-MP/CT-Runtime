ALTER TABLE public.vnext_work_units
  ADD COLUMN IF NOT EXISTS project_id text;

ALTER TABLE public.vnext_executions
  ADD COLUMN IF NOT EXISTS project_id text;

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
