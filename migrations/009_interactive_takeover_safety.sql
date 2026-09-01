-- Preserve one mutation owner when a stale GAS advisory races an interactive
-- foreground takeover. NULL leases are expired, never reusable authority.
CREATE OR REPLACE FUNCTION public.federation_take_for_gas(p_advisory_text text,p_body_digest text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE a public.federation_advisories; w public.federation_work_orders; e public.federation_executions; h public.federation_handoffs;
DECLARE advisory jsonb; sub text := public.federation_jwt_sub(); instance text := public.federation_gas_instance_id(); new_fence bigint;
BEGIN
  advisory := p_advisory_text::jsonb;
  SELECT * INTO a FROM public.federation_advisories WHERE nonce=advisory->>'nonce' AND state='pending' FOR UPDATE;
  IF a.advisory_id IS NULL THEN RETURN pg_catalog.jsonb_build_object('status','already-consumed'); END IF;
  IF a.expires_at<=pg_catalog.clock_timestamp() THEN
    UPDATE public.federation_advisories SET state='rejected',consumed_at=pg_catalog.clock_timestamp() WHERE advisory_id=a.advisory_id;
    RETURN pg_catalog.jsonb_build_object('status','expired-or-unauthorized');
  END IF;
  IF sub IS NULL OR instance IS NULL OR a.instance_id<>instance OR
      p_advisory_text IS NULL OR p_advisory_text<>a.advisory_body OR p_body_digest IS NULL OR p_body_digest !~ '^[a-f0-9]{64}$' OR pg_catalog.encode(public.digest(pg_catalog.convert_to(p_advisory_text,'UTF8'),'sha256'),'hex')<>p_body_digest OR
      a.body_digest IS DISTINCT FROM p_body_digest OR pg_catalog.jsonb_typeof(advisory)<>'object' OR
     advisory->>'schema'<>a.advisory_schema OR (advisory->>'version')!~'^[0-9]+$' OR (advisory->>'version')::integer<>a.version OR
     advisory->>'nonce'<>a.nonce OR advisory->>'issuedAt'<>pg_catalog.to_char(a.issued_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') OR
     advisory->>'expiresAt'<>pg_catalog.to_char(a.expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') OR
     advisory->>'instanceId'<>a.instance_id OR advisory->>'workOrderId'<>a.work_order_id OR advisory->>'handoffId'<>a.handoff_id OR
     (advisory->>'handoffRevision')!~'^[0-9]+$' OR (advisory->>'handoffRevision')::bigint<>a.handoff_revision OR
     advisory->>'targetExecutionId'<>a.target_execution_id OR (advisory->>'targetFence')!~'^[0-9]+$' OR (advisory->>'targetFence')::bigint<>a.target_fence OR
     advisory->>'checkpointDigest'<>a.checkpoint_digest OR advisory->>'reason'<>a.reason
  THEN RETURN pg_catalog.jsonb_build_object('status','invalid-advisory'); END IF;
  SELECT * INTO w FROM public.federation_work_orders WHERE work_order_id=a.work_order_id FOR UPDATE;
  SELECT * INTO h FROM public.federation_handoffs WHERE handoff_id=a.handoff_id AND work_order_id=a.work_order_id AND revision=a.handoff_revision FOR UPDATE;
  SELECT * INTO e FROM public.federation_executions WHERE execution_id=a.target_execution_id AND work_order_id=a.work_order_id FOR UPDATE;
  IF w.work_order_id IS NULL OR h.handoff_id IS NULL OR e.execution_id IS NULL OR h.to_execution_id<>e.execution_id OR e.claim_fence<>a.target_fence THEN
    UPDATE public.federation_advisories SET state='rejected',consumed_at=pg_catalog.clock_timestamp() WHERE advisory_id=a.advisory_id;
    RETURN pg_catalog.jsonb_build_object('status','stale-target');
  END IF;
  IF coalesce(e.lease_until,'-infinity'::timestamptz)>pg_catalog.clock_timestamp() AND e.claim_owner IS DISTINCT FROM instance THEN
    UPDATE public.federation_advisories SET state='rejected',consumed_at=pg_catalog.clock_timestamp() WHERE advisory_id=a.advisory_id;
    RETURN pg_catalog.jsonb_build_object('status','competing-authority');
  END IF;
  IF coalesce(e.lease_until,'-infinity'::timestamptz)<=pg_catalog.clock_timestamp() AND EXISTS (SELECT 1 FROM public.federation_executions other WHERE other.work_order_id=w.work_order_id AND other.execution_id<>e.execution_id AND other.lease_until>pg_catalog.clock_timestamp() AND other.state IN ('claimed','running')) THEN
    UPDATE public.federation_advisories SET state='rejected',consumed_at=pg_catalog.clock_timestamp() WHERE advisory_id=a.advisory_id;
    RETURN pg_catalog.jsonb_build_object('status','competing-authority');
  END IF;
  IF coalesce(e.lease_until,'-infinity'::timestamptz)>pg_catalog.clock_timestamp() THEN
    UPDATE public.federation_executions SET lease_until=pg_catalog.clock_timestamp()+interval '5 minutes',state='running',updated_at=pg_catalog.clock_timestamp() WHERE execution_id=e.execution_id; new_fence:=e.claim_fence;
  ELSE
    UPDATE public.federation_work_orders SET next_claim_fence=next_claim_fence+1,updated_at=pg_catalog.clock_timestamp() WHERE work_order_id=w.work_order_id RETURNING next_claim_fence INTO new_fence;
    UPDATE public.federation_executions SET claim_owner=instance,claim_fence=new_fence,lease_until=pg_catalog.clock_timestamp()+interval '5 minutes',state='running',updated_at=pg_catalog.clock_timestamp() WHERE execution_id=e.execution_id;
  END IF;
  INSERT INTO public.federation_events(event_id,work_order_id,execution_id,event_type,payload) VALUES ('event-'||public.gen_random_uuid()::text,w.work_order_id,e.execution_id,'gas-taken',pg_catalog.jsonb_build_object('fence',new_fence,'instanceId',instance,'handoffId',a.handoff_id));
  RETURN pg_catalog.jsonb_build_object('status','taken','workOrderId',w.work_order_id,'executionId',e.execution_id,'handoffId',a.handoff_id,'handoffRevision',a.handoff_revision,'fence',new_fence,'checkpointDigest',a.checkpoint_digest);
END $$;

REVOKE ALL ON FUNCTION public.federation_take_for_gas(text,text) FROM PUBLIC,anonymous;
GRANT EXECUTE ON FUNCTION public.federation_take_for_gas(text,text) TO authenticated;

-- Record both the transport digest and a database-recomputable canonical JSONB
-- digest so later discovery can detect checkpoint mutation.
CREATE OR REPLACE FUNCTION public.federation_checkpoint_for_gas(p_advisory_text text,p_body_digest text,p_checkpoint_text text,p_checkpoint_digest text,p_fence bigint)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE a public.federation_advisories; e public.federation_executions; advisory jsonb; v_checkpoint jsonb; sub text := public.federation_jwt_sub(); instance text := public.federation_gas_instance_id(); canonical_digest text;
BEGIN
  advisory:=p_advisory_text::jsonb; v_checkpoint:=p_checkpoint_text::jsonb;
  SELECT * INTO a FROM public.federation_advisories WHERE nonce=advisory->>'nonce' AND state='pending' FOR UPDATE;
  IF a.advisory_id IS NULL THEN RETURN pg_catalog.jsonb_build_object('status','already-consumed'); END IF;
  SELECT * INTO e FROM public.federation_executions WHERE execution_id=a.target_execution_id AND work_order_id=a.work_order_id FOR UPDATE;
  IF sub IS NULL OR instance IS NULL OR a.instance_id<>instance OR e.claim_owner<>instance OR e.claim_fence<>p_fence OR e.lease_until<=pg_catalog.clock_timestamp() THEN RETURN pg_catalog.jsonb_build_object('status','fence-rejected'); END IF;
  IF p_advisory_text IS NULL OR p_advisory_text<>a.advisory_body OR p_body_digest IS NULL OR p_body_digest !~ '^[a-f0-9]{64}$' OR pg_catalog.encode(public.digest(pg_catalog.convert_to(p_advisory_text,'UTF8'),'sha256'),'hex')<>p_body_digest OR a.body_digest IS DISTINCT FROM p_body_digest OR advisory IS NULL OR pg_catalog.jsonb_typeof(advisory)<>'object' OR advisory<>a.advisory_body::jsonb THEN RETURN pg_catalog.jsonb_build_object('status','advisory-digest-rejected'); END IF;
  IF p_checkpoint_digest IS NULL OR p_checkpoint_digest !~ '^[a-f0-9]{64}$' OR pg_catalog.encode(public.digest(pg_catalog.convert_to(p_checkpoint_text,'UTF8'),'sha256'),'hex')<>p_checkpoint_digest OR v_checkpoint IS NULL OR pg_catalog.jsonb_typeof(v_checkpoint)<>'object' OR pg_catalog.octet_length(p_checkpoint_text)>8192 THEN RETURN pg_catalog.jsonb_build_object('status','checkpoint-digest-rejected'); END IF;
  canonical_digest:=pg_catalog.encode(public.digest(pg_catalog.convert_to(v_checkpoint::text,'UTF8'),'sha256'),'hex');
  UPDATE public.federation_executions AS target SET checkpoint=v_checkpoint,lineage=pg_catalog.jsonb_set(coalesce(target.lineage,'{}'::jsonb),'{gas}',pg_catalog.jsonb_build_object('physicalExecutionId',v_checkpoint->>'physicalExecutionId','continuationId',v_checkpoint->>'continuationId','evidence',coalesce(v_checkpoint->'evidence','[]'::jsonb),'checkpointDigest',p_checkpoint_digest,'canonicalCheckpointDigest',canonical_digest,'sourceCheckpointDigest',a.checkpoint_digest,'reconstructedAt',pg_catalog.clock_timestamp()),true),state='running',updated_at=pg_catalog.clock_timestamp() WHERE target.execution_id=e.execution_id;
  INSERT INTO public.federation_events(event_id,work_order_id,execution_id,event_type,payload) VALUES ('event-'||public.gen_random_uuid()::text,a.work_order_id,e.execution_id,'gas-checkpointed',pg_catalog.jsonb_build_object('checkpointDigest',p_checkpoint_digest,'advisory',a.advisory_id));
  UPDATE public.federation_advisories SET state='consumed',consumed_at=pg_catalog.clock_timestamp() WHERE advisory_id=a.advisory_id;
  RETURN pg_catalog.jsonb_build_object('status','checkpointed','executionId',e.execution_id,'fence',e.claim_fence,'checkpointDigest',p_checkpoint_digest);
END $$;

REVOKE ALL ON FUNCTION public.federation_checkpoint_for_gas(text,text,text,text,bigint) FROM PUBLIC,anonymous;
GRANT EXECUTE ON FUNCTION public.federation_checkpoint_for_gas(text,text,text,text,bigint) TO authenticated;
