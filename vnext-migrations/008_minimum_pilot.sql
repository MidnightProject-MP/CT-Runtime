-- One pilot inbox, durable eligibility, and immutable per-attempt results.
CREATE TABLE vnext_pilot_progress (
 work_unit_id text PRIMARY KEY REFERENCES vnext_work_units(work_unit_id),
 consumed_input_seq bigint NOT NULL DEFAULT 0 CHECK (consumed_input_seq >= 0),
 next_wake_at timestamptz,
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE vnext_pilot_inputs (
 input_seq bigserial PRIMARY KEY,
 receipt_id text NOT NULL UNIQUE,
 work_unit_id text NOT NULL REFERENCES vnext_pilot_progress(work_unit_id),
 message text NOT NULL CHECK (length(message) BETWEEN 1 AND 16000),
 received_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX vnext_pilot_inputs_work_idx ON vnext_pilot_inputs(work_unit_id,input_seq);
CREATE TABLE vnext_pilot_results (
 execution_id text PRIMARY KEY,
 work_unit_id text NOT NULL,
 turn jsonb NOT NULL,
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY (work_unit_id,execution_id) REFERENCES vnext_executions(work_unit_id,execution_id)
);
