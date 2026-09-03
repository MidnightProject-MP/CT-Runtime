-- Work Unit convergence rows are evidence records.  Identity and intent are
-- write-once, while checks and merge records are append-only.
CREATE OR REPLACE FUNCTION public.federation_convergence_immutable()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION '% rows are append-only', TG_TABLE_NAME USING ERRCODE = '45000';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION public.federation_work_unit_identity_immutable()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.work_unit_id IS DISTINCT FROM OLD.work_unit_id
    OR NEW.work_order_id IS DISTINCT FROM OLD.work_order_id
    OR NEW.project IS DISTINCT FROM OLD.project
    OR NEW.intended_outcome IS DISTINCT FROM OLD.intended_outcome
    OR NEW.invariants IS DISTINCT FROM OLD.invariants
    OR NEW.branch IS DISTINCT FROM OLD.branch
    OR NEW.base_commit IS DISTINCT FROM OLD.base_commit
    OR NEW.evidence_requirements IS DISTINCT FROM OLD.evidence_requirements
    OR NEW.intent_digest IS DISTINCT FROM OLD.intent_digest THEN
    RAISE EXCEPTION 'work unit identity or intent is immutable' USING ERRCODE = '45000';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION public.federation_convergence_subject_identity_immutable()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.subject_id IS DISTINCT FROM OLD.subject_id
    OR NEW.work_unit_id IS DISTINCT FROM OLD.work_unit_id
    OR NEW.pull_request_id IS DISTINCT FROM OLD.pull_request_id
    OR NEW.head_sha IS DISTINCT FROM OLD.head_sha
    OR NEW.base_sha IS DISTINCT FROM OLD.base_sha
    OR NEW.branch IS DISTINCT FROM OLD.branch THEN
    RAISE EXCEPTION 'convergence subject identity or head is immutable' USING ERRCODE = '45000';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS federation_work_unit_identity_immutable ON public.federation_work_units;
CREATE TRIGGER federation_work_unit_identity_immutable BEFORE UPDATE ON public.federation_work_units
FOR EACH ROW EXECUTE FUNCTION public.federation_work_unit_identity_immutable();
DROP TRIGGER IF EXISTS federation_convergence_subject_identity_immutable ON public.federation_convergence_subjects;
CREATE TRIGGER federation_convergence_subject_identity_immutable BEFORE UPDATE ON public.federation_convergence_subjects
FOR EACH ROW EXECUTE FUNCTION public.federation_convergence_subject_identity_immutable();

-- The digest is also a relational binding, not merely a caller assertion.
ALTER TABLE public.federation_work_orders
  ADD CONSTRAINT federation_work_orders_id_project_key UNIQUE (work_order_id, project);
ALTER TABLE public.federation_work_units
  ADD CONSTRAINT federation_work_units_project_fk
  FOREIGN KEY (work_order_id, project)
  REFERENCES public.federation_work_orders(work_order_id, project);
ALTER TABLE public.federation_work_units
  ADD CONSTRAINT federation_work_units_id_intent_digest_key UNIQUE (work_unit_id, intent_digest);
ALTER TABLE public.federation_convergence_checks
  ADD CONSTRAINT federation_convergence_checks_intent_digest_fk
  FOREIGN KEY (work_unit_id, intent_digest)
  REFERENCES public.federation_work_units(work_unit_id, intent_digest);

CREATE TABLE IF NOT EXISTS public.federation_convergence_merges (
  merge_id text PRIMARY KEY,
  work_unit_id text NOT NULL REFERENCES public.federation_work_units(work_unit_id),
  pull_request_id text NOT NULL,
  source_head_sha text NOT NULL CHECK (source_head_sha ~ '^[a-f0-9]{40,64}$'),
  merged_commit_sha text NOT NULL CHECK (merged_commit_sha ~ '^[a-f0-9]{40,64}$'),
  intent_digest text NOT NULL CHECK (intent_digest ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (work_unit_id, pull_request_id, source_head_sha),
  FOREIGN KEY (work_unit_id, intent_digest)
    REFERENCES public.federation_work_units(work_unit_id, intent_digest)
);

DROP TRIGGER IF EXISTS federation_convergence_checks_append_only ON public.federation_convergence_checks;
CREATE TRIGGER federation_convergence_checks_append_only BEFORE UPDATE OR DELETE ON public.federation_convergence_checks
FOR EACH ROW EXECUTE FUNCTION public.federation_convergence_immutable();
DROP TRIGGER IF EXISTS federation_convergence_merges_append_only ON public.federation_convergence_merges;
CREATE TRIGGER federation_convergence_merges_append_only BEFORE UPDATE OR DELETE ON public.federation_convergence_merges
FOR EACH ROW EXECUTE FUNCTION public.federation_convergence_immutable();
