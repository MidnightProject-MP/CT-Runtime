-- A project identity owns one canonical workspace tree. Coordinator admission
-- checks this registry under a shared advisory lock before preparing work.
CREATE TABLE IF NOT EXISTS vnext_project_workspace_bindings (
  project_id text PRIMARY KEY,
  workspace_root text NOT NULL,
  bound_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT vnext_project_workspace_bindings_project_id_check
    CHECK (length(project_id) BETWEEN 1 AND 160),
  CONSTRAINT vnext_project_workspace_bindings_root_check
    CHECK (workspace_root <> '')
);

CREATE INDEX IF NOT EXISTS vnext_project_workspace_bindings_root_idx
  ON vnext_project_workspace_bindings(workspace_root);
