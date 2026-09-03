-- Keep physical execution edges inside one logical work order. Runtime code
-- also validates these relationships before allocating a new fence.
ALTER TABLE public.federation_executions
  ADD CONSTRAINT federation_executions_work_order_id_execution_id_key UNIQUE (work_order_id, execution_id);

ALTER TABLE public.federation_handoffs
  ADD CONSTRAINT federation_handoffs_from_same_work_order_fk
    FOREIGN KEY (work_order_id, from_execution_id)
    REFERENCES public.federation_executions(work_order_id, execution_id),
  ADD CONSTRAINT federation_handoffs_to_same_work_order_fk
    FOREIGN KEY (work_order_id, to_execution_id)
    REFERENCES public.federation_executions(work_order_id, execution_id);

-- A GAS checkpoint is an authoritative mutation too. Locking the logical row
-- and requiring the current fence prevents a stale checkpoint from committing
-- after a foreground takeover.
CREATE OR REPLACE FUNCTION public.federation_checkpoint_for_gas(p_advisory_text text,p_body_digest text,p_checkpoint_text text,p_checkpoint_digest text,p_fence bigint)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE a public.federation_advisories; w public.federation_work_orders; e public.federation_executions; advisory jsonb; v_checkpoint jsonb; sub text := public.federation_jwt_sub(); instance text := public.federation_gas_instance_id(); canonical_digest text;
BEGIN
  advisory:=p_advisory_text::jsonb; v_checkpoint:=p_checkpoint_text::jsonb;
  SELECT * INTO a FROM public.federation_advisories WHERE nonce=advisory->>'nonce' AND state='pending' FOR UPDATE;
  IF a.advisory_id IS NULL THEN RETURN pg_catalog.jsonb_build_object('status','already-consumed'); END IF;
  SELECT * INTO w FROM public.federation_work_orders WHERE work_order_id=a.work_order_id FOR UPDATE;
  SELECT * INTO e FROM public.federation_executions WHERE execution_id=a.target_execution_id AND work_order_id=a.work_order_id FOR UPDATE;
  IF sub IS NULL OR instance IS NULL OR a.instance_id<>instance OR e.claim_owner<>instance OR e.claim_fence<>p_fence OR e.claim_fence<>w.next_claim_fence OR e.lease_until<=pg_catalog.clock_timestamp() THEN RETURN pg_catalog.jsonb_build_object('status','fence-rejected'); END IF;
  IF p_advisory_text IS NULL OR p_advisory_text<>a.advisory_body OR p_body_digest IS NULL OR p_body_digest !~ '^[a-f0-9]{64}$' OR pg_catalog.encode(public.digest(pg_catalog.convert_to(p_advisory_text,'UTF8'),'sha256'),'hex')<>p_body_digest OR a.body_digest IS DISTINCT FROM p_body_digest OR advisory IS NULL OR pg_catalog.jsonb_typeof(advisory)<>'object' OR advisory<>a.advisory_body::jsonb THEN RETURN pg_catalog.jsonb_build_object('status','advisory-digest-rejected'); END IF;
  IF p_checkpoint_digest IS NULL OR p_checkpoint_digest !~ '^[a-f0-9]{64}$' OR pg_catalog.encode(public.digest(pg_catalog.convert_to(p_checkpoint_text,'UTF8'),'sha256'),'hex')<>p_checkpoint_digest OR v_checkpoint IS NULL OR pg_catalog.jsonb_typeof(v_checkpoint)<>'object' OR pg_catalog.octet_length(p_checkpoint_text)>8192 THEN RETURN pg_catalog.jsonb_build_object('status','checkpoint-digest-rejected'); END IF;
  canonical_digest:=pg_catalog.encode(public.digest(pg_catalog.convert_to(v_checkpoint::text,'UTF8'),'sha256'),'hex');
  UPDATE public.federation_executions AS target SET checkpoint=v_checkpoint,lineage=pg_catalog.jsonb_set(coalesce(target.lineage,'{}'::jsonb),'{gas}',pg_catalog.jsonb_build_object('physicalExecutionId',v_checkpoint->>'physicalExecutionId','continuationId',v_checkpoint->>'continuationId','evidence',coalesce(v_checkpoint->'evidence','[]'::jsonb),'checkpointDigest',p_checkpoint_digest,'canonicalCheckpointDigest',canonical_digest,'sourceCheckpointDigest',a.checkpoint_digest,'reconstructedAt',pg_catalog.clock_timestamp()),true),state='deferred',lease_until=NULL,updated_at=pg_catalog.clock_timestamp() WHERE target.execution_id=e.execution_id;
  INSERT INTO public.federation_events(event_id,work_order_id,execution_id,event_type,payload) VALUES ('event-'||public.gen_random_uuid()::text,a.work_order_id,e.execution_id,'gas-checkpointed',pg_catalog.jsonb_build_object('checkpointDigest',p_checkpoint_digest,'advisory',a.advisory_id,'state','deferred'));
  UPDATE public.federation_advisories SET state='consumed',consumed_at=pg_catalog.clock_timestamp() WHERE advisory_id=a.advisory_id;
  RETURN pg_catalog.jsonb_build_object('status','checkpointed','executionId',e.execution_id,'fence',e.claim_fence,'checkpointDigest',p_checkpoint_digest,'state','deferred');
END $$;

REVOKE ALL ON FUNCTION public.federation_checkpoint_for_gas(text,text,text,text,bigint) FROM PUBLIC,anonymous;
GRANT EXECUTE ON FUNCTION public.federation_checkpoint_for_gas(text,text,text,text,bigint) TO authenticated;
