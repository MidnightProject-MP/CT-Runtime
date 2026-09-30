-- Project-level protection for executions whose external effect is unresolved.
CREATE TABLE vnext_project_reconciliation_blocks (
  project_id text PRIMARY KEY,
  work_unit_id text NOT NULL,
  execution_id text NOT NULL,
  fence bigint NOT NULL CHECK (fence >= 1),
  reason text NOT NULL CHECK (reason = 'external-effect-uncertain'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT vnext_project_reconciliation_execution_fk
    FOREIGN KEY (work_unit_id, execution_id, project_id, fence)
    REFERENCES vnext_executions(work_unit_id, execution_id, project_id, fence)
);

CREATE INDEX vnext_project_reconciliation_execution_idx
  ON vnext_project_reconciliation_blocks(execution_id);
