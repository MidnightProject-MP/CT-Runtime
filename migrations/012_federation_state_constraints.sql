-- Keep the coordination database aligned with the federation state machine.
DO $$ BEGIN
  ALTER TABLE public.federation_work_orders ADD CONSTRAINT federation_work_orders_state_check CHECK (state IN ('ready','running','completed','failed')) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE public.federation_executions ADD CONSTRAINT federation_executions_state_check CHECK (state IN ('claimed','running','handoff','deferred','finalized','failed')) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
