ALTER TABLE public.federation_handoffs
  ADD COLUMN revision bigint NOT NULL DEFAULT 1;
