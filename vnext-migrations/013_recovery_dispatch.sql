-- Durable launch identity for an in-flight attempt: recorded immediately after
-- the worker process is spawned, so a restarted coordinator can classify the
-- attempt (not launched / running / completed / unknown) from durable records
-- instead of timing assumptions. NULL means no spawn was ever confirmed.
ALTER TABLE vnext_executions ADD COLUMN launch jsonb
  CHECK (launch IS NULL OR (jsonb_typeof(launch) = 'object' AND octet_length(launch::text) <= 4096));
