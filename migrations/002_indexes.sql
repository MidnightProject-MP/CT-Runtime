CREATE INDEX IF NOT EXISTS runtime_events_execution_idx ON runtime_events(execution_id,occurred_at,event_id);
CREATE INDEX IF NOT EXISTS runtime_model_telemetry_execution_idx ON runtime_model_telemetry(execution_id,occurred_at,telemetry_id);
CREATE INDEX IF NOT EXISTS runtime_host_telemetry_execution_idx ON runtime_host_telemetry(execution_id,occurred_at);
CREATE INDEX IF NOT EXISTS runtime_evidence_execution_idx ON runtime_evidence(execution_id,created_at);
CREATE INDEX IF NOT EXISTS observer_lifecycle_execution_idx ON observer_lifecycle(execution_id,occurred_at);
