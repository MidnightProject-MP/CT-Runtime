-- Forward-only extension. Never change the checksummed bootstrap sources.
ALTER TABLE public.gas_email_outbox ADD COLUMN provider_receipt text
 CHECK(provider_receipt ~ '^[a-zA-Z0-9_-]{1,100}$');
CREATE UNIQUE INDEX gas_email_provider_receipt_unique
 ON public.gas_email_outbox(provider_receipt) WHERE provider_receipt IS NOT NULL;
ALTER FUNCTION public.gas_email_rpc(text,text,jsonb) RENAME TO gas_email_rpc_bootstrap;
REVOKE ALL ON FUNCTION public.gas_email_rpc_bootstrap(text,text,jsonb) FROM PUBLIC,authenticated,anonymous;

CREATE FUNCTION public.gas_email_rpc(p_instance text,p_operation text,p_input jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE i public.gas_email_instances; o public.gas_email_outbox; result jsonb;
BEGIN
 i:=public.gas_email_principal(p_instance);
 IF jsonb_typeof(p_input) IS DISTINCT FROM 'object' OR octet_length(p_input::text)>60000 THEN
  RAISE EXCEPTION 'invalid email request';
 END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('ct-runtime:vnext-project:'||i.project_id,0));
 IF p_operation IN ('note-send-receipt','record') THEN
  PERFORM pg_advisory_xact_lock(hashtextextended('ct-runtime:gas-email-provider:'||coalesce(p_input->>'gmail_id',''),0));
  SELECT b.* INTO o FROM public.gas_email_outbox b JOIN public.vnext_executions e USING(execution_id)
   WHERE b.execution_id=p_input->>'execution_id' AND b.instance_id=i.instance_id
    AND e.project_id=i.project_id AND e.work_unit_id=b.work_unit_id FOR UPDATE OF b;
  IF NOT FOUND OR o.state NOT IN ('admitted','sent')
   OR coalesce(p_input->>'gmail_id','') !~ '^[a-zA-Z0-9_-]{1,100}$'
   OR p_input->>'messageId' IS DISTINCT FROM o.envelope->>'messageId'
   OR p_input->>'threadId' IS DISTINCT FROM o.envelope->>'threadId'
   OR (o.provider_receipt IS NOT NULL AND o.provider_receipt IS DISTINCT FROM p_input->>'gmail_id')
   OR (o.gmail_id IS NOT NULL AND o.gmail_id IS DISTINCT FROM p_input->>'gmail_id')
   OR EXISTS(SELECT 1 FROM public.gas_email_outbox b WHERE b.execution_id<>o.execution_id
    AND (b.provider_receipt=p_input->>'gmail_id' OR b.gmail_id=p_input->>'gmail_id')) THEN
   RAISE EXCEPTION 'invalid delivery evidence';
  END IF;
  IF p_operation='note-send-receipt' THEN
   IF o.state<>'admitted' THEN RAISE EXCEPTION 'receipt requires admitted delivery'; END IF;
   UPDATE public.gas_email_outbox SET provider_receipt=p_input->>'gmail_id' WHERE execution_id=o.execution_id;
   RETURN jsonb_build_object('status','noted');
  END IF;
 END IF;
 result:=public.gas_email_rpc_bootstrap(p_instance,p_operation,p_input);
 IF p_operation='delivery-peek' AND result->>'status'='reconcile' THEN
  result:=result||jsonb_build_object('providerReceipt',(SELECT provider_receipt FROM public.gas_email_outbox
   WHERE execution_id=result->>'execution_id' AND instance_id=i.instance_id));
 END IF;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.gas_email_rpc(text,text,jsonb) FROM PUBLIC,authenticated,anonymous;
GRANT EXECUTE ON FUNCTION public.gas_email_rpc(text,text,jsonb) TO authenticated;

-- Operator evidence is append-only and is never confused with provider receipts.
CREATE UNIQUE INDEX gas_email_owner_repair_event_unique ON public.vnext_events((payload->>'repairId'))
 WHERE event_type='gas-email-owner-delivery-repair';
CREATE FUNCTION public.gas_email_preserve_owner_repair() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
 IF OLD.event_type='gas-email-owner-delivery-repair' THEN RAISE EXCEPTION 'immutable owner repair evidence'; END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.gas_email_preserve_owner_repair() FROM PUBLIC,authenticated,anonymous;
CREATE TRIGGER gas_email_owner_repair_immutable BEFORE UPDATE OR DELETE ON public.vnext_events
 FOR EACH ROW EXECUTE FUNCTION public.gas_email_preserve_owner_repair();
