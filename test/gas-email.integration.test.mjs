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
  const rpc=(operation,input,extra={})=>request({type:'rpc',operation,input,...extra});
  const fixture=()=>gasEmailFixture(rpc);
  const input=(id,thread='sqlthread',body='Please draft.')=>({id,threadId:thread,from:'midnightprojectantigravity@gmail.com',to:'midnight.project.mp@gmail.com',reference:`<${id}@example.com>`,subject:'Task',body});
  const checkpoint=(claim,turn={disposition:'done',summary:'Draft complete.'})=>rpc('checkpoint',{execution_id:claim.execution_id,fence:claim.fence,turn});
  const reset=()=>sql('TRUNCATE gas_email_instances, vnext_work_units CASCADE; INSERT INTO gas_email_instances VALUES (\'gas-test\',\'gas-owner\',\'gas-client\',\'email-project\',\'midnight.project.mp@gmail.com\',\'midnightprojectantigravity@gmail.com\',true,\'reviewed:text-only:v1\')');
  try {
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
      const inv=f.cold().inventoryVnextEmailProperties();assert.equal(inv.counts.stable,6);assert.equal(inv.cleanup_apply_available,false);
      assert.equal(f.cold().installVnextEmailTrigger().status,'installed');assert.equal(f.cold().installVnextEmailTrigger().status,'installed');
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
    await t.test('lost admission is uncertain without sending; checkpoint response loss reconstructs once',()=>{
      reset();const f=fixture();f.add('admission');f.loseNextAdmission();assert.equal(f.tick().status,'blocked');assert.equal(f.sends,0);assert.equal(f.tick().status,'uncertain');assert.equal(f.sends,0);
      reset();const g=fixture();g.add('checkpoint');g.loseNextCheckpoint();assert.equal(g.tick().status,'blocked');assert.equal(g.sends,0);assert.equal(g.tick().status,'idle');assert.equal(g.sends,1);
    });
    await t.test('invalid/timeout model fails durably, artifact bounds and no automatic failure retry',()=>{
      for(const model of [()=>'{broken',()=>{throw new Error('timeout');},()=>({disposition:'done',summary:'Draft',artifact:'x'.repeat(3001)})]){
        reset();const f=fixture();f.add('bad');f.setModel(model);assert.equal(f.tick().status,'model-failed');assert.equal(f.sends,0);assert.equal(f.tick().status,'idle');
        assert.equal(sql('SELECT state FROM vnext_executions')[0].state,'failed');
      }
      reset();rpc('ingest',input('bounds'));const c=rpc('claim');assert.throws(()=>checkpoint(c,{disposition:'done',summary:'x',artifact:'a'.repeat(3001)}),/invalid bounded turn/);
      assert.equal(Number(sql('SELECT count(*) AS n FROM vnext_pilot_results')[0].n),0);assert.equal(Number(sql('SELECT count(*) AS n FROM gas_email_outbox')[0].n),0);
      reset();const slow=fixture();slow.add('slow');slow.setModel(()=>{slow.advance(300000);return {disposition:'done',summary:'Too late'};});assert.equal(slow.tick().status,'model-failed');assert.equal(slow.sends,0);
    });
    await t.test('mid-checkpoint failure rolls back result, outbox, watermark and authority atomically',()=>{
      reset();rpc('ingest',input('atomic'));const c=rpc('claim');
      sql("CREATE FUNCTION gas_email_test_abort() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected checkpoint failure'; END $$; CREATE TRIGGER gas_email_test_abort BEFORE UPDATE ON vnext_pilot_progress FOR EACH ROW EXECUTE FUNCTION gas_email_test_abort()");
      try {
        assert.throws(()=>checkpoint(c),/injected checkpoint failure/);
        assert.equal(Number(sql('SELECT count(*) AS n FROM vnext_pilot_results')[0].n),0);
        assert.equal(Number(sql('SELECT count(*) AS n FROM gas_email_outbox')[0].n),0);
        assert.equal(Number(sql('SELECT consumed_input_seq AS n FROM vnext_pilot_progress')[0].n),0);
        assert.equal(sql('SELECT execution_id FROM vnext_project_mutation_authority')[0].execution_id,c.execution_id);
        assert.equal(sql('SELECT state FROM vnext_executions')[0].state,'running');
      }finally{sql('DROP TRIGGER gas_email_test_abort ON vnext_pilot_progress; DROP FUNCTION gas_email_test_abort()');}
      checkpoint(c);assert.throws(()=>checkpoint(c),/stale email fence/);
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
      for(let n=0;n<3;n++){const c=rpc('claim');assert.equal(c.status,'claimed');checkpoint(c,{disposition:'continue',summary:'Refining draft.'});const d=rpc('delivery');rpc('record',{execution_id:d.execution_id,gmail_id:'sent'+n,messageId:d.envelope.messageId,threadId:d.envelope.threadId});sql("UPDATE vnext_pilot_progress SET next_wake_at=CASE WHEN next_wake_at IS NOT NULL THEN clock_timestamp()-interval '1 second' END");}
      assert.equal(rpc('claim').status,'idle');
    });
    await t.test('native transaction races: input-first supersedes; admission-first blocks claims, preserves input', {skip:!process.env.TEST_DATABASE_URL},async()=>{
      const pool=new Pool({connectionString:process.env.TEST_DATABASE_URL,max:3});
      const auth=async client=>{await client.query('BEGIN');await client.query("SELECT set_config('request.jwt.claims',$1,true)",[JSON.stringify({sub:'gas-owner',aud:'gas-client',iss:'https://accounts.google.com',exp:4102444800})]);await client.query('SET LOCAL ROLE authenticated');};
      const call=(client,op,data={})=>client.query('SELECT gas_email_rpc($1,$2,$3::jsonb) AS r',['gas-test',op,JSON.stringify(data)]);
      try{
        for(const first of ['ingest','delivery']){
          reset();rpc('ingest',input('race'));checkpoint(rpc('claim'));
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
