-- Forward-only send admission and cancellation boundary for the GAS email
-- runtime. Checksum-pinned bootstrap, 002-009, and the public RPC chain are
-- unchanged; this upgrade replaces only gas_email_rpc_bootstrap.
--
-- Delivery is the only transition that may authorize a Gmail send. It binds
-- the exact prepared outbox to the successful settled attempt, the current
-- Work Unit, the exact frozen envelope and deterministic Message-ID, and
-- records an immutable admission receipt in the same transaction as the
-- reconciliation block and outbox transition. Replay is historical evidence,
-- never another send.
--
-- Cancellation is a separate per-instance authority and an exact-replayable
-- decision over one captured input snapshot. A pending intent refuses
-- admission and closes the pending outbox without an external effect. A
-- cancellation recorded after admission is historical only: it neither claims
-- the sender stopped nor clears the admitted-send uncertainty.
CREATE TABLE public.gas_email_admissions (
 instance_id text NOT NULL REFERENCES public.gas_email_instances,
 execution_id text NOT NULL REFERENCES public.vnext_executions,
 project_id text NOT NULL,
 work_unit_id text NOT NULL REFERENCES public.vnext_work_units,
 fence bigint NOT NULL CHECK(fence>=1),
 input_seq bigint NOT NULL REFERENCES public.vnext_pilot_inputs,
 envelope_digest text NOT NULL CHECK(envelope_digest ~ '^[0-9a-f]{64}$'),
 admission_digest text NOT NULL CHECK(admission_digest ~ '^[0-9a-f]{64}$'),
 message_id text NOT NULL CHECK(message_id ~ '^<gas-turn-[a-z0-9-]+@ct-runtime[.]invalid>$'),
 admitted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(instance_id,execution_id),
 UNIQUE(instance_id,message_id),
 CONSTRAINT gas_email_admissions_execution_fk FOREIGN KEY(work_unit_id,execution_id,project_id,fence)
   REFERENCES public.vnext_executions(work_unit_id,execution_id,project_id,fence)
);
REVOKE ALL ON public.gas_email_admissions FROM PUBLIC,authenticated,anonymous;

CREATE FUNCTION public.gas_email_envelope_digest(p_envelope jsonb) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public AS $$
 SELECT encode(sha256(convert_to(p_envelope::text,'UTF8')),'hex')
$$;
REVOKE ALL ON FUNCTION public.gas_email_envelope_digest(jsonb) FROM PUBLIC,authenticated,anonymous;

CREATE FUNCTION public.gas_email_admission_digest(p_instance text,p_execution_id text,p_project_id text,p_work_unit_id text,p_fence bigint,p_input_seq bigint,p_envelope_digest text,p_message_id text) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public AS $$
 SELECT encode(sha256(convert_to(jsonb_build_object(
  'instance',p_instance,'execution_id',p_execution_id,'project_id',p_project_id,'work_unit_id',p_work_unit_id,
  'fence',p_fence,'input_seq',p_input_seq,'envelope_digest',p_envelope_digest,'message_id',p_message_id)::text,'UTF8')),'hex')
$$;
REVOKE ALL ON FUNCTION public.gas_email_admission_digest(text,text,text,text,bigint,bigint,text,text) FROM PUBLIC,authenticated,anonymous;

CREATE FUNCTION public.gas_email_delivery_envelope(p_instance text,p_execution_id text,p_input_seq bigint,p_turn jsonb) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog,public AS $$
 SELECT (r.envelope-'body')||jsonb_build_object('body',
   CASE WHEN p_turn->>'disposition'='done' THEN 'Draft outcome — pending human review.'||chr(10)||chr(10) ELSE '' END
   ||(p_turn->>'summary')
   ||CASE WHEN p_turn->>'question'<>'' THEN chr(10)||chr(10)||(p_turn->>'question') ELSE '' END
   ||CASE WHEN p_turn->>'artifact'<>'' THEN chr(10)||chr(10)||(p_turn->>'artifact') ELSE '' END,
   'messageId','<'||p_execution_id||'@ct-runtime.invalid>')
 FROM public.gas_email_receipts r
 WHERE r.instance_id=p_instance AND r.input_seq=p_input_seq
$$;
REVOKE ALL ON FUNCTION public.gas_email_delivery_envelope(text,text,bigint,jsonb) FROM PUBLIC,authenticated,anonymous;

