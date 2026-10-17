-- Forward-only continuation proposals for the GAS email runtime. The
-- checksum-pinned bootstrap schema (deploy/gas-email/schema.sql) and the
-- historical 002-006 upgrades are never changed; this upgrade replaces only
-- the deepest function in the public RPC chain
-- (gas_email_rpc -> gas_email_rpc_delivery -> gas_email_rpc_bootstrap).
--
-- A successful nonterminal checkpoint no longer schedules its own successor
-- through vnext_pilot_progress.next_wake_at. It records a durable, bounded
-- proposal bound to the trusted instance, project, execution, fence, and
-- captured input snapshot (the attempt's gas_email_turns row). The LLM-free
-- coordinator (the claim operation) may consider a proposal only after its
-- cooldown and within the existing three-attempt snapshot budget, and consumes
-- it only during authorized admission, atomically with execution creation and
-- authority acquisition. Waiting proposals stay durable and quiet until new
-- human input makes the Work Unit eligible independently. Exact checkpoint
-- replay returns the recorded settlement before any proposal is created.
--
-- Backfill: legacy authorized continuations (actionable Work Units with a
-- positive schedule) become equivalent continue proposals so an upgrade can
-- neither strand an already-authorized continuation nor manufacture new work
-- from historical completed or waiting turns. Only the schedule is converted;
-- every other historical record is untouched.
CREATE TABLE public.gas_email_continuations (
 instance_id text NOT NULL REFERENCES public.gas_email_instances,
 execution_id text NOT NULL REFERENCES public.vnext_executions,
 project_id text NOT NULL,
 work_unit_id text NOT NULL REFERENCES public.vnext_work_units,
 fence bigint NOT NULL,
 input_seq bigint NOT NULL REFERENCES public.vnext_pilot_inputs,
 kind text NOT NULL CHECK(kind IN ('continue','waiting')),
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','consumed','superseded')),
 eligible_after timestamptz,
 consumed_by text REFERENCES public.vnext_executions,
 consumed_at timestamptz,
 superseded_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(instance_id,execution_id),
 CHECK((kind='continue')=(eligible_after IS NOT NULL))
);
REVOKE ALL ON public.gas_email_continuations FROM PUBLIC,authenticated,anonymous;
CREATE INDEX gas_email_continuations_pending ON public.gas_email_continuations(work_unit_id) WHERE state='pending';

INSERT INTO public.gas_email_continuations(instance_id,execution_id,project_id,work_unit_id,fence,input_seq,kind,eligible_after)
SELECT i.instance_id,w.last_execution_id,w.project_id,w.work_unit_id,w.fence,p.consumed_input_seq,'continue',p.next_wake_at
FROM public.vnext_work_units w
JOIN public.vnext_pilot_progress p USING(work_unit_id)
JOIN public.gas_email_threads g USING(work_unit_id)
JOIN public.gas_email_instances i USING(instance_id)
WHERE w.state='actionable' AND p.next_wake_at IS NOT NULL AND w.last_execution_id IS NOT NULL AND w.claim_execution_id IS NULL;

UPDATE public.vnext_pilot_progress SET next_wake_at=NULL,updated_at=clock_timestamp()
WHERE work_unit_id IN (SELECT work_unit_id FROM public.gas_email_continuations WHERE state='pending');

CREATE OR REPLACE FUNCTION public.gas_email_rpc_bootstrap(p_instance text,p_operation text,p_input jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE
 i public.gas_email_instances; w public.vnext_work_units; a public.vnext_project_mutation_authority;
 o public.gas_email_outbox; r public.gas_email_receipts; t public.gas_email_turns; s public.gas_email_settlements;
 seq bigint; consumed bigint; id text; wid text; envelope jsonb; turn jsonb;
 response text; disposition text; work_state text;
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
    'quarantined',(SELECT count(*) FROM public.gas_email_quarantine WHERE instance_id=i.instance_id),
    'failed',(SELECT count(*) FROM public.vnext_executions WHERE project_id=i.project_id AND state IN ('failed','expired')),
    'review',(SELECT count(*) FROM public.vnext_work_units WHERE project_id=i.project_id AND state='review'),
    'blocked',EXISTS(SELECT 1 FROM public.vnext_project_reconciliation_blocks WHERE project_id=i.project_id));
 ELSIF p_operation='quarantine' THEN
   INSERT INTO public.gas_email_quarantine(instance_id,message_id,reason)
     VALUES(i.instance_id,p_input->>'id','intake-rejected') ON CONFLICT DO NOTHING;
   RETURN jsonb_build_object('status','quarantined');
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
     UPDATE public.vnext_pilot_progress SET failed_through_seq=(SELECT t2.input_seq FROM public.gas_email_turns t2 WHERE t2.execution_id=a.execution_id AND t2.instance_id=i.instance_id),next_wake_at=NULL WHERE work_unit_id=a.work_unit_id;
     DELETE FROM public.vnext_project_mutation_authority WHERE project_id=i.project_id;
   END IF;
   IF EXISTS(SELECT 1 FROM public.gas_email_outbox WHERE instance_id=i.instance_id AND state IN ('pending','admitted')) THEN RETURN jsonb_build_object('status','delivery-first'); END IF;
   -- Discovery evaluates proposals without mutating them: a pending continue
   -- proposal is eligible only after its cooldown, only for the exact source
   -- attempt (execution and recorded fence), only without newer input than the
   -- captured snapshot, and only within the existing three-attempt budget.
   SELECT u.* INTO w FROM public.vnext_work_units u JOIN public.gas_email_threads g USING(work_unit_id)
     JOIN public.vnext_pilot_progress p USING(work_unit_id)
     WHERE g.instance_id=i.instance_id AND u.claim_execution_id IS NULL AND
       (EXISTS(SELECT 1 FROM public.vnext_pilot_inputs x WHERE x.work_unit_id=u.work_unit_id AND x.input_seq>greatest(p.consumed_input_seq,p.failed_through_seq,p.recovery_commissioned_seq))
        OR (u.state='actionable' AND EXISTS(SELECT 1 FROM public.gas_email_continuations c WHERE c.work_unit_id=u.work_unit_id AND c.state='pending' AND c.kind='continue' AND c.eligible_after<=clock_timestamp() AND c.execution_id=u.last_execution_id AND c.fence=(SELECT e.fence FROM public.vnext_executions e WHERE e.execution_id=c.execution_id) AND NOT EXISTS(SELECT 1 FROM public.vnext_pilot_inputs nx WHERE nx.work_unit_id=u.work_unit_id AND nx.input_seq>c.input_seq) AND (SELECT count(*) FROM public.gas_email_turns tt WHERE tt.input_seq=c.input_seq)<3)))
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
   -- Consumption happens only here, inside authorized admission, at the same
   -- evaluated state as candidate selection above. The successor's turn row is
   -- not yet recorded, so the budget predicate matches selection exactly. Any
   -- other pending proposal is superseded by this admitted successor.
   UPDATE public.gas_email_continuations AS c SET state='consumed',consumed_by=id,consumed_at=clock_timestamp()
     WHERE c.work_unit_id=w.work_unit_id AND c.state='pending' AND c.kind='continue' AND c.eligible_after<=clock_timestamp()
       AND c.execution_id=w.last_execution_id
       AND c.fence=(SELECT e.fence FROM public.vnext_executions e WHERE e.execution_id=c.execution_id)
       AND NOT EXISTS(SELECT 1 FROM public.vnext_pilot_inputs nx WHERE nx.work_unit_id=w.work_unit_id AND nx.input_seq>c.input_seq)
       AND (SELECT count(*) FROM public.gas_email_turns tt WHERE tt.input_seq=c.input_seq)<3;
   UPDATE public.gas_email_continuations SET state='superseded',superseded_at=clock_timestamp()
     WHERE work_unit_id=w.work_unit_id AND state='pending';
   INSERT INTO public.gas_email_turns VALUES(id,seq,i.instance_id);
   UPDATE public.vnext_pilot_progress SET recovery_commissioned_seq=(SELECT max(input_seq) FROM public.vnext_pilot_inputs WHERE work_unit_id=w.work_unit_id) WHERE work_unit_id=w.work_unit_id AND failed_through_seq>0;
   SELECT consumed_input_seq INTO consumed FROM public.vnext_pilot_progress WHERE work_unit_id=w.work_unit_id;
   RETURN jsonb_build_object('status','claimed','execution_id',id,'fence',w.fence,'previous',w.last_turn,
     'objective',(SELECT message FROM public.vnext_pilot_inputs WHERE work_unit_id=w.work_unit_id ORDER BY input_seq LIMIT 1),
     'inputs',(SELECT jsonb_agg(z ORDER BY z.input_seq) FROM
       (SELECT input_seq,message FROM public.vnext_pilot_inputs WHERE work_unit_id=w.work_unit_id AND input_seq<=seq AND input_seq>consumed ORDER BY input_seq LIMIT 3) z));
 ELSIF p_operation IN ('checkpoint','failure') THEN
   IF p_operation='checkpoint' THEN
     -- Exact replay returns the recorded settlement even after later work has
     -- progressed (successor admission, newer input, later revisions). Divergent
     -- content under the same identity is rejected without mutation, and a lost
     -- COMMIT response is resolved here by durable inspection.
     SELECT * INTO s FROM public.gas_email_settlements WHERE instance_id=i.instance_id AND execution_id=p_input->>'execution_id';
     IF FOUND THEN
       turn:=public.gas_email_normalize_turn(p_input->'turn');
       IF s.fence::text IS DISTINCT FROM p_input->>'fence' OR s.turn IS DISTINCT FROM turn THEN RAISE EXCEPTION 'settlement content conflict'; END IF;
       RETURN jsonb_build_object('status','settled','replay',true,'execution_id',s.execution_id,'fence',s.fence,
         'disposition',s.turn->>'disposition','work_state',s.work_state,'input_seq',s.input_seq,'settled_at',s.created_at);
     END IF;
   END IF;
   SELECT * INTO a FROM public.vnext_project_mutation_authority WHERE project_id=i.project_id FOR UPDATE;
   IF NOT FOUND OR a.execution_id IS DISTINCT FROM p_input->>'execution_id' OR a.owner<>i.instance_id
     OR a.fence::text IS DISTINCT FROM p_input->>'fence' OR a.claim_expires_at<=clock_timestamp() THEN RAISE EXCEPTION 'stale email fence'; END IF;
   SELECT * INTO w FROM public.vnext_work_units WHERE work_unit_id=a.work_unit_id FOR UPDATE;
   SELECT * INTO t FROM public.gas_email_turns WHERE execution_id=a.execution_id AND instance_id=i.instance_id;
   IF NOT FOUND THEN RAISE EXCEPTION 'not an email turn'; END IF;
   IF p_operation='checkpoint' THEN
     turn:=public.gas_email_normalize_turn(p_input->'turn'); disposition:=turn->>'disposition';
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
   work_state:=CASE
     WHEN EXISTS(SELECT 1 FROM public.vnext_pilot_inputs WHERE work_unit_id=w.work_unit_id AND input_seq>t.input_seq) THEN 'actionable'
     WHEN disposition='done' THEN 'review' WHEN disposition='continue' THEN 'actionable' ELSE 'waiting' END;
   UPDATE public.vnext_pilot_progress SET consumed_input_seq=CASE WHEN p_operation='checkpoint' THEN t.input_seq ELSE consumed_input_seq END,
     failed_through_seq=CASE WHEN p_operation='failure' THEN t.input_seq ELSE 0 END,
     recovery_commissioned_seq=CASE WHEN p_operation='failure' THEN recovery_commissioned_seq ELSE 0 END,
     next_wake_at=NULL,updated_at=clock_timestamp() WHERE work_unit_id=w.work_unit_id;
   UPDATE public.vnext_work_units SET state=work_state,
     claim_execution_id=NULL,claim_owner=NULL,claim_fence=NULL,claim_expires_at=NULL,
     last_execution_id=CASE WHEN p_operation='checkpoint' THEN a.execution_id ELSE last_execution_id END,
     last_turn=CASE WHEN p_operation='checkpoint' THEN turn ELSE last_turn END,
     updated_at=clock_timestamp() WHERE work_unit_id=w.work_unit_id;
   IF p_operation='checkpoint' THEN
     INSERT INTO public.gas_email_settlements(instance_id,execution_id,project_id,work_unit_id,fence,input_seq,turn,work_state,next_wake_at)
       VALUES(i.instance_id,a.execution_id,i.project_id,w.work_unit_id,a.fence,t.input_seq,turn,work_state,NULL);
     -- The settlement records the bounded continuation proposal in the same
     -- transaction. done creates none (review is not continuation), and the
     -- snapshot budget suppresses proposals beyond the third attempt.
     IF disposition='continue' THEN
       INSERT INTO public.gas_email_continuations(instance_id,execution_id,project_id,work_unit_id,fence,input_seq,kind,eligible_after)
         SELECT i.instance_id,a.execution_id,i.project_id,w.work_unit_id,a.fence,t.input_seq,'continue',clock_timestamp()+interval '5 minutes'
         WHERE (SELECT count(*) FROM public.gas_email_turns WHERE input_seq=t.input_seq)<3;
     ELSIF disposition='waiting' THEN
       INSERT INTO public.gas_email_continuations(instance_id,execution_id,project_id,work_unit_id,fence,input_seq,kind,eligible_after)
         VALUES(i.instance_id,a.execution_id,i.project_id,w.work_unit_id,a.fence,t.input_seq,'waiting',NULL);
     END IF;
   END IF;
   UPDATE public.vnext_executions SET state=CASE WHEN p_operation='failure' THEN 'failed' ELSE 'succeeded' END,
     failure=CASE WHEN p_operation='failure' THEN '{"reason":"bounded-model-failure"}'::jsonb ELSE NULL END,
     finished_at=clock_timestamp() WHERE execution_id=a.execution_id;
   DELETE FROM public.vnext_project_mutation_authority WHERE project_id=i.project_id;
   RETURN jsonb_build_object('status','settled','replay',false,'execution_id',a.execution_id,'fence',a.fence,
     'disposition',disposition,'work_state',work_state,'input_seq',t.input_seq);
 ELSIF p_operation IN ('delivery','delivery-peek') THEN
   SELECT * INTO o FROM public.gas_email_outbox WHERE instance_id=i.instance_id AND state IN ('pending','admitted') ORDER BY created_at LIMIT 1 FOR UPDATE;
   IF NOT FOUND THEN RETURN jsonb_build_object('status','idle'); END IF;
   IF o.state='admitted' THEN RETURN jsonb_build_object('status','reconcile','execution_id',o.execution_id,'envelope',o.envelope); END IF;
   IF p_operation='delivery-peek' THEN RETURN jsonb_build_object('status','prepare','execution_id',o.execution_id,'envelope',o.envelope); END IF;
   IF p_input->>'execution_id' IS DISTINCT FROM o.execution_id THEN RAISE EXCEPTION 'stale delivery preparation'; END IF;
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

REVOKE ALL ON FUNCTION public.gas_email_rpc_bootstrap(text,text,jsonb) FROM PUBLIC,authenticated,anonymous;
