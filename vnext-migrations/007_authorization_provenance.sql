-- A8: mutation-bearing executions retain verifiable authorization provenance.
-- The runtime stores the exact decision reference used for each Execution;
-- policy remains owned by the injected authorization authority.
ALTER TABLE public.vnext_executions
  ADD COLUMN IF NOT EXISTS authorization_decision_ref text;

ALTER TABLE public.vnext_project_mutation_authority
  ADD COLUMN IF NOT EXISTS authorization_decision_ref text;

-- Every newly-written Execution must carry an authorization reference. Existing
-- historical rows may remain NULL because they predate this invariant; see the legacy-recovery test.
CREATE OR REPLACE FUNCTION public.vnext_assert_execution_authorization_ref()
RETURNS trigger
LANGUAGE plpgsql
AS $vnext$
BEGIN
  -- Rows that predate A8 may remain NULL while being retired or recovered.
  -- Once a legacy row receives a reference, the normal non-empty invariant applies.
  IF NEW.authorization_decision_ref IS NULL THEN
    IF TG_OP = 'UPDATE' AND OLD.authorization_decision_ref IS NULL THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'vNext Execution requires an authorization decision reference';
  END IF;
  IF btrim(NEW.authorization_decision_ref) = '' THEN
    RAISE EXCEPTION 'vNext Execution requires an authorization decision reference';
  END IF;
  RETURN NEW;
END;
$vnext$;

DROP TRIGGER IF EXISTS vnext_execution_authorization_ref_trg ON public.vnext_executions;
CREATE TRIGGER vnext_execution_authorization_ref_trg
  BEFORE INSERT OR UPDATE ON public.vnext_executions
  FOR EACH ROW
  EXECUTE FUNCTION public.vnext_assert_execution_authorization_ref();

-- Authority must preserve the same decision relied upon by its Execution.
CREATE OR REPLACE FUNCTION public.vnext_assert_authority_authorization_ref()
RETURNS trigger
LANGUAGE plpgsql
AS $vnext$
BEGIN
  IF NEW.authorization_decision_ref IS NULL OR btrim(NEW.authorization_decision_ref) = '' THEN
    RAISE EXCEPTION 'vNext project mutation authority requires an authorization decision reference';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.vnext_executions AS e
    WHERE e.execution_id = NEW.execution_id
      AND e.work_unit_id = NEW.work_unit_id
      AND e.project_id = NEW.project_id
      AND e.fence = NEW.fence
      AND e.authorization_decision_ref IS DISTINCT FROM NEW.authorization_decision_ref
  ) THEN
    RAISE EXCEPTION 'vNext project mutation authority authorization reference does not match its Execution';
  END IF;
  RETURN NEW;
END;
$vnext$;

DROP TRIGGER IF EXISTS vnext_project_authority_authorization_ref_trg ON public.vnext_project_mutation_authority;
CREATE CONSTRAINT TRIGGER vnext_project_authority_authorization_ref_trg
  AFTER INSERT OR UPDATE ON public.vnext_project_mutation_authority
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION public.vnext_assert_authority_authorization_ref();

-- A continuation/evidence pair must identify an Execution belonging to the
-- same Work Unit, not merely two independently valid foreign keys.
ALTER TABLE public.vnext_executions
  ADD CONSTRAINT vnext_executions_work_execution_identity_uq
  UNIQUE (work_unit_id, execution_id);

ALTER TABLE public.vnext_continuations
  ADD CONSTRAINT vnext_continuations_work_execution_fk
  FOREIGN KEY (work_unit_id, execution_id)
  REFERENCES public.vnext_executions(work_unit_id, execution_id);

ALTER TABLE public.vnext_evidence_refs
  ADD CONSTRAINT vnext_evidence_work_execution_fk
  FOREIGN KEY (work_unit_id, execution_id)
  REFERENCES public.vnext_executions(work_unit_id, execution_id);
