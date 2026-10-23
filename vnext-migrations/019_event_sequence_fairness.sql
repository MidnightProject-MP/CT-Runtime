-- Event identity is a durable monotonic ordering token; wall-clock timestamps
-- can move backward and must not decide which project was served least recently.
DROP INDEX IF EXISTS vnext_events_coordinator_pass_project_idx;

CREATE INDEX IF NOT EXISTS vnext_events_coordinator_pass_project_idx
  ON vnext_events ((payload->>'project_id'), id DESC)
  WHERE event_type='coordinator.pass';
