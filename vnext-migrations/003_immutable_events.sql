-- A2: the existing vNext event table becomes an immutable receipt surface.
-- event_id is the durable idempotency identity; event_type + payload are immutable content.
ALTER TABLE public.vnext_events
  ADD COLUMN IF NOT EXISTS event_id text;

-- 002_survivability already establishes this exact partial unique invariant.
-- Reuse it rather than creating a redundant second unique index.
CREATE UNIQUE INDEX IF NOT EXISTS vnext_events_event_id_idx
  ON public.vnext_events(event_id) WHERE event_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.vnext_append_immutable_event(
  p_event_id text,
  p_event_type text,
  p_payload jsonb
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  inserted boolean;
  existing public.vnext_events;
BEGIN
  IF p_event_id IS NULL OR p_event_id = '' THEN
    RAISE EXCEPTION 'event_id is required';
  END IF;
  IF p_event_type IS NULL OR p_event_type = '' THEN
    RAISE EXCEPTION 'event_type is required';
  END IF;
  IF p_payload IS NULL OR pg_catalog.jsonb_typeof(p_payload) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'payload must be a JSON object';
  END IF;

  -- The currently authenticated GAS principal is intentionally narrower than a
  -- general event writer. A2 transports only Feedback receipts; later event
  -- families should get their own explicit authorization decision.
  IF public.federation_gas_instance_id() IS DISTINCT FROM 'gas-primary'
     OR p_event_type IS DISTINCT FROM 'external_input.received' THEN
    RAISE EXCEPTION 'event family not authorized';
  END IF;

  INSERT INTO public.vnext_events(event_id,event_type,payload)
  VALUES (p_event_id,p_event_type,p_payload)
  ON CONFLICT (event_id) DO NOTHING
  RETURNING true INTO inserted;

  IF inserted THEN
    RETURN 'inserted';
  END IF;

  SELECT * INTO existing
  FROM public.vnext_events
  WHERE event_id = p_event_id;

  IF existing.event_type = p_event_type AND existing.payload = p_payload THEN
    RETURN 'duplicate';
  END IF;

  RETURN 'integrity_conflict';
END;
$$;

REVOKE ALL ON public.vnext_events FROM PUBLIC, authenticated, anonymous;
REVOKE ALL ON FUNCTION public.vnext_append_immutable_event(text,text,jsonb) FROM PUBLIC, authenticated, anonymous;
GRANT EXECUTE ON FUNCTION public.vnext_append_immutable_event(text,text,jsonb) TO authenticated;
