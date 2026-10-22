-- Fair multi-project scheduling reads the most recent coordinator.pass event
-- per project. Keep that durable ordering query bounded without introducing a
-- second scheduling ledger.
CREATE INDEX IF NOT EXISTS vnext_events_coordinator_pass_project_idx
  ON vnext_events ((payload->>'project_id'), created_at DESC)
  WHERE event_type='coordinator.pass';
