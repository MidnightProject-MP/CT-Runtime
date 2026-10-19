-- Coordinator-owned concurrency pool (Milestone 1D, item D2). One reservation
-- per admitted attempt, acquired in the same transaction as the project
-- mutation authority and released exactly when that authority settles;
-- authority already guarantees at most one reservation per project. Rows are
-- project-scoped so per-project bounds and an aggregate global cap can
-- compose later (2D). Capacity is coordinator configuration; enforcement is a
-- global count under the pool advisory lock.
CREATE TABLE IF NOT EXISTS vnext_concurrency_reservations (
 project_id text PRIMARY KEY,
 work_unit_id text NOT NULL,
 execution_id text NOT NULL,
 fence bigint NOT NULL CHECK (fence >= 1),
 owner text NOT NULL,
 reserved_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CONSTRAINT vnext_concurrency_reservations_execution_fk
   FOREIGN KEY (work_unit_id, execution_id, project_id, fence)
   REFERENCES vnext_executions(work_unit_id, execution_id, project_id, fence)
);

-- A reservation is only meaningful while the project mutation authority for
-- the same attempt exists. The check is per-row and deferred so direct SQL
-- cannot create a reservation without its authority, while legitimate
-- settlement deletes both in one transaction.
CREATE OR REPLACE FUNCTION vnext_assert_concurrency_reservation_authorized()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM vnext_project_mutation_authority AS a
    WHERE a.project_id = NEW.project_id
      AND a.work_unit_id = NEW.work_unit_id
      AND a.execution_id = NEW.execution_id
      AND a.fence = NEW.fence
      AND a.owner = NEW.owner
  ) THEN
    RAISE EXCEPTION 'vNext concurrency reservation requires a matching project mutation authority';
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS vnext_concurrency_reservation_authorized_trg ON vnext_concurrency_reservations;
CREATE CONSTRAINT TRIGGER vnext_concurrency_reservation_authorized_trg
  AFTER INSERT OR UPDATE ON vnext_concurrency_reservations
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION vnext_assert_concurrency_reservation_authorized();

CREATE INDEX IF NOT EXISTS vnext_concurrency_reservations_execution_idx
  ON vnext_concurrency_reservations(execution_id);

CREATE INDEX IF NOT EXISTS vnext_concurrency_reservations_reserved_idx
  ON vnext_concurrency_reservations(reserved_at);
