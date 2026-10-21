-- Purpose-specific cognition work is represented as an internal Work Unit and
-- linked to the objective it serves. The existing Execution, claim, project
-- authority, process recovery, and immutable event mechanisms remain canonical.
CREATE TABLE vnext_assignments (
  assignment_id text PRIMARY KEY CHECK (length(assignment_id) BETWEEN 1 AND 160),
  assignment_digest text NOT NULL UNIQUE CHECK (assignment_digest ~ '^[a-f0-9]{64}$'),
  project_id text NOT NULL,
  work_unit_id text NOT NULL,
  assignment_work_unit_id text NOT NULL UNIQUE,
  purpose text NOT NULL CHECK (purpose IN ('stewardship','review','diagnosis')),
  work_revision bigint NOT NULL CHECK (work_revision > 0),
  input_seq bigint NOT NULL DEFAULT 0 CHECK (input_seq >= 0),
  sequence integer NOT NULL DEFAULT 1 CHECK (sequence > 0),
  predecessor_execution_id text,
  subject_execution_id text,
  subject_digest text CHECK (subject_digest IS NULL OR subject_digest ~ '^[a-f0-9]{64}$'),
  subject_attempt integer CHECK (subject_attempt IS NULL OR subject_attempt > 0),
  model text NOT NULL CHECK (length(model) BETWEEN 1 AND 200),
  agent text NOT NULL CHECK (length(agent) BETWEEN 1 AND 120),
  access_class text NOT NULL CHECK (access_class IN ('read-only','bounded-mutation')),
  permissions jsonb NOT NULL CHECK (jsonb_typeof(permissions)='array'),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','reported','decided','superseded')),
  report jsonb,
  report_digest text CHECK (report_digest IS NULL OR report_digest ~ '^[a-f0-9]{64}$'),
  decision_ref text UNIQUE CHECK (decision_ref IS NULL OR length(decision_ref) BETWEEN 1 AND 160),
  decision jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT vnext_assignments_target_project_fk
    FOREIGN KEY(work_unit_id,project_id)
    REFERENCES vnext_work_units(work_unit_id,project_id),
  CONSTRAINT vnext_assignments_task_project_fk
    FOREIGN KEY(assignment_work_unit_id,project_id)
    REFERENCES vnext_work_units(work_unit_id,project_id),
  CONSTRAINT vnext_assignments_subject_execution_fk
    FOREIGN KEY(work_unit_id,subject_execution_id,project_id)
    REFERENCES vnext_executions(work_unit_id,execution_id,project_id),
  CHECK (purpose='execution' OR access_class='read-only'),
  CHECK (assignment_id='assignment-' || substr(assignment_digest,1,48)),
  CHECK ((status='queued' AND report IS NULL AND decision IS NULL AND decision_ref IS NULL)
      OR (status='reported' AND report IS NOT NULL AND report_digest IS NOT NULL AND decision IS NULL AND decision_ref IS NULL)
      OR (status='decided' AND report IS NOT NULL AND report_digest IS NOT NULL AND decision IS NOT NULL AND decision_ref IS NOT NULL)
      OR status='superseded')
);

CREATE INDEX vnext_assignments_target_status_idx
  ON vnext_assignments(work_unit_id,status,created_at DESC);
CREATE INDEX vnext_assignments_project_status_idx
  ON vnext_assignments(project_id,status,created_at);

CREATE FUNCTION vnext_assignment_identity_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.assignment_id,NEW.assignment_digest,NEW.project_id,NEW.work_unit_id,NEW.assignment_work_unit_id,NEW.purpose,
         NEW.work_revision,NEW.input_seq,NEW.sequence,NEW.predecessor_execution_id,NEW.subject_execution_id,
         NEW.subject_digest,NEW.subject_attempt,NEW.model,NEW.agent,NEW.access_class,NEW.permissions)
     IS DISTINCT FROM
     ROW(OLD.assignment_id,OLD.assignment_digest,OLD.project_id,OLD.work_unit_id,OLD.assignment_work_unit_id,OLD.purpose,
         OLD.work_revision,OLD.input_seq,OLD.sequence,OLD.predecessor_execution_id,OLD.subject_execution_id,
         OLD.subject_digest,OLD.subject_attempt,OLD.model,OLD.agent,OLD.access_class,OLD.permissions) THEN
    RAISE EXCEPTION 'purpose-bound assignment identity is immutable';
  END IF;
  IF OLD.report IS NOT NULL AND (NEW.report IS DISTINCT FROM OLD.report OR NEW.report_digest IS DISTINCT FROM OLD.report_digest) THEN
    RAISE EXCEPTION 'purpose-bound assignment report is immutable';
  END IF;
  IF OLD.decision_ref IS NOT NULL AND (NEW.decision_ref IS DISTINCT FROM OLD.decision_ref OR NEW.decision IS DISTINCT FROM OLD.decision) THEN
    RAISE EXCEPTION 'purpose-bound assignment decision is immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER vnext_assignment_identity_immutable_trigger
  BEFORE UPDATE ON vnext_assignments
  FOR EACH ROW EXECUTE FUNCTION vnext_assignment_identity_immutable();

CREATE FUNCTION vnext_supersede_assignments_on_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.work_revision IS DISTINCT FROM OLD.work_revision THEN
    UPDATE vnext_assignments SET status='superseded',updated_at=clock_timestamp()
      WHERE work_unit_id=NEW.work_unit_id AND work_revision<>NEW.work_revision AND status<>'superseded';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER vnext_work_revision_supersedes_assignments
  AFTER UPDATE OF work_revision ON vnext_work_units
  FOR EACH ROW EXECUTE FUNCTION vnext_supersede_assignments_on_revision();

CREATE FUNCTION vnext_supersede_assignments_on_execution() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.last_execution_id IS DISTINCT FROM OLD.last_execution_id THEN
    UPDATE vnext_assignments SET status='superseded',updated_at=clock_timestamp()
      WHERE work_unit_id=NEW.work_unit_id AND subject_execution_id IS DISTINCT FROM NEW.last_execution_id AND status<>'superseded';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER vnext_work_execution_supersedes_assignments
  AFTER UPDATE OF last_execution_id ON vnext_work_units
  FOR EACH ROW EXECUTE FUNCTION vnext_supersede_assignments_on_execution();

CREATE FUNCTION vnext_supersede_assignments_on_input() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE vnext_assignments SET status='superseded',updated_at=clock_timestamp()
    WHERE work_unit_id=NEW.work_unit_id AND input_seq<NEW.input_seq AND status<>'superseded';
  RETURN NEW;
END $$;
CREATE TRIGGER vnext_pilot_input_supersedes_assignments
  AFTER INSERT ON vnext_pilot_inputs
  FOR EACH ROW EXECUTE FUNCTION vnext_supersede_assignments_on_input();

CREATE FUNCTION vnext_supersede_assignments_on_cancellation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE vnext_assignments SET status='superseded',updated_at=clock_timestamp()
    WHERE work_unit_id=NEW.work_unit_id AND work_revision=NEW.work_revision AND status<>'superseded';
  RETURN NEW;
END $$;
CREATE TRIGGER vnext_cancellation_supersedes_assignments
  AFTER INSERT ON vnext_cancellation_intents
  FOR EACH ROW EXECUTE FUNCTION vnext_supersede_assignments_on_cancellation();
