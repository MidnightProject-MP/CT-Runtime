import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { once } from 'node:events';
import { Pool } from 'pg';
import { gasEmailFixture } from './gas-email-fixture.mjs';

test('GAS-hosted email vertical slice against transactional SQL', {timeout:120000}, async t=>{
  const signal=new SharedArrayBuffer(8),bytes=new SharedArrayBuffer(2000000),state=new Int32Array(signal);
  const worker=new Worker(new URL('./gas-email-sql-worker.mjs',import.meta.url),{workerData:{signal,bytes}});
  const [ready]=await once(worker,'message');assert.equal(ready.error,undefined);
  function request(message){Atomics.store(state,0,0);worker.postMessage(message);assert.notEqual(Atomics.wait(state,0,0,30000),'timed-out');const answer=JSON.parse(new TextDecoder().decode(new Uint8Array(bytes,0,Atomics.load(state,1))));if(answer.error)throw new Error(answer.error);return answer.result;}
  const sql=(sql,args)=>request({type:'sql',sql,args});
  const rawRpc=(operation,input,extra={})=>request({type:'rpc',operation,input,...extra});
  const rpc=(operation,input,extra={})=>rawRpc(operation,operation==='delivery'&&!input?{execution_id:rawRpc('delivery-peek',{},extra).execution_id}:input,extra);
  const fixture=()=>gasEmailFixture(rawRpc);
  const input=(id,thread='sqlthread',body='Please draft.')=>({id,threadId:thread,from:'midnightprojectantigravity@gmail.com',to:'midnight.project.mp@gmail.com',reference:`<${id}@example.com>`,subject:'Task',body});
  const checkpoint=(claim,turn={disposition:'done',summary:'Draft complete.'})=>rpc('checkpoint',{execution_id:claim.execution_id,fence:claim.fence,turn});
  const reset=()=>sql('TRUNCATE gas_email_instances, vnext_work_units CASCADE; INSERT INTO gas_email_instances VALUES (\'gas-test\',\'gas-owner\',\'gas-client\',\'email-project\',\'midnight.project.mp@gmail.com\',\'midnightprojectantigravity@gmail.com\',true,\'reviewed:text-only:v1\')');
  const authorize=()=>{sql("INSERT INTO gas_email_acceptance_authorities VALUES ('gas-test','reviewed:owner-acceptance:v1')");return 'reviewed:owner-acceptance:v1';};
  try {
    await t.test('closed diagnostics, stale fence rollback and old runtime compatibility',()=>{
      for(const legacy of [false,true]){
        reset();rpc('ingest',input('diagnostics'));const c=rpc('claim');
        const diagnostics={classification:'model-validation',code:'truncated',httpStatus:200,finishReason:'length',choicePresent:true,contentChars:200};
        assert.throws(()=>rpc('failure',{execution_id:c.execution_id,fence:c.fence,diagnostics:{...diagnostics,secret:'SECRET'}}),/invalid diagnostics/);
        assert.throws(()=>rpc('failure',{execution_id:c.execution_id,fence:c.fence+1,diagnostics}),/stale email fence/);
        assert.equal(sql('SELECT state FROM vnext_executions')[0].state,'running');
        assert.equal(sql('SELECT count(*)::int AS n FROM vnext_project_mutation_authority')[0].n,1);
        rpc('failure',{execution_id:c.execution_id,fence:c.fence,...(legacy?{}:{diagnostics})});
        const failure=sql('SELECT failure FROM vnext_executions')[0].failure;
        assert.equal(failure.reason,'bounded-model-failure');assert.deepEqual(failure.diagnostics,legacy?undefined:diagnostics);
        assert.equal(sql('SELECT count(*)::int AS n FROM gas_email_outbox')[0].n,0);
      }
      for(const fn of ['gas_email_rpc_delivery','gas_email_rpc_bootstrap'])assert.equal(sql(`SELECT has_function_privilege('authenticated','${fn}(text,text,jsonb)','EXECUTE') AS allowed`)[0].allowed,false);
      reset();
    });
    await t.test('authentication, project registration, disabled grant, table/RPC privileges',()=>{
      const claims={sub:'wrong',aud:'gas-client',iss:'https://accounts.google.com',exp:4102444800};
      assert.throws(()=>rpc('health',{}, {claims}),/principal denied/);
      assert.throws(()=>rpc('health',{}, {instance:'other-project'}),/principal denied/);
      assert.throws(()=>rpc('health',{}, {claims:{...claims,sub:'gas-owner',aud:'other'}}),/principal denied/);
      assert.throws(()=>rpc('health',{}, {claims:{...claims,sub:'gas-owner',exp:1}}),/principal denied/);
      assert.throws(()=>rpc('health',{}, {claims:{...claims,sub:'gas-owner',iss:'https://attacker.invalid'}}),/principal denied/);
      sql("INSERT INTO gas_email_instances VALUES ('other-instance','other-owner','gas-client','other-project','midnight.project.mp@gmail.com','midnightprojectantigravity@gmail.com',true,'other-grant')");
      assert.throws(()=>rpc('health',{}, {instance:'other-instance'}),/principal denied/);
      sql("DELETE FROM gas_email_instances WHERE instance_id='other-instance'");
      sql("UPDATE gas_email_instances SET active=false");assert.throws(()=>rpc('health'),/principal denied/);sql("UPDATE gas_email_instances SET active=true");
      assert.equal(sql("SELECT has_table_privilege('authenticated','vnext_work_units','INSERT') AS allowed")[0].allowed,false);
      assert.equal(sql("SELECT has_function_privilege('authenticated','gas_email_principal(text)','EXECUTE') AS allowed")[0].allowed,false);
      const checks=sql("SELECT prosecdef,proconfig FROM pg_proc WHERE oid IN ('vnext_assert_project_mutation_authority_active()'::regprocedure,'vnext_assert_authority_authorization_ref()'::regprocedure)");
      assert.equal(checks.length,2);assert.ok(checks.every(p=>p.prosecdef&&p.proconfig.includes('search_path=pg_catalog, public')));
      assert.throws(()=>rpc('execute_sql',{sql:'select 1'}),/unknown email operation/);
    });
    await t.test('real GAS modules: Gmail ingest, OpenRouter text, checkpoint, same-thread MIME reply and cold reconstruction',()=>{
      const f=fixture();f.add('m1');assert.equal(f.tick().status,'sent');assert.equal(f.sends,1);
      assert.equal(f.messages.get('sent1').threadId,'thread1');
      assert.equal(sql('SELECT state FROM vnext_work_units')[0].state,'review');
      assert.equal(sql('SELECT state FROM gas_email_outbox')[0].state,'sent');
      assert.equal(f.tick().status,'idle');assert.equal(f.sends,1);
      f.add('m2','thread1','Please make it more concise.');
      f.setModel(request=>{assert.match(request.messages[0].content,/NO shell/);const d=JSON.parse(request.messages[1].content);assert.equal(d.previous.summary,'Here is a useful draft.');assert.equal(d.inputs[0].message,'Please make it more concise.');return {disposition:'waiting',summary:'I can tailor it.',question:'Who is the recipient?'};});
      assert.equal(f.tick().status,'sent');assert.equal(f.sends,2);assert.equal(Number(sql('SELECT count(*) AS n FROM vnext_work_units')[0].n),1);
      f.values.CT_VNEXT_EMAIL_ENABLED='false';assert.equal(f.tick().status,'disabled');
    });
    await t.test('receipt conflict, stale fences, bounded snapshots and newer input preserved',()=>{
      reset();const msg=input('r1');assert.equal(rpc('ingest',msg).status,'inserted');assert.equal(rpc('ingest',msg).status,'duplicate');assert.throws(()=>rpc('ingest',{...msg,body:'changed'}),/integrity conflict/);
      const c=rpc('claim');assert.equal(c.status,'claimed');assert.throws(()=>checkpoint({...c,fence:c.fence+1}),/stale email fence/);
      for(let n=2;n<=6;n++)rpc('ingest',input('r'+n));checkpoint(c);
      assert.equal(rpc('delivery').status,'superseded');const c2=rpc('claim');assert.equal(c2.inputs.length,3);checkpoint(c2);
      assert.equal(rpc('delivery').status,'superseded');const c3=rpc('claim');assert.equal(c3.inputs.length,2);checkpoint(c3);
      assert.equal(sql('SELECT state FROM vnext_work_units')[0].state,'review');
      assert.equal(Number(sql('SELECT count(*) AS n FROM vnext_pilot_results')[0].n),3);
    });
    await t.test('lost send response never resends; exact readback reconciles after cold wake',()=>{
      reset();const f=fixture();f.add('lost');f.loseNextSend();f.hideSearch();assert.equal(f.tick().status,'blocked');assert.equal(f.sends,1);
      assert.equal(f.tick().status,'uncertain');assert.equal(f.sends,1);
      f.add('followup','thread1','One more thing.');assert.equal(f.tick().status,'uncertain');assert.equal(rpc('claim').status,'blocked');
      f.showSearch();assert.equal(f.tick().status,'sent');assert.equal(f.sends,2);assert.equal(rpc('health').uncertain,0);
    });
    await t.test('rewritten Message-ID: durable receipt survives lost receipt-write response and lost record',()=>{
      for(const loss of ['none','note-send-receipt','record']){
        reset();let lose=loss;const calls=[];
        const f=gasEmailFixture((op,data)=>{
          calls.push(op);
          if(op==='note-send-receipt')f.messages.get('sent1').payload.headers.find(h=>h.name==='Message-ID').value='<gmail-rewritten@example.com>';
          const r=rawRpc(op,data);
          if(op===lose){lose=null;throw new Error('lost response');}return r;
        });
        f.add('rewritten');assert.equal(f.tick().status,loss==='none'?'sent':'blocked');assert.equal(f.sends,1);
        assert.equal(sql('SELECT provider_receipt FROM gas_email_outbox')[0].provider_receipt,'sent1');
        if(loss==='note-send-receipt')assert.equal(sql('SELECT state FROM gas_email_outbox')[0].state,'admitted');
        f.hideSearch();assert.equal(f.tick().status,'idle');assert.equal(f.sends,1);
        assert.equal(sql('SELECT state FROM gas_email_outbox')[0].state,'sent');
        assert.equal(calls.filter(x=>x==='delivery').length,1);
      }
    });
    await t.test('marker recovers response lost before receipt; wrong marker, duplicates and truncation never settle',()=>{
      for(const mode of ['recover','wrong-marker','duplicate','truncated','to','reference','body']){
        reset();const f=fixture();f.add('marker');f.loseNextSend();assert.equal(f.tick().status,'blocked');
        const m=f.messages.get('sent1'),headers=m.payload.headers;
        headers.find(h=>h.name==='Message-ID').value='<rewritten@gmail.com>';
        const exec=sql('SELECT execution_id FROM gas_email_outbox')[0].execution_id;
        assert.equal(headers.find(h=>h.name==='X-CT-Runtime-Execution').value,exec);
        if(mode==='wrong-marker')headers.find(h=>h.name==='X-CT-Runtime-Execution').value='wrong';
        if(mode==='duplicate'){const copy=structuredClone(m);copy.id='sent2';f.messages.set(copy.id,copy);}
        if(mode==='truncated')for(let n=0;n<10;n++)f.add('extra'+n,'thread1','other','attacker@example.com');
        if(mode==='to')headers.find(h=>h.name==='To').value='attacker@example.com';
        if(mode==='reference')headers.find(h=>h.name==='In-Reply-To').value='<other@example.com>';
        if(mode==='body')m.payload.body.data=Buffer.from('different').toString('base64url');
        f.failIntake();const result=f.tick();assert.equal(result.status,mode==='recover'?'sent':mode==='duplicate'?'blocked':'uncertain',mode);
        assert.equal(f.sends,1);assert.equal(sql('SELECT state FROM gas_email_outbox')[0].state,mode==='recover'?'sent':'admitted');
        assert.equal(rpc('claim').status,mode==='recover'?'idle':'blocked');
      }
    });
    await t.test('saved receipt cannot suppress recipient/reference/body mismatch; receipt RPC immutable and scoped',()=>{
      for(const field of ['To','In-Reply-To','body']){
        reset();let lost=true;
        const f=gasEmailFixture((op,data)=>{const r=rawRpc(op,data);if(op==='note-send-receipt'&&lost){lost=false;throw new Error('lost receipt response');}return r;});
        f.add('saved');assert.equal(f.tick().status,'blocked');const m=f.messages.get('sent1');
        if(field==='body')m.payload.body.data=Buffer.from('different').toString('base64url');else m.payload.headers.find(h=>h.name===field).value=field==='To'?'attacker@example.com':'<other@example.com>';
        assert.equal(f.tick().status,'uncertain');assert.equal(f.sends,1);
        const d=rpc('delivery-peek'),data={execution_id:d.execution_id,gmail_id:'sent1',messageId:d.envelope.messageId,threadId:d.envelope.threadId};
        assert.equal(d.providerReceipt,'sent1');assert.equal(rpc('note-send-receipt',data).status,'noted');
        for(const bad of [{gmail_id:'other'},{threadId:'other'},{messageId:'other'},{execution_id:'other'},{gmail_id:'bad/id'}])assert.throws(()=>rpc('note-send-receipt',{...data,...bad}),/invalid delivery evidence/);
        assert.throws(()=>rpc('record',{...data,gmail_id:'other'}),/invalid delivery evidence/);
        assert.equal(sql("SELECT has_function_privilege('authenticated','gas_email_rpc_bootstrap(text,text,jsonb)','EXECUTE') AS allowed")[0].allowed,false);
      }
    });
    await t.test('provider IDs cannot be reused by another outbox or bypass receipt identity at record',()=>{
      reset();rpc('ingest',input('first'));checkpoint(rpc('claim'));const first=rpc('delivery');
      const proof=d=>({execution_id:d.execution_id,gmail_id:'shared',messageId:d.envelope.messageId,threadId:d.envelope.threadId});
      assert.equal(rpc('note-send-receipt',proof(first)).status,'noted');
      assert.equal(rpc('record',proof(first)).status,'sent');
      rpc('ingest',input('second'));checkpoint(rpc('claim'));const second=rpc('delivery');
      assert.throws(()=>rpc('note-send-receipt',proof(second)),/invalid delivery evidence/);
      assert.throws(()=>rpc('record',proof(second)),/invalid delivery evidence/);
      assert.equal(rpc('note-send-receipt',{...proof(second),gmail_id:'distinct'}).status,'noted');
      assert.equal(rpc('health').uncertain,1);
    });
    await t.test('receipt write rejected before commit recovers marker without sending again',()=>{
      reset();let fail=true;
      const f=gasEmailFixture((op,data)=>{if(op==='note-send-receipt'&&fail){fail=false;f.messages.get('sent1').payload.headers.find(h=>h.name==='Message-ID').value='<rewritten@gmail.com>';throw new Error('receipt unavailable');}return rawRpc(op,data);});
      f.add('failedReceipt');assert.equal(f.tick().status,'blocked');
      assert.equal(sql('SELECT provider_receipt FROM gas_email_outbox')[0].provider_receipt,null);
      assert.equal(f.tick().status,'idle');assert.equal(f.sends,1);assert.equal(rpc('health').uncertain,0);
    });
    await t.test('wrong sender, encoded subjects, and mismatched readback fail closed',()=>{
      reset();const f=fixture();f.add('wrong','thread1','untrusted','attacker@example.com');assert.equal(f.tick().status,'idle');assert.equal(f.sends,0);
      f.messages.delete('wrong');f.add('encoded');f.messages.get('encoded').payload.headers.find(h=>h.name==='Subject').value='=?UTF-8?B?'+Buffer.from('Merci — draft').toString('base64')+'?=';
      f.loseNextSend();assert.equal(f.tick().status,'blocked');assert.equal(f.sends,1);
      const sent=f.messages.get('sent1'),body=sent.payload.body.data;sent.payload.body.data=Buffer.from('A different reply').toString('base64url');
      assert.equal(f.tick().status,'uncertain');assert.equal(f.sends,1);
      sent.payload.body.data=body;assert.equal(f.tick().status,'idle');assert.equal(rpc('health').uncertain,0);
    });
    await t.test('configured secret is never persisted in inputs or returned model artifacts',()=>{
      reset();const f=fixture();f.add('secret','thread1','Please do not retain test-openrouter-secret');
      f.setModel(request=>{assert.doesNotMatch(JSON.stringify(request.messages),/test-openrouter-secret/);return {disposition:'done',summary:'test-openrouter-secret'};});
      assert.equal(f.tick().status,'sent');
      assert.doesNotMatch(JSON.stringify(sql('SELECT * FROM gas_email_receipts')),/test-openrouter-secret/);
      assert.doesNotMatch(JSON.stringify(sql('SELECT * FROM vnext_pilot_results')),/test-openrouter-secret/);
    });
    await t.test('three deterministic poison messages cannot starve valid intake',()=>{
      reset();const f=fixture();
      f.add('huge');f.messages.get('huge').padding='x'.repeat(250001);
      f.add('wrong','thread1','unsupported','attacker@example.com');
      f.add('nul','thread1','invalid\u0000body');f.add('valid','validThread');
      assert.equal(f.tick().status,'idle');assert.equal(rpc('health').quarantined,3);
      for(const id of ['huge','wrong','nul'])assert.ok(!f.messages.get(id).labelIds.includes('queue'));
      assert.equal(f.tick().status,'sent');assert.equal(f.sends,1);
      assert.equal(Number(sql('SELECT count(*) AS n FROM gas_email_receipts')[0].n),1);
    });
    await t.test('serialized controls and invalid UTF-8 quarantine durably so the fourth valid message progresses',()=>{
      reset();const calls=[];
      const f=gasEmailFixture((op,data)=>{calls.push({op,data});if(op==='quarantine')assert.ok(f.messages.get(data.id).labelIds.includes('queue'),'label remains until durable quarantine');return rawRpc(op,data);});
      f.add('controls','thread1','\u0001'.repeat(16000));
      f.add('invalidutf8');f.messages.get('invalidutf8').payload.body.data=Buffer.from([0xc0,0xaf]).toString('base64url');
      f.add('escaped','thread1','\u0002'.repeat(11000));f.add('fourth','validThread');f.paginateIntakeOnce();
      f.tick();assert.equal(f.sends,0);assert.equal(rpc('health').quarantined,3);
      assert.deepEqual(calls.filter(x=>x.op==='quarantine').map(x=>x.data),[{id:'controls'},{id:'invalidutf8'},{id:'escaped'}]);
      assert.equal(calls.filter(x=>x.op==='ingest').length,0);
      assert.equal(f.tick().status,'sent');assert.equal(f.sends,1);
    });
    await t.test('final redacted envelope respects actual PostgreSQL JSONB byte boundary and UTF-8',()=>{
      for(const excess of [0,1]){
        reset();const f=fixture(),id='boundary';
        const e={...input(id,'thread1',''),subject:'A useful task'};
        const overhead=sql('SELECT octet_length($1::jsonb::text)::int AS n',[JSON.stringify(e)])[0].n;
        const budget=60000-overhead+excess;
        const body='\u0001'.repeat(Math.floor(budget/6))+'x'.repeat(budget%6);
        e.body=body;
        assert.equal(sql('SELECT octet_length($1::jsonb::text)::int AS n',[JSON.stringify(e)])[0].n,60000+excess);
        if(excess)assert.throws(()=>rawRpc('ingest',e),/invalid email request/);
        f.add(id,'thread1',body);f.tick();
        assert.equal(rpc('health').quarantined,excess);
        assert.equal(Number(sql('SELECT count(*) AS n FROM gas_email_receipts')[0].n),1-excess);
      }
      reset();const f=fixture();f.add('utf8','thread1','界'.repeat(16000));f.tick();
      assert.equal(rpc('health').quarantined,0);assert.equal(sql('SELECT envelope->>\'body\' AS body FROM gas_email_receipts')[0].body,'界'.repeat(16000));
      reset();const g=fixture();g.values.OPENROUTER_API_KEY='q';g.add('redaction','thread1','q'.repeat(2000));g.tick();
      assert.equal(rpc('health').quarantined,1);assert.equal(Number(sql('SELECT count(*) AS n FROM gas_email_receipts')[0].n),0);
    });
    await t.test('failed quarantine retains label and prevents a new send until durable acknowledgement',()=>{
      reset();let fail=true;
      const f=gasEmailFixture((op,data)=>{if(op==='quarantine'&&fail)throw new Error('temporary database outage');return rawRpc(op,data);});
      f.add('original');f.loseNextCheckpoint();assert.equal(f.tick().status,'blocked');
      f.add('poison','thread1','\u0001'.repeat(16000));assert.equal(f.tick().status,'intake-unavailable');assert.equal(f.sends,0);
      assert.ok(f.messages.get('poison').labelIds.includes('queue'));assert.equal(rpc('health').quarantined,0);
      fail=false;f.tick();assert.ok(!f.messages.get('poison').labelIds.includes('queue'));assert.equal(rpc('health').quarantined,1);
    });
    await t.test('transient fetch and before-commit ingest failures retry next tick without relabeling',()=>{
      for(const mode of ['fetch','ingest']){
        reset();let fail=true;const f=gasEmailFixture((op,data)=>{if(mode==='ingest'&&op==='ingest'&&fail)throw new Error('before-commit outage');return rawRpc(op,data);});
        f.add('retry');if(mode==='fetch')f.unavailable.add('retry');
        f.tick();assert.equal(f.sends,0);assert.equal(rpc('health').quarantined,0);
        assert.ok(f.messages.get('retry').labelIds.includes('queue'));
        assert.equal(Number(sql('SELECT count(*) AS n FROM gas_email_receipts')[0].n),0);
        fail=false;f.unavailable.clear();assert.equal(f.tick().status,'sent');assert.equal(f.sends,1);
      }
    });
    await t.test('a later Gmail intake page prevents admission until unseen correction is ingested',()=>{
      reset();const f=fixture();f.add('original');f.loseNextCheckpoint();assert.equal(f.tick().status,'blocked');
      f.add('page1');f.messages.get('page1').padding='x'.repeat(250001);f.add('page2','thread1','unsupported','attacker@example.com');f.add('page3','thread1','invalid\u0000body');f.add('correction','thread1','Use the corrected requirement.');
      f.paginateIntakeOnce();
      assert.equal(f.tick().status,'intake-unavailable');assert.equal(f.sends,0);
      assert.equal(sql("SELECT state FROM gas_email_outbox")[0].state,'pending');
      assert.ok(f.messages.get('correction').labelIds.includes('queue'));
      f.setModel(request=>{assert.equal(JSON.parse(request.messages[1].content).inputs[0].message,'Use the corrected requirement.');return {disposition:'done',summary:'Corrected reply.'};});
      assert.equal(f.tick().status,'sent');assert.equal(f.sends,1);
      assert.equal(Number(sql("SELECT count(*) AS n FROM gas_email_outbox WHERE state='superseded'")[0].n),1);
    });
    await t.test('unconsumed correction with transient ingest failure prevents admission of an older pending reply',()=>{
      reset();let fail=false;const f=gasEmailFixture((op,data)=>{if(op==='ingest'&&data.id==='correction'&&fail)throw new Error('before-commit outage');return rawRpc(op,data);});
      f.add('original');f.loseNextCheckpoint();assert.equal(f.tick().status,'blocked');
      f.add('correction','thread1','Use the corrected requirement.');fail=true;
      assert.equal(f.tick().status,'intake-unavailable');assert.equal(f.sends,0);
      assert.equal(sql('SELECT state FROM gas_email_outbox')[0].state,'pending');
      assert.ok(f.messages.get('correction').labelIds.includes('queue'));assert.equal(rpc('health').quarantined,0);
      fail=false;f.setModel(request=>{assert.equal(JSON.parse(request.messages[1].content).inputs[0].message,'Use the corrected requirement.');return {disposition:'done',summary:'Corrected reply.'};});
      assert.equal(f.tick().status,'sent');assert.equal(f.sends,1);
      assert.equal(Number(sql("SELECT count(*) AS n FROM gas_email_outbox WHERE state='superseded'")[0].n),1);
    });
    await t.test('intake outage does not prevent admitted readback, but prevents NEW send admission',()=>{
      reset();const f=fixture();f.add('prior');f.loseNextSend();assert.equal(f.tick().status,'blocked');
      f.add('recoveryPoison');f.messages.get('recoveryPoison').padding='x'.repeat(250001);
      assert.equal(f.tick().status,'sent');assert.equal(f.sends,1);assert.equal(rpc('health').uncertain,0);
      f.add('prior2');f.loseNextSend();assert.equal(f.tick().status,'blocked');
      f.failIntake();assert.equal(f.tick().status,'sent');assert.equal(f.sends,2);assert.equal(rpc('health').uncertain,0);
      reset();const g=fixture();g.add('pending');g.loseNextCheckpoint();assert.equal(g.tick().status,'blocked');
      g.failIntake();assert.equal(g.tick().status,'intake-unavailable');assert.equal(g.sends,0);assert.equal(sql('SELECT state FROM gas_email_outbox')[0].state,'pending');
      g.failIntake(false);assert.equal(g.tick().status,'idle');assert.equal(g.sends,1);
    });
    await t.test('failed and expired snapshots retain all three follow-ups until a new human retry',()=>{
      for(const expire of [false,true]){
        reset();rpc('ingest',input('initial'));checkpoint(rpc('claim'));const d=rpc('delivery');rpc('record',{execution_id:d.execution_id,gmail_id:'initialSent',messageId:d.envelope.messageId,threadId:d.envelope.threadId});
        const before=Number(sql('SELECT consumed_input_seq AS n FROM vnext_pilot_progress')[0].n);
        for(let n=1;n<=3;n++)rpc('ingest',input('follow'+n,'sqlthread','Required follow-up '+n));
        const c=rpc('claim');assert.equal(c.inputs.length,3);
        if(expire){
          sql("BEGIN; UPDATE vnext_executions SET claim_expires_at=clock_timestamp()-interval '1 second' WHERE state='running'; UPDATE vnext_work_units SET claim_expires_at=(SELECT claim_expires_at FROM vnext_executions WHERE state='running'); UPDATE vnext_project_mutation_authority SET claim_expires_at=(SELECT claim_expires_at FROM vnext_executions WHERE state='running'); COMMIT");
          assert.equal(rpc('claim').status,'idle');
        }else rpc('failure',{execution_id:c.execution_id,fence:c.fence});
        assert.equal(rpc('claim').status,'idle');assert.equal(rpc('claim').status,'idle');
        assert.equal(Number(sql('SELECT consumed_input_seq AS n FROM vnext_pilot_progress')[0].n),before);
        rpc('ingest',input('retry','sqlthread','retry'));
        const retry=rpc('claim');assert.equal(retry.previous.summary,'Draft complete.');assert.deepEqual(retry.inputs.map(x=>x.message),['Required follow-up 1','Required follow-up 2','Required follow-up 3']);
        checkpoint(retry);assert.equal(rpc('delivery').status,'superseded');assert.equal(rpc('claim').inputs[0].message,'retry');
      }
    });
    await t.test('input arriving after a failed or expired snapshot triggers exactly one recovery attempt',()=>{
      for(const expire of [false,true]){
        reset();rpc('ingest',input('snapshot','sqlthread','Original requirement'));
        const c=rpc('claim');assert.equal(c.inputs.length,1);
        const snapshotSeq=Number(sql('SELECT input_seq AS n FROM vnext_pilot_inputs')[0].n);
        rpc('ingest',input('post','sqlthread','Arrived after the snapshot'));
        if(expire){
          sql("BEGIN; UPDATE vnext_executions SET claim_expires_at=clock_timestamp()-interval '1 second' WHERE state='running'; UPDATE vnext_work_units SET claim_expires_at=(SELECT claim_expires_at FROM vnext_executions WHERE state='running'); UPDATE vnext_project_mutation_authority SET claim_expires_at=(SELECT claim_expires_at FROM vnext_executions WHERE state='running'); COMMIT");
        }else rpc('failure',{execution_id:c.execution_id,fence:c.fence});
        const recovery=rpc('claim');assert.equal(recovery.status,'claimed');
        assert.equal(Number(sql('SELECT failed_through_seq AS n FROM vnext_pilot_progress')[0].n),snapshotSeq);
        assert.deepEqual(recovery.inputs.map(x=>x.message),['Original requirement','Arrived after the snapshot']);
        checkpoint(recovery);
        const settled=rpc('delivery');assert.equal(settled.status,'send');
        rpc('record',{execution_id:settled.execution_id,gmail_id:'postSent',messageId:settled.envelope.messageId,threadId:settled.envelope.threadId});
        assert.equal(rpc('claim').status,'idle');
      }
    });
    await t.test('canonical multilingual and JSON escaping byte budgets agree before checkpoint, failures preserve input',()=>{
      const turns=[
        {disposition:'done',summary:'界'.repeat(3000),artifact:'界'.repeat(2000)},
        {disposition:'done',summary:'界'.repeat(4000),artifact:'界'.repeat(3000)},
        {disposition:'done',summary:'界'.repeat(3000),artifact:'界'.repeat(2296)},
        {disposition:'done',summary:'界'.repeat(3000),artifact:'界'.repeat(2297)},
        {disposition:'done',summary:'"\\'.repeat(1900),artifact:'"\\'.repeat(1400)},
        {disposition:'done',summary:'"'.repeat(4000),artifact:'"'.repeat(3000),question:'"'.repeat(944)},
        {disposition:'done',summary:'"'.repeat(4000),artifact:'"'.repeat(3000),question:'"'.repeat(945)},
        {disposition:'done',summary:'\u0001'.repeat(3000),artifact:''}
      ];
      for(const turn of turns){
        reset();const f=fixture();f.add('bytes');f.setModel(()=>turn);
        const bytes=['disposition','summary','question','artifact'].reduce((n,k)=>n+Buffer.byteLength(JSON.stringify(turn[k]||'')),0),valid=bytes<=15900;
        assert.equal(f.tick().status,valid?'sent':'model-failed');
        assert.equal(sql('SELECT state FROM vnext_executions')[0].state,valid?'succeeded':'failed');
        if(!valid){
          assert.equal(Number(sql('SELECT consumed_input_seq AS n FROM vnext_pilot_progress')[0].n),0);
          assert.equal(f.tick().status,'idle');f.add('retryBytes','thread1','retry');
          f.setModel(request=>{assert.equal(JSON.parse(request.messages[1].content).inputs[0].message,'Draft a brief thank-you.');return {disposition:'done',summary:'Recovered'};});
          assert.equal(f.tick().status,'sent');
        }
        reset();rpc('ingest',input('sqlBytes'));const c=rpc('claim');
        if(valid)checkpoint(c,turn);else assert.throws(()=>checkpoint(c,turn),/invalid bounded turn/);
      }
    });
    await t.test('RFC2047 folded ASCII, CJK and emoji subjects roundtrip without splitting UTF-8',()=>{
      for(const title of ['A'.repeat(500),'界'.repeat(500),'😀'.repeat(250)]){
        reset();const f=fixture();f.add('subject');f.messages.get('subject').payload.headers.find(h=>h.name==='Subject').value=title;
        assert.equal(f.tick().status,'sent');assert.equal(f.sends,1);assert.ok(f.rawMessages[0].includes('\r\n =?UTF-8?B?'));
      }
      reset();const f=fixture();f.add('preflight');f.loseNextCheckpoint();assert.equal(f.tick().status,'blocked');
      sql("UPDATE gas_email_outbox SET envelope=jsonb_set(envelope,'{subject}',to_jsonb(E'bad\\nheader'::text))");
      assert.equal(f.tick().status,'blocked');assert.equal(f.sends,0);assert.equal(sql('SELECT state FROM gas_email_outbox')[0].state,'pending');assert.equal(rpc('health').uncertain,0);
    });
    await t.test('truncated or duplicate Sent search never settles partial uniqueness',()=>{
      for(const mode of ['token','second-page','same-page']){
        reset();const f=fixture();f.add('search');f.loseNextSend();assert.equal(f.tick().status,'blocked');
        const original=f.messages.get('sent1');
        if(mode==='token')f.truncateSearch();
        else if(mode==='same-page')f.messages.set('duplicate',{...structuredClone(original),id:'duplicate'});
        else {
          for(let n=0;n<9;n++){const m=structuredClone(original);m.id='nonmatch'+n;m.threadId='different';f.messages.set(m.id,m);}
          f.messages.set('hiddenDuplicate',{...structuredClone(original),id:'hiddenDuplicate'});
        }
        assert.equal(f.tick().status,mode==='same-page'?'blocked':'uncertain');assert.equal(f.sends,1);
        assert.equal(sql('SELECT state FROM gas_email_outbox')[0].state,'admitted');assert.equal(rpc('health').blocked,true);
      }
    });
    await t.test('lost admission is uncertain without sending; checkpoint response loss reconstructs once',()=>{
      reset();const f=fixture();f.add('admission');f.loseNextAdmission();assert.equal(f.tick().status,'blocked');assert.equal(f.sends,0);assert.equal(f.tick().status,'uncertain');assert.equal(f.sends,0);
      reset();const g=fixture();g.add('checkpoint');g.loseNextCheckpoint();assert.equal(g.tick().status,'blocked');assert.equal(g.sends,0);assert.equal(g.tick().status,'idle');assert.equal(g.sends,1);
    });
    await t.test('invalid/timeout model fails durably, artifact bounds and no automatic failure retry',()=>{
      for(const model of [()=>'{broken',()=>{throw new Error('timeout');},()=>({disposition:'done',summary:'Draft',artifact:'x'.repeat(3001)}),()=>({disposition:'done',summary:'bad\u0000text'}),()=>({disposition:'done',summary:'bad\ud800text'})]){
        reset();const f=fixture();f.add('bad');f.setModel(model);assert.equal(f.tick().status,'model-failed');assert.equal(f.sends,0);assert.equal(f.tick().status,'idle');
        assert.equal(sql('SELECT state FROM vnext_executions')[0].state,'failed');
      }
      reset();rpc('ingest',input('bounds'));const c=rpc('claim');assert.throws(()=>checkpoint(c,{disposition:'done',summary:'x',artifact:'a'.repeat(3001)}),/invalid bounded turn/);
      assert.equal(Number(sql('SELECT count(*) AS n FROM vnext_pilot_results')[0].n),0);assert.equal(Number(sql('SELECT count(*) AS n FROM gas_email_outbox')[0].n),0);
      reset();const slow=fixture();slow.add('slow');slow.setModel(()=>{slow.advance(300000);return {disposition:'done',summary:'Too late'};});assert.equal(slow.tick().status,'model-failed');assert.equal(slow.sends,0);
    });
    await t.test('mid-checkpoint failure rolls back result, outbox, watermark, receipt and authority atomically',()=>{
      reset();rpc('ingest',input('atomic'));const c=rpc('claim');
      sql("CREATE FUNCTION gas_email_test_abort() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected checkpoint failure'; END $$; CREATE TRIGGER gas_email_test_abort BEFORE UPDATE ON vnext_pilot_progress FOR EACH ROW EXECUTE FUNCTION gas_email_test_abort()");
      try {
        assert.throws(()=>checkpoint(c),/injected checkpoint failure/);
        assert.equal(Number(sql('SELECT count(*) AS n FROM vnext_pilot_results')[0].n),0);
        assert.equal(Number(sql('SELECT count(*) AS n FROM gas_email_outbox')[0].n),0);
        assert.equal(Number(sql('SELECT count(*) AS n FROM gas_email_settlements')[0].n),0);
        assert.equal(Number(sql('SELECT count(*) AS n FROM gas_email_continuations')[0].n),0);
        assert.equal(Number(sql('SELECT consumed_input_seq AS n FROM vnext_pilot_progress')[0].n),0);
        assert.equal(sql('SELECT execution_id FROM vnext_project_mutation_authority')[0].execution_id,c.execution_id);
        assert.equal(sql('SELECT state FROM vnext_executions')[0].state,'running');
      }finally{sql('DROP TRIGGER gas_email_test_abort ON vnext_pilot_progress; DROP FUNCTION gas_email_test_abort()');}
      const settled=checkpoint(c);assert.equal(settled.status,'settled');assert.equal(settled.replay,false);
      assert.equal(Number(sql('SELECT count(*) AS n FROM gas_email_settlements')[0].n),1);
      const replay=checkpoint(c);assert.equal(replay.status,'settled');assert.equal(replay.replay,true);
      assert.equal(Number(sql('SELECT count(*) AS n FROM gas_email_settlements')[0].n),1);
      assert.equal(Number(sql('SELECT count(*) AS n FROM vnext_pilot_results')[0].n),1);
      assert.equal(Number(sql('SELECT count(*) AS n FROM gas_email_outbox')[0].n),1);
    });
    await t.test('a rolled-back continuation checkpoint creates no proposal and replay stays inert',()=>{
      reset();rpc('ingest',input('atomicContinue'));const c=rpc('claim');
      sql("CREATE FUNCTION gas_email_test_abort() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected checkpoint failure'; END $$; CREATE TRIGGER gas_email_test_abort BEFORE UPDATE ON vnext_pilot_progress FOR EACH ROW EXECUTE FUNCTION gas_email_test_abort()");
      try {
        assert.throws(()=>checkpoint(c,{disposition:'continue',summary:'Refining draft.'}),/injected checkpoint failure/);
        assert.equal(Number(sql('SELECT count(*) AS n FROM gas_email_continuations')[0].n),0);
        assert.equal(Number(sql('SELECT count(*) AS n FROM gas_email_settlements')[0].n),0);
        assert.equal(sql('SELECT next_wake_at FROM vnext_pilot_progress')[0].next_wake_at,null);
      }finally{sql('DROP TRIGGER gas_email_test_abort ON vnext_pilot_progress; DROP FUNCTION gas_email_test_abort()');}
      const settled=checkpoint(c,{disposition:'continue',summary:'Refining draft.'});
      assert.equal(settled.status,'settled');assert.equal(settled.replay,false);
      const row=sql('SELECT execution_id,fence::int AS fence,kind,state,eligible_after FROM gas_email_continuations')[0];
      assert.equal(row.execution_id,c.execution_id);assert.equal(row.fence,c.fence);assert.equal(row.kind,'continue');assert.equal(row.state,'pending');assert.ok(row.eligible_after);
      const stored=sql('SELECT created_at,eligible_after FROM gas_email_continuations')[0];
      const replay=checkpoint(c,{disposition:'continue',summary:'Refining draft.'});
      assert.equal(replay.status,'settled');assert.equal(replay.replay,true);
      assert.deepEqual(sql('SELECT created_at,eligible_after FROM gas_email_continuations')[0],stored);
      assert.equal(Number(sql('SELECT count(*) AS n FROM gas_email_continuations')[0].n),1);
    });
    await t.test('settlement receipts replay exactly, reject divergence, and preserve the recorded snapshot',()=>{
      reset();rpc('ingest',input('settle'));const c=rpc('claim');
      const seq=Number(sql('SELECT max(input_seq) AS n FROM vnext_pilot_inputs')[0].n);
      const turn={disposition:'done',summary:'Draft complete.'};
      const first=checkpoint(c,turn);assert.equal(first.status,'settled');assert.equal(first.replay,false);
      assert.deepEqual(sql('SELECT instance_id,project_id,execution_id,fence::int AS fence,input_seq::int AS input_seq,work_state FROM gas_email_settlements')[0],
        {instance_id:'gas-test',project_id:'email-project',execution_id:c.execution_id,fence:c.fence,input_seq:seq,work_state:'review'});
      const stored=sql('SELECT turn,created_at FROM gas_email_settlements')[0];
      const replay=checkpoint(c,turn);assert.equal(replay.status,'settled');assert.equal(replay.replay,true);
      assert.equal(replay.disposition,'done');assert.equal(replay.work_state,'review');assert.equal(Number(replay.input_seq),seq);
      assert.deepEqual(sql('SELECT turn,created_at FROM gas_email_settlements')[0],stored);
      assert.equal(sql('SELECT state FROM vnext_work_units')[0].state,'review');
      assert.equal(Number(sql('SELECT count(*) AS n FROM vnext_project_mutation_authority')[0].n),0);
      assert.throws(()=>checkpoint(c,{disposition:'done',summary:'A different draft.'}),/settlement content conflict/);
      assert.throws(()=>checkpoint({...c,fence:c.fence+1},turn),/settlement content conflict/);
      assert.deepEqual(sql('SELECT turn,created_at FROM gas_email_settlements')[0],stored);
      assert.equal(sql('SELECT state FROM gas_email_outbox')[0].state,'pending');
      assert.equal(Number(sql('SELECT count(*) AS n FROM vnext_pilot_results')[0].n),1);
      assert.equal(Number(sql('SELECT count(*) AS n FROM gas_email_outbox')[0].n),1);
    });
    await t.test('late input during the attempt stays eligible across settlement replay',()=>{
      reset();rpc('ingest',input('capture','sqlthread','Original requirement'));
      const c=rpc('claim');assert.deepEqual(c.inputs.map(x=>x.message),['Original requirement']);
      rpc('ingest',input('late','sqlthread','Arrived after the capture'));
      const seq=Number(sql('SELECT input_seq AS n FROM vnext_pilot_inputs WHERE message=$1',['Original requirement'])[0].n);
      const settled=checkpoint(c);assert.equal(settled.status,'settled');assert.equal(settled.work_state,'actionable');
      assert.equal(Number(sql('SELECT input_seq::int AS n FROM gas_email_settlements')[0].n),seq);
      assert.equal(Number(sql('SELECT consumed_input_seq::int AS n FROM vnext_pilot_progress')[0].n),seq);
      const replay=checkpoint(c);assert.equal(replay.replay,true);assert.equal(replay.work_state,'actionable');
      assert.equal(Number(sql('SELECT consumed_input_seq::int AS n FROM vnext_pilot_progress')[0].n),seq);
      assert.equal(rpc('delivery').status,'superseded');
      const next=rpc('claim');assert.equal(next.status,'claimed');assert.deepEqual(next.inputs.map(x=>x.message),['Arrived after the capture']);
    });
    await t.test('replay after successor admission does not disturb the successor authority',()=>{
      reset();rpc('ingest',input('first','sqlthread','First requirement'));const c1=rpc('claim');
      const first=checkpoint(c1,{disposition:'continue',summary:'Refining draft.'});
      assert.equal(first.status,'settled');assert.equal(first.work_state,'actionable');
      rpc('ingest',input('second','sqlthread','Second requirement'));
      assert.equal(rpc('delivery').status,'superseded');
      const c2=rpc('claim');assert.equal(c2.status,'claimed');assert.deepEqual(c2.inputs.map(x=>x.message),['Second requirement']);
      assert.equal(sql('SELECT state FROM gas_email_continuations')[0].state,'superseded');
      assert.equal(sql('SELECT consumed_by FROM gas_email_continuations')[0].consumed_by,null);
      const replay=checkpoint(c1,{disposition:'continue',summary:'Refining draft.'});
      assert.equal(replay.status,'settled');assert.equal(replay.replay,true);
      assert.equal(sql('SELECT execution_id FROM vnext_project_mutation_authority')[0].execution_id,c2.execution_id);
      assert.equal(sql('SELECT claim_execution_id FROM vnext_work_units')[0].claim_execution_id,c2.execution_id);
      assert.equal(sql('SELECT state FROM vnext_executions WHERE execution_id=$1',[c2.execution_id])[0].state,'running');
      assert.equal(Number(sql('SELECT count(*) AS n FROM gas_email_settlements')[0].n),1);
      assert.equal(Number(sql('SELECT count(*) AS n FROM vnext_pilot_results')[0].n),1);
    });
    await t.test('lost checkpoint response resolves through the durable settlement receipt without repeating model work',()=>{
      reset();let modelCalls=0;const f=fixture();f.add('lostcheckpoint');
      f.setModel(()=>{modelCalls++;return {disposition:'done',summary:'Here is a useful draft.'};});
      f.loseNextCheckpoint();assert.equal(f.tick().status,'blocked');assert.equal(f.sends,0);assert.equal(modelCalls,1);
      const receipt=sql('SELECT execution_id,fence::int AS fence,turn,work_state FROM gas_email_settlements')[0];
      assert.equal(receipt.work_state,'review');
      const replay=rawRpc('checkpoint',{execution_id:receipt.execution_id,fence:receipt.fence,turn:receipt.turn});
      assert.equal(replay.status,'settled');assert.equal(replay.replay,true);
      assert.equal(Number(sql('SELECT count(*) AS n FROM gas_email_settlements')[0].n),1);
      assert.equal(Number(sql('SELECT count(*) AS n FROM vnext_pilot_results')[0].n),1);
      assert.equal(f.tick().status,'idle');assert.equal(f.sends,1);assert.equal(modelCalls,1);
      assert.equal(sql('SELECT state FROM gas_email_outbox')[0].state,'sent');
    });
    await t.test('native concurrent exact replay returns the original settlement without duplication', {skip:!process.env.TEST_DATABASE_URL},async()=>{
      const pool=new Pool({connectionString:process.env.TEST_DATABASE_URL,max:3});
      const auth=async client=>{await client.query('BEGIN');await client.query("SELECT set_config('request.jwt.claims',$1,true)",[JSON.stringify({sub:'gas-owner',aud:'gas-client',iss:'https://accounts.google.com',exp:4102444800})]);await client.query('SET LOCAL ROLE authenticated');};
      try{
        reset();rpc('ingest',input('concurrent'));const c=rpc('claim');
        const payload={execution_id:c.execution_id,fence:c.fence,turn:{disposition:'done',summary:'Draft complete.'}};
        const call=client=>client.query('SELECT gas_email_rpc($1,$2,$3::jsonb) AS r',['gas-test','checkpoint',JSON.stringify(payload)]);
        const a=await pool.connect(),b=await pool.connect();
        try{
          await auth(a);await auth(b);
          const x=(await call(a)).rows[0].r;
          let finished=false;const pending=call(b).then(r=>{finished=true;return r.rows[0].r;});
          await new Promise(resolve=>setTimeout(resolve,100));assert.equal(finished,false,'second settlement must wait on the project admission lock');
          await a.query('COMMIT');const y=await pending;await b.query('COMMIT');
          assert.equal(x.status,'settled');assert.equal(x.replay,false);
          assert.equal(y.status,'settled');assert.equal(y.replay,true);
          assert.equal(Number(sql('SELECT count(*) AS n FROM gas_email_settlements')[0].n),1);
          assert.equal(Number(sql('SELECT count(*) AS n FROM vnext_pilot_results')[0].n),1);
          assert.equal(Number(sql('SELECT count(*) AS n FROM gas_email_outbox')[0].n),1);
        }finally{await a.query('ROLLBACK');await b.query('ROLLBACK');a.release();b.release();}
      }finally{await pool.end();}
    });
    await t.test('native concurrent proposal admission admits exactly one successor', {skip:!process.env.TEST_DATABASE_URL},async()=>{
      const pool=new Pool({connectionString:process.env.TEST_DATABASE_URL,max:3});
      const auth=async client=>{await client.query('BEGIN');await client.query("SELECT set_config('request.jwt.claims',$1,true)",[JSON.stringify({sub:'gas-owner',aud:'gas-client',iss:'https://accounts.google.com',exp:4102444800})]);await client.query('SET LOCAL ROLE authenticated');};
      try{
        reset();rpc('ingest',input('concurrentProposal'));const c=rpc('claim');
        checkpoint(c,{disposition:'continue',summary:'Refining draft.'});
        const delivered=rpc('delivery');rpc('record',{execution_id:delivered.execution_id,gmail_id:'concurrentProposalSent',messageId:delivered.envelope.messageId,threadId:delivered.envelope.threadId});
        sql("UPDATE gas_email_continuations SET eligible_after=clock_timestamp()-interval '1 second' WHERE state='pending' AND kind='continue'");
        const call=client=>client.query('SELECT gas_email_rpc($1,$2,$3::jsonb) AS r',['gas-test','claim','{}']);
        const a=await pool.connect(),b=await pool.connect();
        try{
          await auth(a);await auth(b);
          const x=(await call(a)).rows[0].r;
          let finished=false;const pending=call(b).then(r=>{finished=true;return r.rows[0].r;});
          await new Promise(resolve=>setTimeout(resolve,100));assert.equal(finished,false,'second claim must wait on the project admission lock');
          await a.query('COMMIT');const y=await pending;await b.query('COMMIT');
          assert.equal(x.status,'claimed');assert.equal(y.status,'busy');
          assert.equal(Number(sql('SELECT count(*) AS n FROM vnext_executions')[0].n),2);
          const rows=sql('SELECT state,consumed_by FROM gas_email_continuations');
          assert.equal(rows.length,1);assert.equal(rows[0].state,'consumed');assert.equal(rows[0].consumed_by,x.execution_id);
          assert.equal(Number(sql('SELECT count(*) AS n FROM vnext_pilot_results')[0].n),1);
        }finally{await a.query('ROLLBACK');await b.query('ROLLBACK');a.release();b.release();}
      }finally{await pool.end();}
    });
    await t.test('new human input during model supersedes stale reply and remains eligible',()=>{
      reset();const f=fixture();f.add('during');f.setModel(()=>{rpc('ingest',input('during2','thread1','A new requirement.'));return {disposition:'done',summary:'Old answer'};});
      assert.equal(f.tick().status,'superseded');assert.equal(f.sends,0);const c=rpc('claim');assert.equal(c.inputs[0].message,'A new requirement.');
    });
    await t.test('expired text turn recovery and finite continuation budget',()=>{
      reset();rpc('ingest',input('expire'));rpc('claim');
      sql("BEGIN; UPDATE vnext_executions SET claim_expires_at=clock_timestamp()-interval '1 second'; UPDATE vnext_work_units SET claim_expires_at=(SELECT claim_expires_at FROM vnext_executions LIMIT 1); UPDATE vnext_project_mutation_authority SET claim_expires_at=(SELECT claim_expires_at FROM vnext_executions LIMIT 1); COMMIT");
      assert.equal(rpc('claim').status,'idle');assert.equal(sql('SELECT state FROM vnext_executions')[0].state,'expired');
      reset();rpc('ingest',input('finite'));
      for(let n=0;n<3;n++){const c=rpc('claim');assert.equal(c.status,'claimed');checkpoint(c,{disposition:'continue',summary:'Refining draft.'});const d=rpc('delivery');rpc('record',{execution_id:d.execution_id,gmail_id:'sent'+n,messageId:d.envelope.messageId,threadId:d.envelope.threadId});sql("UPDATE gas_email_continuations SET eligible_after=clock_timestamp()-interval '1 second' WHERE state='pending' AND kind='continue'");}
      assert.equal(rpc('claim').status,'idle');
      assert.equal(Number(sql('SELECT count(*) AS n FROM gas_email_continuations')[0].n),2);
      assert.deepEqual(sql('SELECT state FROM gas_email_continuations ORDER BY created_at').map(r=>r.state),['consumed','consumed']);
      assert.equal(sql('SELECT next_wake_at FROM vnext_pilot_progress')[0].next_wake_at,null);
    });
    await t.test('immediate continuation proposals bind to the attempt and admit exactly one successor',()=>{
      reset();rpc('ingest',input('proposal','sqlthread','Original requirement'));const c=rpc('claim');
      const captured=Number(sql('SELECT input_seq AS n FROM vnext_pilot_inputs WHERE message=$1',['Original requirement'])[0].n);
      const settled=checkpoint(c,{disposition:'continue',summary:'Refining draft.'});
      assert.equal(settled.work_state,'actionable');
      const proposal=sql('SELECT instance_id,project_id,execution_id,fence::int AS fence,input_seq::int AS input_seq,kind,state,eligible_after FROM gas_email_continuations')[0];
      assert.equal(proposal.instance_id,'gas-test');assert.equal(proposal.project_id,'email-project');
      assert.equal(proposal.execution_id,c.execution_id);assert.equal(proposal.fence,c.fence);
      assert.equal(proposal.input_seq,captured);assert.equal(proposal.kind,'continue');assert.equal(proposal.state,'pending');
      const eligible=new Date(proposal.eligible_after).getTime();
      assert.ok(eligible>Date.now()&&eligible<=Date.now()+305000);
      assert.equal(sql('SELECT next_wake_at FROM vnext_pilot_progress')[0].next_wake_at,null);
      assert.equal(sql('SELECT state FROM vnext_work_units')[0].state,'actionable');
      const delivered=rpc('delivery');assert.equal(delivered.status,'send');
      rpc('record',{execution_id:delivered.execution_id,gmail_id:'proposalSent',messageId:delivered.envelope.messageId,threadId:delivered.envelope.threadId});
      const stored=sql('SELECT * FROM gas_email_continuations')[0];
      assert.equal(rpc('claim').status,'idle');
      assert.deepEqual(sql('SELECT * FROM gas_email_continuations')[0],stored);
      sql("UPDATE gas_email_continuations SET eligible_after=clock_timestamp()-interval '1 second' WHERE state='pending' AND kind='continue'");
      const next=rpc('claim');assert.equal(next.status,'claimed');assert.notEqual(next.execution_id,c.execution_id);
      assert.equal(next.previous.summary,'Refining draft.');
      assert.ok(!next.inputs||next.inputs.length===0);
      const consumed=sql('SELECT state,consumed_by,consumed_at FROM gas_email_continuations')[0];
      assert.equal(consumed.state,'consumed');assert.equal(consumed.consumed_by,next.execution_id);assert.ok(consumed.consumed_at);
      assert.equal(Number(sql('SELECT count(*) AS n FROM vnext_pilot_results')[0].n),1);
    });
    await t.test('waiting proposals stay quiet while new human input admits independently',()=>{
      reset();rpc('ingest',input('needsMore','sqlthread','Original requirement'));const c=rpc('claim');
      const settled=checkpoint(c,{disposition:'waiting',summary:'Need input.',question:'Which draft?'});
      assert.equal(settled.work_state,'waiting');
      const proposal=sql('SELECT kind,state,eligible_after FROM gas_email_continuations')[0];
      assert.equal(proposal.kind,'waiting');assert.equal(proposal.state,'pending');assert.equal(proposal.eligible_after,null);
      const delivered=rpc('delivery');assert.equal(delivered.status,'send');
      rpc('record',{execution_id:delivered.execution_id,gmail_id:'waitingSent',messageId:delivered.envelope.messageId,threadId:delivered.envelope.threadId});
      assert.equal(rpc('claim').status,'idle');
      assert.equal(sql('SELECT state FROM vnext_work_units')[0].state,'waiting');
      const stored=sql('SELECT * FROM gas_email_continuations')[0];
      assert.equal(checkpoint(c,{disposition:'waiting',summary:'Need input.',question:'Which draft?'}).replay,true);
      assert.deepEqual(sql('SELECT * FROM gas_email_continuations')[0],stored);
      rpc('ingest',input('reply','sqlthread','Use the second draft.'));
      const next=rpc('claim');assert.equal(next.status,'claimed');assert.deepEqual(next.inputs.map(x=>x.message),['Use the second draft.']);
      const superseded=sql('SELECT state,consumed_by FROM gas_email_continuations ORDER BY created_at')[0];
      assert.equal(superseded.state,'superseded');assert.equal(superseded.consumed_by,null);
      checkpoint(next,{disposition:'continue',summary:'Refining the second draft.'});
      const rows=sql('SELECT execution_id,state,kind,input_seq::int AS input_seq FROM gas_email_continuations ORDER BY created_at');
      assert.equal(rows.length,2);
      assert.equal(rows[1].execution_id,next.execution_id);assert.equal(rows[1].state,'pending');assert.equal(rows[1].kind,'continue');
      assert.equal(rows[1].input_seq,Number(sql('SELECT input_seq AS n FROM vnext_pilot_inputs WHERE message=$1',['Use the second draft.'])[0].n));
    });
    await t.test('late input supersedes the pending proposal without consuming it',()=>{
      reset();rpc('ingest',input('early','sqlthread','Original requirement'));const c=rpc('claim');
      rpc('ingest',input('lateInput','sqlthread','Arrived during the attempt.'));
      assert.equal(checkpoint(c,{disposition:'continue',summary:'Refining draft.'}).work_state,'actionable');
      const proposal=sql('SELECT input_seq::int AS input_seq,state FROM gas_email_continuations')[0];
      assert.equal(proposal.state,'pending');
      assert.equal(proposal.input_seq,Number(sql('SELECT input_seq AS n FROM vnext_pilot_inputs WHERE message=$1',['Original requirement'])[0].n));
      assert.equal(rpc('delivery').status,'superseded');
      const next=rpc('claim');assert.equal(next.status,'claimed');assert.deepEqual(next.inputs.map(x=>x.message),['Arrived during the attempt.']);
      assert.equal(sql('SELECT state FROM gas_email_continuations')[0].state,'superseded');
      assert.equal(sql('SELECT consumed_by FROM gas_email_continuations')[0].consumed_by,null);
    });
    await t.test('a successor attempt records its own proposal bound to the successor execution',()=>{
      reset();rpc('ingest',input('chain','sqlthread','Original requirement'));const c1=rpc('claim');
      checkpoint(c1,{disposition:'continue',summary:'Refining draft.'});
      const delivered=rpc('delivery');rpc('record',{execution_id:delivered.execution_id,gmail_id:'chainSent',messageId:delivered.envelope.messageId,threadId:delivered.envelope.threadId});
      sql("UPDATE gas_email_continuations SET eligible_after=clock_timestamp()-interval '1 second' WHERE state='pending' AND kind='continue'");
      const c2=rpc('claim');assert.equal(c2.status,'claimed');assert.equal(c2.fence,c1.fence+1);
      checkpoint(c2,{disposition:'continue',summary:'Tightening the draft.'});
      const rows=sql('SELECT execution_id,fence::int AS fence,state,consumed_by FROM gas_email_continuations ORDER BY created_at');
      assert.equal(rows.length,2);
      assert.equal(rows[0].execution_id,c1.execution_id);assert.equal(rows[0].state,'consumed');assert.equal(rows[0].consumed_by,c2.execution_id);
      assert.equal(rows[1].execution_id,c2.execution_id);assert.equal(rows[1].fence,c2.fence);assert.equal(rows[1].state,'pending');
      assert.equal(rows[1].consumed_by,null);
    });
    await t.test('a delivery-first rejection leaves the proposal pending for a later admission',()=>{
      reset();rpc('ingest',input('rejected','sqlthread','Original requirement'));const c=rpc('claim');
      checkpoint(c,{disposition:'continue',summary:'Refining draft.'});
      sql("UPDATE gas_email_continuations SET eligible_after=clock_timestamp()-interval '1 second' WHERE state='pending' AND kind='continue'");
      const stored=sql('SELECT * FROM gas_email_continuations')[0];
      assert.equal(rpc('claim').status,'delivery-first');
      assert.deepEqual(sql('SELECT * FROM gas_email_continuations')[0],stored);
      const delivered=rpc('delivery');assert.equal(delivered.status,'send');
      rpc('record',{execution_id:delivered.execution_id,gmail_id:'rejectedSent',messageId:delivered.envelope.messageId,threadId:delivered.envelope.threadId});
      const next=rpc('claim');assert.equal(next.status,'claimed');
      assert.equal(sql('SELECT state FROM gas_email_continuations')[0].state,'consumed');
      assert.equal(sql('SELECT consumed_by FROM gas_email_continuations')[0].consumed_by,next.execution_id);
    });
    await t.test('failure and expiry never manufacture proposals',()=>{
      reset();rpc('ingest',input('failNoProposal'));const c=rpc('claim');
      assert.equal(rpc('failure',{execution_id:c.execution_id,fence:c.fence}).status,'settled');
      assert.equal(Number(sql('SELECT count(*) AS n FROM gas_email_continuations')[0].n),0);
      reset();rpc('ingest',input('expireNoProposal'));rpc('claim');
      sql("BEGIN; UPDATE vnext_executions SET claim_expires_at=clock_timestamp()-interval '1 second' WHERE state='running'; UPDATE vnext_work_units SET claim_expires_at=(SELECT claim_expires_at FROM vnext_executions WHERE state='running'); UPDATE vnext_project_mutation_authority SET claim_expires_at=(SELECT claim_expires_at FROM vnext_executions WHERE state='running'); COMMIT");
      assert.equal(rpc('claim').status,'idle');
      assert.equal(sql('SELECT state FROM vnext_executions')[0].state,'expired');
      assert.equal(Number(sql('SELECT count(*) AS n FROM gas_email_continuations')[0].n),0);
    });
    await t.test('one cold GAS tick admits exactly one bounded successor through the durable proposal',()=>{
      reset();let calls=0;const f=fixture();f.add('coldchain');
      f.setModel(()=>{calls++;return calls===1?{disposition:'continue',summary:'Refining draft.'}:{disposition:'done',summary:'Final draft.'};});
      assert.equal(f.tick().status,'sent');assert.equal(f.sends,1);assert.equal(calls,1);
      assert.equal(Number(sql('SELECT count(*) AS n FROM vnext_executions')[0].n),1);
      assert.equal(sql('SELECT state FROM gas_email_continuations')[0].state,'pending');
      assert.equal(sql('SELECT state FROM vnext_work_units')[0].state,'actionable');
      assert.equal(f.tick().status,'idle');assert.equal(f.sends,1);assert.equal(calls,1);
      sql("UPDATE gas_email_continuations SET eligible_after=clock_timestamp()-interval '1 second' WHERE state='pending' AND kind='continue'");
      assert.equal(f.tick().status,'sent');assert.equal(f.sends,2);assert.equal(calls,2);
      assert.equal(Number(sql('SELECT count(*) AS n FROM vnext_executions')[0].n),2);
      assert.equal(Number(sql('SELECT count(*) AS n FROM gas_email_turns')[0].n),2);
      const rows=sql('SELECT state,consumed_by FROM gas_email_continuations');
      assert.equal(rows.length,1);assert.equal(rows[0].state,'consumed');
      assert.notEqual(rows[0].consumed_by,null);
      assert.equal(sql('SELECT state FROM vnext_work_units')[0].state,'review');
      assert.equal(f.tick().status,'idle');assert.equal(f.sends,2);assert.equal(calls,2);
      assert.equal(Number(sql('SELECT count(*) AS n FROM vnext_executions')[0].n),2);
    });
    await t.test('explicit acceptance binds the settled revision, replays exactly and rejects divergent content',()=>{
      reset();const authority=authorize();
      rpc('ingest',input('accept','sqlthread','Deliver the report.'));const c=rpc('claim');
      const settled=checkpoint(c);assert.equal(settled.work_state,'review');
      const w=sql('SELECT work_unit_id FROM vnext_work_units')[0].work_unit_id;
      const context=rpc('acceptance-context',{work_unit_id:w});
      assert.equal(context.status,'review-ready');assert.equal(context.execution_id,c.execution_id);
      assert.equal(context.fence,c.fence);assert.equal(context.input_seq,settled.input_seq);
      const expected=sql("SELECT encode(sha256(convert_to(jsonb_build_object('instance','gas-test','execution_id',s.execution_id,'fence',s.fence,'input_seq',s.input_seq,'turn',s.turn)::text,'UTF8')),'hex') AS digest FROM gas_email_settlements s")[0].digest;
      assert.equal(context.snapshot_digest,expected);
      assert.throws(()=>rpc('accept',{decision_ref:'reviewed:text-only:v1',work_unit_id:w,execution_id:c.execution_id,fence:c.fence,snapshot_digest:context.snapshot_digest,authority:'reviewed:text-only:v1'}),/acceptance authority required/);
      assert.throws(()=>rpc('accept',{decision_ref:'arbitrary:reference',work_unit_id:w,execution_id:c.execution_id,fence:c.fence,snapshot_digest:context.snapshot_digest}),/acceptance authority required/);
      const decision={decision_ref:'review:thread-1',work_unit_id:w,execution_id:c.execution_id,fence:c.fence,snapshot_digest:context.snapshot_digest,authority};
      assert.throws(()=>rpc('accept',{...decision,decision_ref:'bad ref!'}),/invalid acceptance decision/);
      assert.throws(()=>rpc('accept',{...decision,snapshot_digest:'0'.repeat(63)}),/invalid acceptance decision/);
      assert.throws(()=>rpc('accept',{...decision,execution_id:'foreign-execution'}),/stale acceptance decision/);
      assert.throws(()=>rpc('accept',{...decision,snapshot_digest:'a'.repeat(64)}),/acceptance snapshot mismatch/);
      assert.equal(sql('SELECT state FROM vnext_work_units')[0].state,'review');
      assert.equal(Number(sql('SELECT count(*)::int AS n FROM gas_email_acceptances')[0].n),0);
      const accepted=rpc('accept',decision);
      assert.equal(accepted.status,'accepted');assert.equal(accepted.replay,false);assert.equal(accepted.decision_ref,decision.decision_ref);
      assert.equal(accepted.execution_id,c.execution_id);assert.equal(accepted.fence,c.fence);
      assert.equal(sql('SELECT state FROM vnext_work_units')[0].state,'terminal');
      const row=sql('SELECT instance_id,project_id,work_unit_id,execution_id,fence::int AS fence,input_seq::int AS input_seq,snapshot_digest,authority_ref FROM gas_email_acceptances')[0];
      assert.equal(row.instance_id,'gas-test');assert.equal(row.project_id,'email-project');
      assert.equal(row.work_unit_id,w);assert.equal(row.execution_id,c.execution_id);assert.equal(row.fence,c.fence);
      assert.equal(row.snapshot_digest,context.snapshot_digest);assert.equal(row.authority_ref,authority);
      assert.equal(rpc('health').review,0);assert.equal(rpc('health').accepted,1);
      const replay=rpc('accept',decision);
      assert.equal(replay.status,'accepted');assert.equal(replay.replay,true);assert.equal(replay.accepted_at,accepted.accepted_at);
      assert.equal(Number(sql('SELECT count(*)::int AS n FROM gas_email_acceptances')[0].n),1);
      const after=rpc('acceptance-context',{work_unit_id:w});
      assert.equal(after.status,'not-reviewable');assert.equal(after.work_state,'terminal');
      assert.throws(()=>rpc('accept',{...decision,execution_id:'other-execution'}),/acceptance decision conflict/);
      assert.throws(()=>rpc('accept',{...decision,decision_ref:'review:thread-2',snapshot_digest:'b'.repeat(64)}),/not settled for acceptance/);
    });
    await t.test('stale decisions fail closed against superseded input, newer attempts and unknown work',()=>{
      reset();const authority=authorize();
      rpc('ingest',input('oldAttempt','sqlthread','Original requirement'));const c1=rpc('claim');
      const w=sql('SELECT work_unit_id FROM vnext_work_units')[0].work_unit_id;
      assert.equal(rpc('acceptance-context',{work_unit_id:w}).status,'not-reviewable');
      checkpoint(c1,{disposition:'continue',summary:'Refining draft.'});
      const delivered=rpc('delivery');rpc('record',{execution_id:delivered.execution_id,gmail_id:'staleSent',messageId:delivered.envelope.messageId,threadId:delivered.envelope.threadId});
      sql("UPDATE gas_email_continuations SET eligible_after=clock_timestamp()-interval '1 second' WHERE state='pending' AND kind='continue'");
      const c2=rpc('claim');assert.equal(c2.fence,c1.fence+1);
      checkpoint(c2);
      const context=rpc('acceptance-context',{work_unit_id:w});
      assert.equal(context.status,'review-ready');assert.equal(context.execution_id,c2.execution_id);assert.equal(context.fence,c2.fence);
      assert.throws(()=>rpc('accept',{decision_ref:'review:stale',work_unit_id:w,execution_id:c1.execution_id,fence:c1.fence,snapshot_digest:context.snapshot_digest,authority}),/stale acceptance decision/);
      assert.throws(()=>rpc('accept',{decision_ref:'review:stale',work_unit_id:w,execution_id:c2.execution_id,fence:c1.fence,snapshot_digest:context.snapshot_digest,authority}),/stale acceptance decision/);
      assert.throws(()=>rpc('accept',{decision_ref:'review:unknown',work_unit_id:'no-such-work',execution_id:c2.execution_id,fence:c2.fence,snapshot_digest:context.snapshot_digest,authority}),/unknown email work/);
      const accepted=rpc('accept',{decision_ref:'review:stale',work_unit_id:w,execution_id:c2.execution_id,fence:c2.fence,snapshot_digest:context.snapshot_digest,authority});
      assert.equal(accepted.status,'accepted');assert.equal(accepted.replay,false);
      reset();authorize();
      rpc('ingest',input('supersededInput','sqlthread','Original requirement'));const c3=rpc('claim');checkpoint(c3);
      const w3=sql('SELECT work_unit_id FROM vnext_work_units')[0].work_unit_id;
      const digest3=rpc('acceptance-context',{work_unit_id:w3}).snapshot_digest;
      rpc('ingest',input('newerInput','sqlthread','Use this instead.'));
      assert.equal(sql('SELECT state FROM vnext_work_units')[0].state,'actionable');
      assert.equal(rpc('acceptance-context',{work_unit_id:w3}).status,'not-reviewable');
      assert.throws(()=>rpc('accept',{decision_ref:'review:superseded',work_unit_id:w3,execution_id:c3.execution_id,fence:c3.fence,snapshot_digest:digest3,authority}),/not settled for acceptance/);
      sql("INSERT INTO vnext_pilot_inputs(receipt_id,work_unit_id,message) VALUES('ghost','"+w3+"','Ghost input'); UPDATE vnext_work_units SET state='review' WHERE work_unit_id='"+w3+"'");
      assert.equal(rpc('acceptance-context',{work_unit_id:w3}).status,'not-reviewable');
      assert.throws(()=>rpc('accept',{decision_ref:'review:superseded',work_unit_id:w3,execution_id:c3.execution_id,fence:c3.fence,snapshot_digest:digest3,authority}),/stale acceptance decision/);
      assert.equal(sql('SELECT state FROM vnext_work_units')[0].state,'review');
    });
    await t.test('a failing acceptance transition rolls back atomically',()=>{
      reset();const authority=authorize();
      rpc('ingest',input('atomic'));const c=rpc('claim');checkpoint(c);
      const w=sql('SELECT work_unit_id FROM vnext_work_units')[0].work_unit_id;
      const digest=rpc('acceptance-context',{work_unit_id:w}).snapshot_digest;
      sql("CREATE FUNCTION reject_acceptance() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected acceptance failure'; END $$; CREATE TRIGGER reject_acceptance BEFORE INSERT ON gas_email_acceptances FOR EACH ROW EXECUTE FUNCTION reject_acceptance()");
      assert.throws(()=>rpc('accept',{decision_ref:'review:atomic',work_unit_id:w,execution_id:c.execution_id,fence:c.fence,snapshot_digest:digest,authority}),/injected acceptance failure/);
      assert.equal(sql('SELECT state FROM vnext_work_units')[0].state,'review');
      assert.equal(Number(sql('SELECT count(*)::int AS n FROM gas_email_acceptances')[0].n),0);
      sql('DROP TRIGGER reject_acceptance ON gas_email_acceptances; DROP FUNCTION reject_acceptance()');
      assert.equal(rpc('accept',{decision_ref:'review:atomic',work_unit_id:w,execution_id:c.execution_id,fence:c.fence,snapshot_digest:digest,authority}).status,'accepted');
      assert.equal(sql('SELECT state FROM vnext_work_units')[0].state,'terminal');
    });
    await t.test('unresolved effects and active mutation block new acceptance until resolved',()=>{
      reset();const authority=authorize();
      rpc('ingest',input('blockedAccept','threadBlocked','Deliver the report.'));const c=rpc('claim');checkpoint(c);
      const w=sql('SELECT work_unit_id FROM vnext_work_units')[0].work_unit_id;
      const context=rpc('acceptance-context',{work_unit_id:w});assert.equal(context.status,'review-ready');
      rpc('ingest',input('secondThread','threadSecond','Another task.'));
      const delivered=rpc('delivery');assert.equal(delivered.status,'send');
      const blocked=rpc('acceptance-context',{work_unit_id:w});
      assert.equal(blocked.status,'not-reviewable');assert.equal(blocked.reason,'project-blocked');
      assert.throws(()=>rpc('accept',{decision_ref:'review:blocked',work_unit_id:w,execution_id:c.execution_id,fence:c.fence,snapshot_digest:context.snapshot_digest,authority}),/acceptance blocked during reconciliation/);
      rpc('record',{execution_id:delivered.execution_id,gmail_id:'blockedAcceptSent',messageId:delivered.envelope.messageId,threadId:delivered.envelope.threadId});
      assert.equal(rpc('health').blocked,false);
      assert.equal(rpc('acceptance-context',{work_unit_id:w}).status,'review-ready');
      const c2=rpc('claim');assert.equal(c2.status,'claimed');assert.notEqual(c2.execution_id,c.execution_id);
      const busy=rpc('acceptance-context',{work_unit_id:w});
      assert.equal(busy.status,'not-reviewable');assert.equal(busy.reason,'project-busy');
      assert.throws(()=>rpc('accept',{decision_ref:'review:blocked',work_unit_id:w,execution_id:c.execution_id,fence:c.fence,snapshot_digest:context.snapshot_digest,authority}),/acceptance blocked during active execution/);
      checkpoint(c2);
      assert.equal(rpc('acceptance-context',{work_unit_id:w}).status,'review-ready');
      const accepted=rpc('accept',{decision_ref:'review:blocked',work_unit_id:w,execution_id:c.execution_id,fence:c.fence,snapshot_digest:context.snapshot_digest,authority});
      assert.equal(accepted.status,'accepted');assert.equal(accepted.replay,false);
      assert.equal(sql('SELECT state FROM vnext_work_units WHERE work_unit_id=$1',[w])[0].state,'terminal');
    });
    await t.test('native concurrent acceptance of one decision records exactly one acceptance', {skip:!process.env.TEST_DATABASE_URL},async()=>{
      const pool=new Pool({connectionString:process.env.TEST_DATABASE_URL,max:3});
      const auth=async client=>{await client.query('BEGIN');await client.query("SELECT set_config('request.jwt.claims',$1,true)",[JSON.stringify({sub:'gas-owner',aud:'gas-client',iss:'https://accounts.google.com',exp:4102444800})]);await client.query('SET LOCAL ROLE authenticated');};
      try{
        reset();const authority=authorize();
        rpc('ingest',input('concurrentAccept'));const c=rpc('claim');checkpoint(c);
        const w=sql('SELECT work_unit_id FROM vnext_work_units')[0].work_unit_id;
        const digest=rpc('acceptance-context',{work_unit_id:w}).snapshot_digest;
        const payload={decision_ref:'review:concurrent',work_unit_id:w,execution_id:c.execution_id,fence:c.fence,snapshot_digest:digest,authority};
        const call=client=>client.query('SELECT gas_email_rpc($1,$2,$3::jsonb) AS r',['gas-test','accept',JSON.stringify(payload)]);
        const a=await pool.connect(),b=await pool.connect();
        try{
          await auth(a);await auth(b);
          const x=(await call(a)).rows[0].r;
          let finished=false;const pending=call(b).then(r=>{finished=true;return r.rows[0].r;});
          await new Promise(resolve=>setTimeout(resolve,100));assert.equal(finished,false,'second acceptance must wait on the project admission lock');
          await a.query('COMMIT');const y=await pending;await b.query('COMMIT');
          assert.equal(x.status,'accepted');assert.equal(x.replay,false);
          assert.equal(y.status,'accepted');assert.equal(y.replay,true);assert.equal(y.accepted_at,x.accepted_at);
          assert.equal(y.decision_ref,x.decision_ref);assert.equal(y.snapshot_digest,x.snapshot_digest);
          assert.equal(Number(sql('SELECT count(*)::int AS n FROM gas_email_acceptances')[0].n),1);
          assert.equal(sql('SELECT state FROM vnext_work_units')[0].state,'terminal');
        }finally{await a.query('ROLLBACK');await b.query('ROLLBACK');a.release();b.release();}
      }finally{await pool.end();}
    });
    await t.test('native transaction races: input-first supersedes; admission-first blocks claims, preserves input', {skip:!process.env.TEST_DATABASE_URL},async()=>{
      const pool=new Pool({connectionString:process.env.TEST_DATABASE_URL,max:3});
      const auth=async client=>{await client.query('BEGIN');await client.query("SELECT set_config('request.jwt.claims',$1,true)",[JSON.stringify({sub:'gas-owner',aud:'gas-client',iss:'https://accounts.google.com',exp:4102444800})]);await client.query('SET LOCAL ROLE authenticated');};
      let prepared;
      const call=(client,op,data={})=>client.query('SELECT gas_email_rpc($1,$2,$3::jsonb) AS r',['gas-test',op,JSON.stringify(op==='delivery'?{execution_id:prepared}:data)]);
      try{
        for(const first of ['ingest','delivery']){
          reset();rpc('ingest',input('race'));checkpoint(rpc('claim'));
          prepared=rpc('delivery-peek').execution_id;
          const a=await pool.connect(),b=await pool.connect();
          try{
            await auth(a);await auth(b);const x=(await call(a,first,first==='ingest'?input('newrace'):{})).rows[0].r;
            let finished=false;const pending=call(b,first==='ingest'?'delivery':'ingest',first==='ingest'?{}:input('newrace')).then(r=>{finished=true;return r.rows[0].r;});
            await new Promise(resolve=>setTimeout(resolve,100));assert.equal(finished,false,'second transaction must wait on project admission');
            await a.query('COMMIT');const y=await pending;await b.query('COMMIT');
            if(first==='ingest'){assert.equal(y.status,'superseded');assert.equal(rpc('claim').status,'claimed');}
            else {assert.equal(x.status,'send');assert.equal(y.status,'inserted');assert.equal(rpc('claim').status,'blocked');rpc('record',{execution_id:x.execution_id,gmail_id:'racesent',messageId:x.envelope.messageId,threadId:x.envelope.threadId});assert.equal(rpc('claim').inputs[0].message,'Please draft.');}
          }finally{await a.query('ROLLBACK');await b.query('ROLLBACK');a.release();b.release();}
        }
      }finally{await pool.end();}
    });
  }finally{worker.postMessage({type:'close'});await once(worker,'message');await worker.terminate();}
});
