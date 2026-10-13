-- Preserve the authenticated entry point and all authoritative settlement checks.
ALTER FUNCTION public.gas_email_rpc(text,text,jsonb) RENAME TO gas_email_rpc_delivery;
REVOKE ALL ON FUNCTION public.gas_email_rpc_delivery(text,text,jsonb) FROM PUBLIC,authenticated,anonymous;
CREATE FUNCTION public.gas_email_rpc(p_instance text,p_operation text,p_input jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE i public.gas_email_instances; result jsonb; d jsonb; k text; v jsonb;
BEGIN
 i:=public.gas_email_principal(p_instance);
 IF jsonb_typeof(p_input) IS DISTINCT FROM 'object' OR octet_length(p_input::text)>60000 THEN RAISE EXCEPTION 'invalid email request'; END IF;
 IF p_operation='failure' AND p_input ? 'diagnostics' THEN
  d:=p_input->'diagnostics';
  IF jsonb_typeof(d) IS DISTINCT FROM 'object' OR octet_length(d::text)>2000 THEN RAISE EXCEPTION 'invalid diagnostics'; END IF;
  FOR k,v IN SELECT * FROM jsonb_each(d) LOOP
   IF NOT (CASE
    WHEN k='classification' THEN jsonb_typeof(v)='string' AND v#>>'{}' IN ('transport-error','response-too-large','invalid-json','authentication-denied','authorization-denied','rate-limited','provider-unavailable','http-error','model-validation','unclassified-error')
    WHEN k='code' THEN jsonb_typeof(v)='string' AND v#>>'{}' IN ('budget-before','budget-after','embedded-provider-error','missing-choice','missing-content','empty-content','truncated','content-filter','non-json','malformed-contract','field-bounds','utf8-byte-bounds','invalid-text')
    WHEN k='httpStatus' THEN v='null'::jsonb OR (jsonb_typeof(v)='number' AND v::text ~ '^[1-5][0-9]{2}$')
    WHEN k='finishReason' THEN jsonb_typeof(v)='string' AND v#>>'{}' IN ('stop','length','content_filter','tool_calls','function_call','unknown')
    WHEN k IN ('choicePresent','contentPresent') THEN jsonb_typeof(v)='boolean'
    WHEN k IN ('contentChars','contractBytes') THEN jsonb_typeof(v)='number' AND v::text ~ '^[0-9]{1,7}$' AND (v::text)::numeric<=1000000
    WHEN k='providerReason' THEN v='null'::jsonb OR v#>>'{}' IN ('serviceDisabled','accessNotConfigured','insufficientPermissions','invalidCredentials','rateLimitExceeded','userRateLimitExceeded','SERVICE_DISABLED','ACCESS_TOKEN_SCOPE_INSUFFICIENT','CREDENTIALS_MISSING','ACCESS_TOKEN_EXPIRED','SERVICE_USAGE_DENIED')
    WHEN k='sqlState' THEN v='null'::jsonb OR v#>>'{}' IN ('42501','28000','28P01','22023','22P02','23505','40001','40P01','57014','53300','53400')
    ELSE false END) THEN RAISE EXCEPTION 'invalid diagnostics'; END IF;
  END LOOP;
 END IF;
 -- Base call validates execution, owner, fence, expiry, and performs atomic settlement.
 result:=public.gas_email_rpc_delivery(p_instance,p_operation,p_input-'diagnostics');
 IF p_operation='failure' AND d IS NOT NULL THEN
  UPDATE public.vnext_executions SET failure=failure||jsonb_build_object('diagnostics',d)
   WHERE execution_id=p_input->>'execution_id' AND project_id=i.project_id AND state='failed';
 END IF;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.gas_email_rpc(text,text,jsonb) FROM PUBLIC,authenticated,anonymous;
GRANT EXECUTE ON FUNCTION public.gas_email_rpc(text,text,jsonb) TO authenticated;
CREATE UNIQUE INDEX gas_email_owner_retry_unique ON public.vnext_events((payload->>'retryId'))
 WHERE event_type='gas-email-owner-model-retry';
CREATE FUNCTION public.gas_email_preserve_owner_retry() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
 IF OLD.event_type='gas-email-owner-model-retry' THEN RAISE EXCEPTION 'immutable owner retry evidence'; END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.gas_email_preserve_owner_retry() FROM PUBLIC,authenticated,anonymous;
CREATE TRIGGER gas_email_owner_retry_immutable BEFORE UPDATE OR DELETE ON public.vnext_events
 FOR EACH ROW EXECUTE FUNCTION public.gas_email_preserve_owner_retry();
