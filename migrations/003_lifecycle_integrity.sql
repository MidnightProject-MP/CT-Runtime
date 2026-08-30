ALTER TABLE runtime_executions ADD COLUMN IF NOT EXISTS recovery jsonb;
ALTER TABLE runtime_host_telemetry ADD COLUMN IF NOT EXISTS deployment_id text;
ALTER TABLE runtime_host_telemetry ADD COLUMN IF NOT EXISTS work_order text;

DO $$ BEGIN
  ALTER TABLE runtime_schedules ADD CONSTRAINT runtime_schedules_work_order_fk
    FOREIGN KEY (work_order) REFERENCES runtime_work_orders(work_order);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE runtime_host_telemetry ADD CONSTRAINT runtime_host_telemetry_execution_fk
    FOREIGN KEY (execution_id) REFERENCES runtime_executions(execution_id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE runtime_host_telemetry ADD CONSTRAINT runtime_host_telemetry_deployment_fk
    FOREIGN KEY (deployment_id) REFERENCES runtime_deployments(deployment_id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE runtime_host_telemetry ADD CONSTRAINT runtime_host_telemetry_work_order_fk
    FOREIGN KEY (work_order) REFERENCES runtime_work_orders(work_order);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE runtime_schedules ADD CONSTRAINT runtime_schedules_claim_shape CHECK (
  (state = 'claimed' AND claim_owner IS NOT NULL AND claim_fence IS NOT NULL AND claimed_at IS NOT NULL)
  OR state <> 'claimed'
);
