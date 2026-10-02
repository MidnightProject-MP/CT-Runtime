-- Dedicated fresh bootstrap extension, NOT part of the sequential migration
-- directory. See bootstrap.json. Reuses the vNext kernel and pilot tables.
DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM pg_catalog.pg_tables WHERE schemaname='public' AND tablename NOT IN
   ('vnext_work_units','vnext_executions','vnext_continuations','vnext_evidence_refs','vnext_events',
    'vnext_project_mutation_authority','vnext_project_reconciliation_blocks',
    'vnext_pilot_progress','vnext_pilot_inputs','vnext_pilot_results'))
    OR EXISTS (SELECT 1 FROM public.vnext_work_units) THEN
   RAISE EXCEPTION 'GAS email bootstrap requires a fresh dedicated database';
 END IF;
END $$;
CREATE TABLE public.gas_email_instances (
 instance_id text PRIMARY KEY, jwt_sub text NOT NULL, jwt_aud text NOT NULL,
 project_id text NOT NULL UNIQUE, mailbox text NOT NULL,
 allowed_sender text NOT NULL, active boolean NOT NULL DEFAULT false,
 grant_ref text NOT NULL CHECK (length(grant_ref)>0),
 CHECK (mailbox <> allowed_sender)
);
CREATE TABLE public.gas_email_threads (
 work_unit_id text PRIMARY KEY REFERENCES public.vnext_work_units,
 instance_id text NOT NULL REFERENCES public.gas_email_instances,
 thread_id text NOT NULL, UNIQUE(instance_id,thread_id)
);
CREATE TABLE public.gas_email_receipts (
 instance_id text NOT NULL REFERENCES public.gas_email_instances,
 message_id text NOT NULL, input_seq bigint NOT NULL UNIQUE REFERENCES public.vnext_pilot_inputs,
 envelope jsonb NOT NULL, PRIMARY KEY(instance_id,message_id)
);
CREATE TABLE public.gas_email_turns (
 execution_id text PRIMARY KEY REFERENCES public.vnext_executions,
 input_seq bigint NOT NULL REFERENCES public.vnext_pilot_inputs,
 instance_id text NOT NULL REFERENCES public.gas_email_instances
);
CREATE TABLE public.gas_email_outbox (
 execution_id text PRIMARY KEY REFERENCES public.gas_email_turns,
 instance_id text NOT NULL REFERENCES public.gas_email_instances,
 work_unit_id text NOT NULL REFERENCES public.vnext_work_units,
 input_seq bigint NOT NULL REFERENCES public.vnext_pilot_inputs,
 envelope jsonb NOT NULL,
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','admitted','sent','superseded')),
 gmail_id text, created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

-- Only the Data API's verified Google JWT claims may populate this setting.
-- Never grant authenticated a SQL connection or arbitrary-SQL RPC.
CREATE FUNCTION public.gas_email_principal(p_instance text) RETURNS public.gas_email_instances
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE c jsonb; i public.gas_email_instances;
BEGIN
 c := nullif(current_setting('request.jwt.claims',true),'')::jsonb;
 SELECT * INTO i FROM public.gas_email_instances WHERE instance_id=p_instance AND active FOR SHARE;
 IF i.instance_id IS NULL OR c->>'sub' IS DISTINCT FROM i.jwt_sub
    OR c->>'aud' IS DISTINCT FROM i.jwt_aud
    OR coalesce(c->>'iss','') NOT IN ('https://accounts.google.com','accounts.google.com')
    OR coalesce((c->>'exp')::numeric,0) <= extract(epoch FROM clock_timestamp()) THEN
   RAISE EXCEPTION 'email principal denied' USING ERRCODE='42501';
 END IF;
 RETURN i;
END $$;

-- Fixed, bounded operations; no caller-supplied SQL, project, mailbox, authority
-- decisions, terminal flag, or reply destination. The registered grant owns these.
CREATE FUNCTION public.gas_email_rpc(p_instance text,p_operation text,p_input jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE
 i public.gas_email_instances; w public.vnext_work_units; a public.vnext_project_mutation_authority;
 o public.gas_email_outbox; r public.gas_email_receipts; t public.gas_email_turns;
 seq bigint; consumed bigint; id text; wid text; envelope jsonb; turn jsonb;
 response text; disposition text;
BEGIN
 i := public.gas_email_principal(p_instance);
 IF jsonb_typeof(p_input) IS DISTINCT FROM 'object' OR octet_length(p_input::text)>60000 THEN
   RAISE EXCEPTION 'invalid email request';
 END IF;
 -- Same project serialization order as the pilot authority. Also acquire the
 -- authority/Work Unit rows before updating them. Other hosts must be drained
 -- before enabling this explicitly GAS-only project grant.
 PERFORM pg_advisory_xact_lock(hashtextextended('ct-runtime:vnext-project:'||i.project_id,0));
 IF p_operation='health' THEN
   RETURN jsonb_build_object('instance',i.instance_id,'project',i.project_id,'mailbox',i.mailbox,
    'allowed_sender',i.allowed_sender,'grant_ref',i.grant_ref,
    'pending',(SELECT count(*) FROM public.gas_email_outbox WHERE instance_id=i.instance_id AND state='pending'),
    'uncertain',(SELECT count(*) FROM public.gas_email_outbox WHERE instance_id=i.instance_id AND state='admitted'),
    'failed',(SELECT count(*) FROM public.vnext_executions WHERE project_id=i.project_id AND state IN ('failed','expired')),
    'review',(SELECT count(*) FROM public.vnext_work_units WHERE project_id=i.project_id AND state='review'),
    'blocked',EXISTS(SELECT 1 FROM public.vnext_project_reconciliation_blocks WHERE project_id=i.project_id));
 ELSIF p_operation='ingest' THEN
   IF p_input->>'from' IS DISTINCT FROM i.allowed_sender OR p_input->>'to' IS DISTINCT FROM i.mailbox
      OR coalesce(p_input->>'id','') !~ '^[a-zA-Z0-9_-]{1,100}$'
      OR coalesce(p_input->>'threadId','') !~ '^[a-zA-Z0-9_-]{1,100}$'
      OR coalesce(p_input->>'reference','') !~ '^<[^<>[:space:]]{1,250}>$'
      OR jsonb_typeof(p_input->'body') IS DISTINCT FROM 'string'
      OR jsonb_typeof(p_input->'subject') IS DISTINCT FROM 'string'
      OR coalesce(length(p_input->>'body'),0) NOT BETWEEN 1 AND 16000
      OR coalesce(length(p_input->>'subject'),0) NOT BETWEEN 1 AND 500
      OR p_input->>'subject' ~ E'[\r\n]' THEN RAISE EXCEPTION 'invalid email envelope'; END IF;
   SELECT * INTO r FROM public.gas_email_receipts WHERE instance_id=i.instance_id AND message_id=p_input->>'id';
   IF FOUND THEN
     IF r.envelope IS DISTINCT FROM p_input THEN RAISE EXCEPTION 'email receipt integrity conflict'; END IF;
     RETURN jsonb_build_object('status','duplicate');
   END IF;
   SELECT work_unit_id INTO wid FROM public.gas_email_threads WHERE instance_id=i.instance_id AND thread_id=p_input->>'threadId';
   IF wid IS NULL THEN
     wid := 'gas-email-'||md5(i.instance_id||':'||(p_input->>'threadId'));
     INSERT INTO public.vnext_work_units(work_unit_id,objective_ref,state,project_id)
       VALUES(wid,'gmail:'||(p_input->>'threadId'),'actionable',i.project_id);
     INSERT INTO public.gas_email_threads VALUES(wid,i.instance_id,p_input->>'threadId');
     INSERT INTO public.vnext_pilot_progress(work_unit_id) VALUES(wid);
   END IF;
   INSERT INTO public.vnext_pilot_inputs(receipt_id,work_unit_id,message)
     VALUES('gas-email:'||i.instance_id||':'||(p_input->>'id'),wid,p_input->>'body') RETURNING input_seq INTO seq;
   INSERT INTO public.gas_email_receipts VALUES(i.instance_id,p_input->>'id',seq,p_input);
   UPDATE public.vnext_work_units SET state='actionable',updated_at=clock_timestamp() WHERE work_unit_id=wid;
   RETURN jsonb_build_object('status','inserted');
 ELSIF p_operation='claim' THEN
   IF EXISTS(SELECT 1 FROM public.vnext_project_reconciliation_blocks WHERE project_id=i.project_id) THEN RETURN jsonb_build_object('status','blocked'); END IF;
   SELECT * INTO a FROM public.vnext_project_mutation_authority WHERE project_id=i.project_id FOR UPDATE;
   IF FOUND THEN
     -- Expired text-only turns have no tools or external mutation. Unknown/non-email
     -- authorities are never stolen. No automatic takeover of an admitted send.
     IF a.claim_expires_at>clock_timestamp() OR NOT EXISTS(SELECT 1 FROM public.gas_email_turns WHERE execution_id=a.execution_id AND instance_id=i.instance_id) THEN
       RETURN jsonb_build_object('status','busy');
     END IF;
     UPDATE public.vnext_executions SET state='expired',finished_at=clock_timestamp(),failure='{"reason":"text-turn-expired"}' WHERE execution_id=a.execution_id;
     UPDATE public.vnext_work_units SET claim_execution_id=NULL,claim_owner=NULL,claim_fence=NULL,claim_expires_at=NULL,
       state='waiting',failure='{"reason":"text-turn-expired"}' WHERE work_unit_id=a.work_unit_id;
     UPDATE public.vnext_pilot_progress SET consumed_input_seq=(SELECT input_seq FROM public.gas_email_turns WHERE execution_id=a.execution_id),next_wake_at=NULL WHERE work_unit_id=a.work_unit_id;
     DELETE FROM public.vnext_project_mutation_authority WHERE project_id=i.project_id;
   END IF;
   IF EXISTS(SELECT 1 FROM public.gas_email_outbox WHERE instance_id=i.instance_id AND state IN ('pending','admitted')) THEN RETURN jsonb_build_object('status','delivery-first'); END IF;
   SELECT u.* INTO w FROM public.vnext_work_units u JOIN public.gas_email_threads g USING(work_unit_id)
     JOIN public.vnext_pilot_progress p USING(work_unit_id)
     WHERE g.instance_id=i.instance_id AND u.claim_execution_id IS NULL AND
       (EXISTS(SELECT 1 FROM public.vnext_pilot_inputs x WHERE x.work_unit_id=u.work_unit_id AND x.input_seq>p.consumed_input_seq)
        OR (u.state='actionable' AND p.next_wake_at<=clock_timestamp()))
     ORDER BY u.updated_at,u.work_unit_id LIMIT 1 FOR UPDATE OF u;
   IF NOT FOUND THEN RETURN jsonb_build_object('status','idle'); END IF;
   SELECT consumed_input_seq INTO consumed FROM public.vnext_pilot_progress WHERE work_unit_id=w.work_unit_id;
   SELECT max(input_seq) INTO seq FROM (SELECT input_seq FROM public.vnext_pilot_inputs WHERE work_unit_id=w.work_unit_id AND input_seq>consumed ORDER BY input_seq LIMIT 3) bounded;
   seq:=coalesce(seq,consumed);
   id := 'gas-turn-'||gen_random_uuid()::text;
   w.fence:=w.fence+1;
   INSERT INTO public.vnext_executions(execution_id,work_unit_id,project_id,owner,fence,state,started_at,claim_expires_at,authorization_decision_ref)
     VALUES(id,w.work_unit_id,i.project_id,i.instance_id,w.fence,'running',clock_timestamp(),clock_timestamp()+interval '8 minutes',i.grant_ref);
   UPDATE public.vnext_work_units SET fence=w.fence,claim_execution_id=id,claim_owner=i.instance_id,claim_fence=w.fence,
     claim_expires_at=(SELECT claim_expires_at FROM public.vnext_executions WHERE execution_id=id),attempt=attempt+1 WHERE work_unit_id=w.work_unit_id;
   INSERT INTO public.vnext_project_mutation_authority(project_id,work_unit_id,execution_id,fence,owner,claim_expires_at,authorization_decision_ref)
     SELECT project_id,work_unit_id,execution_id,fence,owner,claim_expires_at,authorization_decision_ref FROM public.vnext_executions WHERE execution_id=id;
   INSERT INTO public.gas_email_turns VALUES(id,seq,i.instance_id);
   SELECT consumed_input_seq INTO consumed FROM public.vnext_pilot_progress WHERE work_unit_id=w.work_unit_id;
   RETURN jsonb_build_object('status','claimed','execution_id',id,'fence',w.fence,'previous',w.last_turn,
     'objective',(SELECT message FROM public.vnext_pilot_inputs WHERE work_unit_id=w.work_unit_id ORDER BY input_seq LIMIT 1),
     'inputs',(SELECT jsonb_agg(z ORDER BY z.input_seq) FROM
       (SELECT input_seq,message FROM public.vnext_pilot_inputs WHERE work_unit_id=w.work_unit_id AND input_seq<=seq AND input_seq>consumed ORDER BY input_seq LIMIT 3) z));
 ELSIF p_operation IN ('checkpoint','failure') THEN
   SELECT * INTO a FROM public.vnext_project_mutation_authority WHERE project_id=i.project_id FOR UPDATE;
   IF NOT FOUND OR a.execution_id IS DISTINCT FROM p_input->>'execution_id' OR a.owner<>i.instance_id
     OR a.fence::text IS DISTINCT FROM p_input->>'fence' OR a.claim_expires_at<=clock_timestamp() THEN RAISE EXCEPTION 'stale email fence'; END IF;
   SELECT * INTO w FROM public.vnext_work_units WHERE work_unit_id=a.work_unit_id FOR UPDATE;
   SELECT * INTO t FROM public.gas_email_turns WHERE execution_id=a.execution_id AND instance_id=i.instance_id;
   IF NOT FOUND THEN RAISE EXCEPTION 'not an email turn'; END IF;
   IF p_operation='checkpoint' THEN
     turn:=p_input->'turn'; disposition:=turn->>'disposition';
     IF jsonb_typeof(turn) IS DISTINCT FROM 'object' OR coalesce(disposition,'') NOT IN ('waiting','continue','done')
       OR jsonb_typeof(turn->'summary') IS DISTINCT FROM 'string'
       OR (turn ? 'question' AND jsonb_typeof(turn->'question') IS DISTINCT FROM 'string')
       OR (turn ? 'artifact' AND jsonb_typeof(turn->'artifact') IS DISTINCT FROM 'string')
       OR coalesce(length(btrim(turn->>'summary')),0) NOT BETWEEN 1 AND 4000
       OR length(turn->>'summary')>4000
       OR coalesce(length(turn->>'question'),0)>1000 OR coalesce(length(turn->>'artifact'),0)>3000
       OR (disposition='waiting' AND coalesce(length(btrim(turn->>'question')),0)=0)
       OR octet_length(turn::text)>16000 THEN RAISE EXCEPTION 'invalid bounded turn'; END IF;
     turn:=jsonb_build_object('disposition',disposition,'summary',turn->>'summary','question',coalesce(turn->>'question',''),'artifact',coalesce(turn->>'artifact',''));
     response:=CASE WHEN disposition='done' THEN 'Draft outcome — pending human review.'||chr(10)||chr(10) ELSE '' END ||(turn->>'summary')
       ||CASE WHEN turn->>'question'<>'' THEN chr(10)||chr(10)||(turn->>'question') ELSE '' END
       ||CASE WHEN turn->>'artifact'<>'' THEN chr(10)||chr(10)||(turn->>'artifact') ELSE '' END;
     SELECT r2.envelope INTO envelope FROM public.gas_email_receipts r2 WHERE r2.input_seq=t.input_seq;
     envelope:=envelope-'body'||jsonb_build_object('body',response,'messageId','<'||a.execution_id||'@ct-runtime.invalid>');
     INSERT INTO public.vnext_pilot_results(execution_id,work_unit_id,turn) VALUES(a.execution_id,w.work_unit_id,turn);
     INSERT INTO public.gas_email_outbox(execution_id,instance_id,work_unit_id,input_seq,envelope)
       VALUES(a.execution_id,i.instance_id,w.work_unit_id,t.input_seq,envelope);
   ELSE
     disposition:='waiting'; turn:=jsonb_build_object('disposition','waiting','summary','Model turn failed; new human input required.');
   END IF;
   UPDATE public.vnext_pilot_progress SET consumed_input_seq=t.input_seq,
     next_wake_at=CASE WHEN disposition='continue' AND (SELECT count(*) FROM public.gas_email_turns WHERE input_seq=t.input_seq)<3 THEN clock_timestamp()+interval '5 minutes' ELSE NULL END,updated_at=clock_timestamp() WHERE work_unit_id=w.work_unit_id;
   UPDATE public.vnext_work_units SET state=CASE
     WHEN EXISTS(SELECT 1 FROM public.vnext_pilot_inputs WHERE work_unit_id=w.work_unit_id AND input_seq>t.input_seq) THEN 'actionable'
     WHEN disposition='done' THEN 'review' WHEN disposition='continue' THEN 'actionable' ELSE 'waiting' END,
     claim_execution_id=NULL,claim_owner=NULL,claim_fence=NULL,claim_expires_at=NULL,last_execution_id=a.execution_id,last_turn=turn,
     updated_at=clock_timestamp() WHERE work_unit_id=w.work_unit_id;
   UPDATE public.vnext_executions SET state=CASE WHEN p_operation='failure' THEN 'failed' ELSE 'succeeded' END,
     failure=CASE WHEN p_operation='failure' THEN '{"reason":"bounded-model-failure"}'::jsonb ELSE NULL END,
     finished_at=clock_timestamp() WHERE execution_id=a.execution_id;
   DELETE FROM public.vnext_project_mutation_authority WHERE project_id=i.project_id;
   RETURN jsonb_build_object('status','settled');
 ELSIF p_operation='delivery' THEN
   SELECT * INTO o FROM public.gas_email_outbox WHERE instance_id=i.instance_id AND state IN ('pending','admitted') ORDER BY created_at LIMIT 1 FOR UPDATE;
   IF NOT FOUND THEN RETURN jsonb_build_object('status','idle'); END IF;
   IF o.state='admitted' THEN RETURN jsonb_build_object('status','reconcile','execution_id',o.execution_id,'envelope',o.envelope); END IF;
   IF EXISTS(SELECT 1 FROM public.vnext_project_mutation_authority WHERE project_id=i.project_id)
      OR EXISTS(SELECT 1 FROM public.vnext_project_reconciliation_blocks WHERE project_id=i.project_id) THEN RETURN jsonb_build_object('status','blocked'); END IF;
   IF EXISTS(SELECT 1 FROM public.vnext_pilot_inputs WHERE work_unit_id=o.work_unit_id AND input_seq>o.input_seq) THEN
     UPDATE public.gas_email_outbox SET state='superseded' WHERE execution_id=o.execution_id;
     RETURN jsonb_build_object('status','superseded');
   END IF;
   INSERT INTO public.vnext_project_reconciliation_blocks(project_id,work_unit_id,execution_id,fence,reason)
     SELECT project_id,work_unit_id,execution_id,fence,'external-effect-uncertain' FROM public.vnext_executions WHERE execution_id=o.execution_id;
   UPDATE public.gas_email_outbox SET state='admitted' WHERE execution_id=o.execution_id;
   RETURN jsonb_build_object('status','send','execution_id',o.execution_id,'envelope',o.envelope);
 ELSIF p_operation='record' THEN
   SELECT * INTO o FROM public.gas_email_outbox WHERE execution_id=p_input->>'execution_id' AND instance_id=i.instance_id FOR UPDATE;
   IF NOT FOUND OR o.state NOT IN ('admitted','sent') OR coalesce(p_input->>'gmail_id','') !~ '^[a-zA-Z0-9_-]{1,100}$'
     OR p_input->>'messageId' IS DISTINCT FROM o.envelope->>'messageId'
     OR p_input->>'threadId' IS DISTINCT FROM o.envelope->>'threadId' THEN RAISE EXCEPTION 'invalid delivery evidence'; END IF;
   IF o.state='sent' AND o.gmail_id IS DISTINCT FROM p_input->>'gmail_id' THEN RAISE EXCEPTION 'delivery evidence conflict'; END IF;
   UPDATE public.gas_email_outbox SET state='sent',gmail_id=p_input->>'gmail_id' WHERE execution_id=o.execution_id;
   DELETE FROM public.vnext_project_reconciliation_blocks WHERE project_id=i.project_id AND execution_id=o.execution_id;
   RETURN jsonb_build_object('status','sent');
 ELSE RAISE EXCEPTION 'unknown email operation'; END IF;
END $$;

REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC,authenticated,anonymous;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC,authenticated,anonymous;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC,authenticated,anonymous;
REVOKE CREATE ON SCHEMA public FROM PUBLIC,authenticated,anonymous;
GRANT USAGE ON SCHEMA public TO authenticated;
GRANT EXECUTE ON FUNCTION public.gas_email_rpc(text,text,jsonb) TO authenticated;