CREATE FUNCTION public.gas_email_preserve_admission() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
 RAISE EXCEPTION 'immutable email send admission';
END $$;
REVOKE ALL ON FUNCTION public.gas_email_preserve_admission() FROM PUBLIC,authenticated,anonymous;
CREATE TRIGGER gas_email_admissions_immutable BEFORE UPDATE OR DELETE ON public.gas_email_admissions
 FOR EACH ROW EXECUTE FUNCTION public.gas_email_preserve_admission();

CREATE TABLE public.gas_email_cancellation_authorities (
 instance_id text PRIMARY KEY REFERENCES public.gas_email_instances,
 authority_ref text NOT NULL CHECK(length(authority_ref) BETWEEN 1 AND 200),
 authority_id text NOT NULL CHECK(length(authority_id) BETWEEN 1 AND 200),
 provisioned_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
REVOKE ALL ON public.gas_email_cancellation_authorities FROM PUBLIC,authenticated,anonymous;

CREATE TABLE public.gas_email_cancellations (
 instance_id text NOT NULL REFERENCES public.gas_email_instances,
 decision_ref text NOT NULL CHECK(decision_ref ~ '^[a-zA-Z0-9_.:-]{1,150}$'),
 project_id text NOT NULL,
 work_unit_id text NOT NULL REFERENCES public.vnext_work_units,
 input_seq bigint NOT NULL REFERENCES public.vnext_pilot_inputs,
 state text NOT NULL CHECK(state IN ('pending','superseded','after_admission')),
 authority_id text NOT NULL,
 admission_execution_id text REFERENCES public.vnext_executions,
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 superseded_at timestamptz,
 PRIMARY KEY(instance_id,decision_ref),
 UNIQUE(instance_id,work_unit_id,input_seq),
 CHECK((state='after_admission')=(admission_execution_id IS NOT NULL)),
 CHECK((state='superseded')=(superseded_at IS NOT NULL))
);
CREATE UNIQUE INDEX gas_email_cancellation_pending_work_unique
 ON public.gas_email_cancellations(instance_id,work_unit_id) WHERE state='pending';
REVOKE ALL ON public.gas_email_cancellations FROM PUBLIC,authenticated,anonymous;

CREATE FUNCTION public.gas_email_preserve_cancellation() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'immutable email cancellation decision'; END IF;
 IF NEW.instance_id IS DISTINCT FROM OLD.instance_id OR NEW.decision_ref IS DISTINCT FROM OLD.decision_ref
   OR NEW.project_id IS DISTINCT FROM OLD.project_id OR NEW.work_unit_id IS DISTINCT FROM OLD.work_unit_id
   OR NEW.input_seq IS DISTINCT FROM OLD.input_seq OR NEW.authority_id IS DISTINCT FROM OLD.authority_id
   OR NEW.recorded_at IS DISTINCT FROM OLD.recorded_at OR NEW.admission_execution_id IS DISTINCT FROM OLD.admission_execution_id
 THEN RAISE EXCEPTION 'immutable email cancellation decision'; END IF;
 IF OLD.state='pending' AND NEW.state='superseded' AND OLD.superseded_at IS NULL AND NEW.superseded_at IS NOT NULL
 THEN RETURN NEW; END IF;
 RAISE EXCEPTION 'immutable email cancellation decision';
END $$;
REVOKE ALL ON FUNCTION public.gas_email_preserve_cancellation() FROM PUBLIC,authenticated,anonymous;
CREATE TRIGGER gas_email_cancellations_immutable BEFORE UPDATE OR DELETE ON public.gas_email_cancellations
 FOR EACH ROW EXECUTE FUNCTION public.gas_email_preserve_cancellation();

CREATE OR REPLACE FUNCTION public.gas_email_rpc_bootstrap(p_instance text,p_operation text,p_input jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE
 i public.gas_email_instances; w public.vnext_work_units; a public.vnext_project_mutation_authority;
 o public.gas_email_outbox; r public.gas_email_receipts; t public.gas_email_turns; s public.gas_email_settlements;
 acc public.gas_email_acceptances; ad public.gas_email_admissions; cxl public.gas_email_cancellations; ex public.vnext_executions;
 seq bigint; consumed bigint; id text; wid text; envelope jsonb; turn jsonb;
 response text; disposition text; work_state text; digest text; authority text; authority_id text;
 expected_envelope jsonb; envelope_digest text; admission_digest text; cxl_state text; cxl_admission text; cxl_admitted timestamptz;
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
    'accepted',(SELECT count(*) FROM public.vnext_work_units WHERE project_id=i.project_id AND state='terminal'),
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
   UPDATE public.gas_email_cancellations SET state='superseded',superseded_at=clock_timestamp()
     WHERE instance_id=i.instance_id AND work_unit_id=wid AND state='pending' AND input_seq<seq;
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
  ELSIF p_operation='acceptance-context' THEN
    -- Read-only snapshot for an independently issued acceptance decision. It
    -- exposes only what the accepting transition will re-derive and verify.
    SELECT u.* INTO w FROM public.vnext_work_units u JOIN public.gas_email_threads g USING(work_unit_id)
      WHERE g.instance_id=i.instance_id AND u.work_unit_id=p_input->>'work_unit_id';
    IF NOT FOUND THEN RETURN jsonb_build_object('status','not-reviewable'); END IF;
    SELECT * INTO s FROM public.gas_email_settlements WHERE instance_id=i.instance_id AND execution_id=w.last_execution_id;
    IF w.state<>'review' OR NOT FOUND OR s.work_unit_id IS DISTINCT FROM w.work_unit_id
      OR s.turn->>'disposition' IS DISTINCT FROM 'done'
      OR EXISTS(SELECT 1 FROM public.vnext_pilot_inputs x WHERE x.work_unit_id=w.work_unit_id AND x.input_seq>s.input_seq)
    THEN RETURN jsonb_build_object('status','not-reviewable','work_state',w.state); END IF;
    IF EXISTS(SELECT 1 FROM public.vnext_project_reconciliation_blocks WHERE project_id=i.project_id)
    THEN RETURN jsonb_build_object('status','not-reviewable','work_state',w.state,'reason','project-blocked'); END IF;
    IF EXISTS(SELECT 1 FROM public.vnext_project_mutation_authority WHERE project_id=i.project_id)
    THEN RETURN jsonb_build_object('status','not-reviewable','work_state',w.state,'reason','project-busy'); END IF;
    RETURN jsonb_build_object('status','review-ready','work_unit_id',w.work_unit_id,'execution_id',s.execution_id,'fence',s.fence,
      'input_seq',s.input_seq,'snapshot_digest',public.gas_email_acceptance_digest(i.instance_id,s.execution_id,s.fence,s.input_seq,s.turn));
  ELSIF p_operation='accept' THEN
    -- A done settlement remains a completion claim until an explicit trusted
    -- decision accepts it. The decision identity is caller-issued and opaque;
    -- the binding is verified here against durable state, never inferred from
    -- execution identity. Exact replay returns the recorded decision; divergent
    -- content under the same identity fails before mutation; a decision against
    -- superseded input, a newer attempt, or a different result fails closed.
    IF coalesce(p_input->>'decision_ref','') !~ '^[a-zA-Z0-9_.:-]{1,150}$'
      OR coalesce(p_input->>'snapshot_digest','') !~ '^[0-9a-f]{64}$'
      OR coalesce(p_input->>'fence','') !~ '^[0-9]{1,18}$'
      OR coalesce(p_input->>'work_unit_id','')='' OR coalesce(p_input->>'execution_id','')='' THEN RAISE EXCEPTION 'invalid acceptance decision'; END IF;
    -- Lock the authority row to serialize with owner-managed rotation or
    -- revocation and with competing acceptances. Replay does not require the
    -- current value, but waiting here lets a concurrent acceptance commit before
    -- the replay lookup resolves.
    SELECT aa.authority_ref,aa.authority_id INTO authority,authority_id FROM public.gas_email_acceptance_authorities aa WHERE aa.instance_id=i.instance_id FOR SHARE;
    -- Exact replay is historical evidence, not a new acceptance. Resolve and
    -- verify it before the current-authority check, so revocation or rotation
    -- cannot invalidate a decision that already committed. Divergent content
    -- under the same identity still fails closed.
    SELECT * INTO acc FROM public.gas_email_acceptances WHERE instance_id=i.instance_id AND decision_ref=p_input->>'decision_ref';
    IF FOUND THEN
      IF acc.work_unit_id IS DISTINCT FROM p_input->>'work_unit_id' OR acc.execution_id IS DISTINCT FROM p_input->>'execution_id'
        OR acc.fence::text IS DISTINCT FROM p_input->>'fence' OR acc.snapshot_digest IS DISTINCT FROM p_input->>'snapshot_digest'
      THEN RAISE EXCEPTION 'acceptance decision conflict'; END IF;
      RETURN jsonb_build_object('status','accepted','replay',true,'decision_ref',acc.decision_ref,'work_unit_id',acc.work_unit_id,
        'execution_id',acc.execution_id,'fence',acc.fence,'input_seq',acc.input_seq,'snapshot_digest',acc.snapshot_digest,'accepted_at',acc.accepted_at);
    END IF;
    -- A new acceptance requires the separately provisioned current acceptance
    -- authority for this instance. The execution grant (and any reference
    -- obtainable from review context) is not acceptance authority. Either this
    -- acceptance commits first, or the rotated/revoked value is what we verify.
    IF authority IS NULL OR p_input->>'authority' IS DISTINCT FROM authority THEN RAISE EXCEPTION 'acceptance authority required'; END IF;
    -- New acceptance is refused while the project has unresolved external
    -- effects or another execution holds mutation authority. Exact replay
    -- above is unaffected: it returns the recorded decision, not new state.
    IF EXISTS(SELECT 1 FROM public.vnext_project_reconciliation_blocks WHERE project_id=i.project_id) THEN RAISE EXCEPTION 'acceptance blocked during reconciliation'; END IF;
    IF EXISTS(SELECT 1 FROM public.vnext_project_mutation_authority WHERE project_id=i.project_id) THEN RAISE EXCEPTION 'acceptance blocked during active execution'; END IF;
    SELECT u.* INTO w FROM public.vnext_work_units u JOIN public.gas_email_threads g USING(work_unit_id)
      WHERE g.instance_id=i.instance_id AND u.work_unit_id=p_input->>'work_unit_id' FOR UPDATE OF u;
    IF NOT FOUND THEN RAISE EXCEPTION 'unknown email work'; END IF;
    IF w.state<>'review' THEN RAISE EXCEPTION 'not settled for acceptance'; END IF;
    SELECT * INTO s FROM public.gas_email_settlements WHERE instance_id=i.instance_id AND execution_id=w.last_execution_id;
    IF NOT FOUND OR s.work_unit_id IS DISTINCT FROM w.work_unit_id OR s.turn->>'disposition' IS DISTINCT FROM 'done'
    THEN RAISE EXCEPTION 'no acceptance snapshot'; END IF;
    IF p_input->>'execution_id' IS DISTINCT FROM s.execution_id OR p_input->>'fence' IS DISTINCT FROM s.fence::text
      OR EXISTS(SELECT 1 FROM public.vnext_pilot_inputs x WHERE x.work_unit_id=w.work_unit_id AND x.input_seq>s.input_seq)
    THEN RAISE EXCEPTION 'stale acceptance decision'; END IF;
    digest:=public.gas_email_acceptance_digest(i.instance_id,s.execution_id,s.fence,s.input_seq,s.turn);
    IF p_input->>'snapshot_digest' IS DISTINCT FROM digest THEN RAISE EXCEPTION 'acceptance snapshot mismatch'; END IF;
    INSERT INTO public.gas_email_acceptances(instance_id,decision_ref,project_id,work_unit_id,execution_id,fence,input_seq,snapshot_digest,authority_id)
      VALUES(i.instance_id,p_input->>'decision_ref',i.project_id,w.work_unit_id,s.execution_id,s.fence,s.input_seq,digest,authority_id) RETURNING * INTO acc;
    UPDATE public.vnext_work_units SET state='terminal',updated_at=clock_timestamp() WHERE work_unit_id=w.work_unit_id;
    RETURN jsonb_build_object('status','accepted','replay',false,'decision_ref',acc.decision_ref,'work_unit_id',acc.work_unit_id,
      'execution_id',acc.execution_id,'fence',acc.fence,'input_seq',acc.input_seq,'snapshot_digest',acc.snapshot_digest,'accepted_at',acc.accepted_at);
  ELSIF p_operation='cancel' THEN
   -- A cancellation decision is a separately authorized, exact-replayable
   -- intent over one captured input snapshot. It can be recorded while work is
   -- running or after admission, but it never claims that an already-admitted
   -- GAS send was stopped or resolved.
   IF coalesce(p_input->>'decision_ref','') !~ '^[a-zA-Z0-9_.:-]{1,150}$'
     OR coalesce(p_input->>'input_seq','') !~ '^[0-9]{1,18}$'
     OR coalesce(p_input->>'work_unit_id','')='' THEN RAISE EXCEPTION 'invalid cancellation decision'; END IF;
   -- Lock the authority row to serialize rotation/revocation with a new
   -- cancellation. Replay is resolved before the current-authority check.
   SELECT ca.authority_ref,ca.authority_id INTO authority,authority_id FROM public.gas_email_cancellation_authorities ca WHERE ca.instance_id=i.instance_id FOR SHARE;
   SELECT * INTO cxl FROM public.gas_email_cancellations WHERE instance_id=i.instance_id AND decision_ref=p_input->>'decision_ref';
   IF FOUND THEN
     IF cxl.work_unit_id IS DISTINCT FROM p_input->>'work_unit_id' OR cxl.input_seq::text IS DISTINCT FROM p_input->>'input_seq'
     THEN RAISE EXCEPTION 'cancellation decision conflict'; END IF;
     cxl_admitted:=NULL;
     IF cxl.admission_execution_id IS NOT NULL THEN
       SELECT admitted_at INTO cxl_admitted FROM public.gas_email_admissions WHERE instance_id=i.instance_id AND execution_id=cxl.admission_execution_id;
     END IF;
     RETURN jsonb_build_object('status',CASE cxl.state WHEN 'pending' THEN 'cancelled' WHEN 'after_admission' THEN 'after-admission' ELSE 'superseded' END,
       'replay',true,'decision_ref',cxl.decision_ref,'work_unit_id',cxl.work_unit_id,'input_seq',cxl.input_seq,'state',cxl.state,
       'recorded_at',cxl.recorded_at,'superseded_at',cxl.superseded_at,'admission_execution_id',cxl.admission_execution_id,'admitted_at',cxl_admitted);
   END IF;
   -- A new decision requires the separately provisioned current cancellation
   -- authority; the execution or acceptance credential is never sufficient.
   IF authority IS NULL OR p_input->>'authority' IS DISTINCT FROM authority THEN RAISE EXCEPTION 'cancellation authority required'; END IF;
   seq:=(p_input->>'input_seq')::bigint;
   SELECT u.* INTO w FROM public.vnext_work_units u JOIN public.gas_email_threads g USING(work_unit_id)
     WHERE g.instance_id=i.instance_id AND u.work_unit_id=p_input->>'work_unit_id' FOR UPDATE OF u;
   IF NOT FOUND OR w.project_id IS DISTINCT FROM i.project_id THEN RAISE EXCEPTION 'unknown email work'; END IF;
   IF NOT EXISTS(SELECT 1 FROM public.vnext_pilot_inputs x WHERE x.work_unit_id=w.work_unit_id AND x.input_seq=seq)
   THEN RAISE EXCEPTION 'unknown email snapshot'; END IF;
   SELECT * INTO ad FROM public.gas_email_admissions WHERE instance_id=i.instance_id AND work_unit_id=w.work_unit_id
     AND input_seq=seq ORDER BY admitted_at DESC LIMIT 1;
   IF FOUND THEN
     cxl_state:='after_admission'; cxl_admission:=ad.execution_id; cxl_admitted:=ad.admitted_at;
   ELSIF EXISTS(SELECT 1 FROM public.vnext_pilot_inputs x WHERE x.work_unit_id=w.work_unit_id AND x.input_seq>seq) THEN
     cxl_state:='superseded'; cxl_admission:=NULL; cxl_admitted:=NULL;
   ELSE
     cxl_state:='pending'; cxl_admission:=NULL; cxl_admitted:=NULL;
     IF EXISTS(SELECT 1 FROM public.gas_email_cancellations x WHERE x.instance_id=i.instance_id AND x.work_unit_id=w.work_unit_id AND x.state='pending')
     THEN RAISE EXCEPTION 'cancellation already pending for email work'; END IF;
   END IF;
   IF EXISTS(SELECT 1 FROM public.gas_email_cancellations x WHERE x.instance_id=i.instance_id AND x.work_unit_id=w.work_unit_id AND x.input_seq=seq)
   THEN RAISE EXCEPTION 'cancellation already recorded for email snapshot'; END IF;
   INSERT INTO public.gas_email_cancellations(instance_id,decision_ref,project_id,work_unit_id,input_seq,state,authority_id,admission_execution_id,superseded_at)
     VALUES(i.instance_id,p_input->>'decision_ref',i.project_id,w.work_unit_id,seq,cxl_state,authority_id,cxl_admission,
       CASE WHEN cxl_state='superseded' THEN clock_timestamp() ELSE NULL END) RETURNING * INTO cxl;
   RETURN jsonb_build_object('status',CASE cxl.state WHEN 'pending' THEN 'cancelled' WHEN 'after_admission' THEN 'after-admission' ELSE 'superseded' END,
     'replay',false,'decision_ref',cxl.decision_ref,'work_unit_id',cxl.work_unit_id,'input_seq',cxl.input_seq,'state',cxl.state,
     'recorded_at',cxl.recorded_at,'superseded_at',cxl.superseded_at,'admission_execution_id',cxl.admission_execution_id,'admitted_at',cxl_admitted);
  ELSIF p_operation IN ('delivery','delivery-peek') THEN
   IF p_operation='delivery-peek' THEN
     -- Read-only preflight. It never authorizes a send or changes outbox state.
     SELECT * INTO o FROM public.gas_email_outbox WHERE instance_id=i.instance_id AND state IN ('pending','admitted') ORDER BY created_at LIMIT 1;
     IF NOT FOUND THEN RETURN jsonb_build_object('status','idle'); END IF;
     IF o.state='admitted' THEN
       SELECT * INTO ad FROM public.gas_email_admissions WHERE instance_id=i.instance_id AND execution_id=o.execution_id;
       IF FOUND THEN RETURN jsonb_build_object('status','reconcile','execution_id',o.execution_id,'envelope',o.envelope,
         'replay',true,'admission_digest',ad.admission_digest,'envelope_digest',ad.envelope_digest,'message_id',ad.message_id,'admitted_at',ad.admitted_at);
       END IF;
       RETURN jsonb_build_object('status','reconcile','execution_id',o.execution_id,'envelope',o.envelope,'replay',true);
     END IF;
     RETURN jsonb_build_object('status','prepare','execution_id',o.execution_id,'envelope',o.envelope);
   END IF;
   -- Delivery is the only send-authorizing transition. Select the exact
   -- prepared attempt rather than whichever outbox happens to be oldest.
   IF p_input->>'execution_id' IS NULL THEN
     SELECT * INTO o FROM public.gas_email_outbox WHERE instance_id=i.instance_id AND state IN ('pending','admitted') ORDER BY created_at LIMIT 1 FOR UPDATE;
     IF NOT FOUND THEN RETURN jsonb_build_object('status','idle'); END IF;
     RAISE EXCEPTION 'stale delivery preparation';
   END IF;
   SELECT * INTO o FROM public.gas_email_outbox WHERE instance_id=i.instance_id AND execution_id=p_input->>'execution_id' FOR UPDATE;
   IF NOT FOUND THEN RAISE EXCEPTION 'stale delivery preparation'; END IF;
   IF o.state='admitted' THEN
     SELECT * INTO ad FROM public.gas_email_admissions WHERE instance_id=i.instance_id AND execution_id=o.execution_id;
     IF FOUND THEN RETURN jsonb_build_object('status','reconcile','execution_id',o.execution_id,'envelope',o.envelope,
       'replay',true,'admission_digest',ad.admission_digest,'envelope_digest',ad.envelope_digest,'message_id',ad.message_id,'admitted_at',ad.admitted_at);
     END IF;
     -- A pre-010 admitted outbox has no receipt to backfill. It is still
     -- historical reconciliation evidence, never permission to send again.
     RETURN jsonb_build_object('status','reconcile','execution_id',o.execution_id,'envelope',o.envelope,'replay',true);
   ELSIF o.state='sent' THEN RETURN jsonb_build_object('status','sent','execution_id',o.execution_id);
   ELSIF o.state='superseded' THEN RETURN jsonb_build_object('status','superseded','execution_id',o.execution_id);
   END IF;
   -- Cancellation governs this exact captured snapshot. Close the pending
   -- outbox without an external effect or reconciliation block.
   SELECT * INTO cxl FROM public.gas_email_cancellations WHERE instance_id=i.instance_id AND work_unit_id=o.work_unit_id AND input_seq=o.input_seq;
   IF FOUND THEN
     UPDATE public.gas_email_outbox SET state='superseded' WHERE execution_id=o.execution_id;
     RETURN jsonb_build_object('status','cancelled','execution_id',o.execution_id,'decision_ref',cxl.decision_ref,'input_seq',o.input_seq);
   END IF;
   IF EXISTS(SELECT 1 FROM public.vnext_pilot_inputs WHERE work_unit_id=o.work_unit_id AND input_seq>o.input_seq) THEN
     UPDATE public.gas_email_outbox SET state='superseded' WHERE execution_id=o.execution_id;
     RETURN jsonb_build_object('status','superseded');
   END IF;
   IF EXISTS(SELECT 1 FROM public.vnext_project_mutation_authority WHERE project_id=i.project_id)
      OR EXISTS(SELECT 1 FROM public.vnext_project_reconciliation_blocks WHERE project_id=i.project_id)
      OR EXISTS(SELECT 1 FROM public.gas_email_outbox x JOIN public.vnext_executions xe ON xe.execution_id=x.execution_id
        WHERE x.instance_id=i.instance_id AND x.state='admitted' AND x.execution_id<>o.execution_id AND xe.project_id=i.project_id)
   THEN RETURN jsonb_build_object('status','blocked'); END IF;
   IF o.provider_receipt IS NOT NULL OR o.gmail_id IS NOT NULL THEN RAISE EXCEPTION 'delivery evidence already exists'; END IF;
   SELECT * INTO ex FROM public.vnext_executions WHERE execution_id=o.execution_id FOR UPDATE;
   IF NOT FOUND OR ex.work_unit_id IS DISTINCT FROM o.work_unit_id OR ex.project_id IS DISTINCT FROM i.project_id
     OR ex.owner IS DISTINCT FROM i.instance_id OR ex.state IS DISTINCT FROM 'succeeded' THEN RAISE EXCEPTION 'invalid delivery binding'; END IF;
   SELECT * INTO w FROM public.vnext_work_units WHERE work_unit_id=o.work_unit_id FOR UPDATE;
   IF NOT FOUND OR w.project_id IS DISTINCT FROM i.project_id OR w.last_execution_id IS DISTINCT FROM o.execution_id
     OR w.fence IS DISTINCT FROM ex.fence OR w.claim_execution_id IS NOT NULL THEN RAISE EXCEPTION 'invalid delivery binding'; END IF;
   SELECT * INTO s FROM public.gas_email_settlements WHERE instance_id=i.instance_id AND execution_id=o.execution_id FOR SHARE;
   IF NOT FOUND OR s.project_id IS DISTINCT FROM i.project_id OR s.work_unit_id IS DISTINCT FROM o.work_unit_id
     OR s.fence IS DISTINCT FROM ex.fence OR s.input_seq IS DISTINCT FROM o.input_seq THEN RAISE EXCEPTION 'invalid delivery binding'; END IF;
   expected_envelope:=public.gas_email_delivery_envelope(i.instance_id,o.execution_id,o.input_seq,s.turn);
   IF expected_envelope IS NULL OR o.envelope IS DISTINCT FROM expected_envelope THEN RAISE EXCEPTION 'delivery envelope mismatch'; END IF;
   IF o.envelope->>'messageId' IS DISTINCT FROM '<'||o.execution_id||'@ct-runtime.invalid>' THEN RAISE EXCEPTION 'delivery envelope mismatch'; END IF;
   envelope_digest:=public.gas_email_envelope_digest(o.envelope);
   admission_digest:=public.gas_email_admission_digest(i.instance_id,o.execution_id,i.project_id,o.work_unit_id,ex.fence,o.input_seq,envelope_digest,o.envelope->>'messageId');
   INSERT INTO public.gas_email_admissions(instance_id,execution_id,project_id,work_unit_id,fence,input_seq,envelope_digest,admission_digest,message_id)
     VALUES(i.instance_id,o.execution_id,i.project_id,o.work_unit_id,ex.fence,o.input_seq,envelope_digest,admission_digest,o.envelope->>'messageId') RETURNING * INTO ad;
   INSERT INTO public.vnext_project_reconciliation_blocks(project_id,work_unit_id,execution_id,fence,reason)
     SELECT i.project_id,o.work_unit_id,o.execution_id,ex.fence,'external-effect-uncertain';
   UPDATE public.gas_email_outbox SET state='admitted' WHERE execution_id=o.execution_id;
   RETURN jsonb_build_object('status','send','execution_id',o.execution_id,'envelope',o.envelope,
     'replay',false,'admission_digest',ad.admission_digest,'envelope_digest',ad.envelope_digest,'message_id',ad.message_id,'admitted_at',ad.admitted_at);
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
