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
  IF EXISTS (
    SELECT 1
    FROM public.vnext_executions AS e
    JOIN public.vnext_work_units AS w USING (work_unit_id)
    WHERE e.project_id <> w.project_id
  ) THEN
    RAISE EXCEPTION 'vNext migration requires execution project_id to match its work unit project_id';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM public.vnext_executions AS e
    LEFT JOIN public.vnext_work_units AS w USING (work_unit_id)
    WHERE w.work_unit_id IS NULL
  ) THEN
    RAISE EXCEPTION 'vNext migration requires every execution to reference an existing work unit';
  END IF;
END $$;

-- The fail-closed checks above establish the precondition for making project
-- identity a schema-level invariant. Direct SQL cannot create NULL identities.
ALTER TABLE public.vnext_work_units
  ALTER COLUMN project_id SET NOT NULL;

ALTER TABLE public.vnext_executions
  ALTER COLUMN project_id SET NOT NULL;

-- Composite identity keys let the database enforce that project identity
-- travels with a Work Unit and Execution rather than merely existing beside
-- their independent primary keys.
CREATE UNIQUE INDEX IF NOT EXISTS vnext_work_units_project_identity_idx
  ON public.vnext_work_units(work_unit_id, project_id);

CREATE UNIQUE INDEX IF NOT EXISTS vnext_executions_work_project_identity_idx
  ON public.vnext_executions(work_unit_id, execution_id, project_id);

CREATE UNIQUE INDEX IF NOT EXISTS vnext_executions_work_project_fence_identity_idx
  ON public.vnext_executions(work_unit_id, execution_id, project_id, fence);

-- An Execution may only claim a Work Unit from the same project.
ALTER TABLE public.vnext_executions
  ADD CONSTRAINT vnext_executions_work_project_fk
  FOREIGN KEY (work_unit_id, project_id)
  REFERENCES public.vnext_work_units(work_unit_id, project_id);

CREATE TABLE IF NOT EXISTS public.vnext_project_mutation_authority (
  project_id text PRIMARY KEY,
  work_unit_id text NOT NULL,
  execution_id text NOT NULL,
  fence bigint NOT NULL CHECK (fence >= 1),
  claim_expires_at timestamptz NOT NULL,
  acquired_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT vnext_project_mutation_authority_execution_fk
    FOREIGN KEY (work_unit_id, execution_id, project_id, fence)
    REFERENCES public.vnext_executions(work_unit_id, execution_id, project_id, fence)
);

-- Authority is valid only while its Execution is the Work Unit's active claim.
-- These are deferred constraint triggers so a legitimate settlement may update
-- the Execution/Work Unit and delete authority in one transaction, while a
-- direct SQL mutation that commits an orphaned authority is rejected.
CREATE OR REPLACE FUNCTION public.vnext_assert_project_mutation_authority_active()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.vnext_project_mutation_authority AS a
    JOIN public.vnext_executions AS e
      ON e.work_unit_id = a.work_unit_id
     AND e.execution_id = a.execution_id
     AND e.project_id = a.project_id
     AND e.fence = a.fence
    JOIN public.vnext_work_units AS w
      ON w.work_unit_id = a.work_unit_id
     AND w.project_id = a.project_id
    WHERE e.state NOT IN ('created', 'running')
       OR w.claim_execution_id IS DISTINCT FROM a.execution_id
       OR w.claim_fence IS DISTINCT FROM a.fence
       OR w.claim_expires_at IS DISTINCT FROM a.claim_expires_at
  ) THEN
    RAISE EXCEPTION 'vNext project mutation authority must reference the Work Unit current active claim';
  END IF;
  RETURN NULL;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'vnext_project_authority_active_insert_trg') THEN
    CREATE CONSTRAINT TRIGGER vnext_project_authority_active_insert_trg
      AFTER INSERT OR UPDATE ON public.vnext_project_mutation_authority
      DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW
      EXECUTE FUNCTION public.vnext_assert_project_mutation_authority_active();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'vnext_project_authority_active_execution_trg') THEN
    CREATE CONSTRAINT TRIGGER vnext_project_authority_active_execution_trg
      AFTER INSERT OR UPDATE OF state, work_unit_id, execution_id, project_id, fence ON public.vnext_executions
      DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW
      EXECUTE FUNCTION public.vnext_assert_project_mutation_authority_active();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'vnext_project_authority_active_work_unit_trg') THEN
    CREATE CONSTRAINT TRIGGER vnext_project_authority_active_work_unit_trg
      AFTER INSERT OR UPDATE OF claim_execution_id, claim_fence, claim_expires_at, project_id ON public.vnext_work_units
      DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW
      EXECUTE FUNCTION public.vnext_assert_project_mutation_authority_active();
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS vnext_project_mutation_authority_execution_idx
  ON public.vnext_project_mutation_authority(execution_id);

CREATE INDEX IF NOT EXISTS vnext_project_mutation_authority_work_unit_idx
  ON public.vnext_project_mutation_authority(work_unit_id);

CREATE INDEX IF NOT EXISTS vnext_work_units_project_idx
  ON public.vnext_work_units(project_id);

CREATE INDEX IF NOT EXISTS vnext_executions_project_idx
  ON public.vnext_executions(project_id);
