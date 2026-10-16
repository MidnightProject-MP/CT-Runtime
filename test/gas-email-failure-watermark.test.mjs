import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { once } from 'node:events';

// F1: failure or expiry may suppress automatic retry of the captured attempt,
// but must not suppress input received after that attempt's snapshot. The
// watermark binds to the validated attempt's gas_email_turns row; a missing
// binding fails closed instead of falling back to the latest work-unit input.
test('GAS failure and expiry watermarks bind to the attempt snapshot', {timeout:120000}, async t=>{
  const signal=new SharedArrayBuffer(8),bytes=new SharedArrayBuffer(2000000),state=new Int32Array(signal);
  const worker=new Worker(new URL('./gas-email-sql-worker.mjs',import.meta.url),{workerData:{signal,bytes}});
  const [ready]=await once(worker,'message');assert.equal(ready.error,undefined);
  function request(message){Atomics.store(state,0,0);worker.postMessage(message);assert.notEqual(Atomics.wait(state,0,0,30000),'timed-out');const answer=JSON.parse(new TextDecoder().decode(new Uint8Array(bytes,0,Atomics.load(state,1))));if(answer.error)throw new Error(answer.error);return answer.result;}
  const sql=(sql,args)=>request({type:'sql',sql,args});
  const rpc=(operation,input)=>request({type:'rpc',operation,input});
  const input=(id,body)=>({id,threadId:'f1thread',from:'midnightprojectantigravity@gmail.com',to:'midnight.project.mp@gmail.com',reference:`<${id}@example.com>`,subject:'Task',body});
  const reset=()=>sql("TRUNCATE gas_email_instances, vnext_work_units RESTART IDENTITY CASCADE; INSERT INTO gas_email_instances VALUES ('gas-test','gas-owner','gas-client','email-project','midnight.project.mp@gmail.com','midnightprojectantigravity@gmail.com',true,'reviewed:text-only:v1')");
  const progress=()=>sql('SELECT consumed_input_seq::int AS consumed,failed_through_seq::int AS failed,next_wake_at FROM vnext_pilot_progress')[0];
  const seq=message=>Number(sql('SELECT input_seq::int AS n FROM vnext_pilot_inputs WHERE message=$1',[message])[0].n);
  const messages=claim=>claim.inputs.map(x=>x.message);
  const fail=claim=>rpc('failure',{execution_id:claim.execution_id,fence:claim.fence});
  const expire=()=>sql("BEGIN; UPDATE vnext_executions SET claim_expires_at=clock_timestamp()-interval '1 second' WHERE state='running'; UPDATE vnext_work_units SET claim_expires_at=(SELECT claim_expires_at FROM vnext_executions WHERE state='running'); UPDATE vnext_project_mutation_authority SET claim_expires_at=(SELECT claim_expires_at FROM vnext_executions WHERE state='running'); COMMIT");
  try{
    await t.test('settlement watermarks bind to the attempt row with no latest-input fallback',()=>{
      const src=sql("SELECT prosrc FROM pg_proc WHERE proname='gas_email_rpc_bootstrap'")[0].prosrc;
      assert.ok(src.includes("failed_through_seq=CASE WHEN p_operation='failure' THEN t.input_seq ELSE 0 END"),'failure binds to the validated attempt');
      assert.ok(src.includes('failed_through_seq=(SELECT t2.input_seq FROM public.gas_email_turns t2 WHERE t2.execution_id=a.execution_id AND t2.instance_id=i.instance_id)'),'expiry resolves the expired authority execution');
      assert.ok(!src.includes('SELECT max(input_seq) FROM public.vnext_pilot_inputs'),'no latest-input fallback remains');
    });
    await t.test('input received after a failed attempt snapshot stays eligible and durable',()=>{
      reset();
      rpc('ingest',input('a1','First request.'));
      const c1=rpc('claim');assert.equal(c1.status,'claimed');assert.deepEqual(messages(c1),['First request.']);
      rpc('ingest',input('b1','Second request.'));
      fail(c1);
      assert.deepEqual(progress(),{consumed:0,failed:seq('First request.'),next_wake_at:null});
      assert.equal(Number(sql('SELECT count(*)::int AS n FROM vnext_pilot_inputs')[0].n),2);
      const c2=rpc('claim');assert.equal(c2.status,'claimed');
      assert.deepEqual(c2.inputs.map(x=>x.input_seq),[1,2]);
      assert.deepEqual(messages(c2),['First request.','Second request.']);
      rpc('checkpoint',{execution_id:c2.execution_id,fence:c2.fence,turn:{disposition:'done',summary:'Recovered.'}});
      assert.deepEqual(progress(),{consumed:2,failed:0,next_wake_at:null});
    });
    await t.test('input received after an expired attempt snapshot stays eligible',()=>{
      reset();
      rpc('ingest',input('e1','Original request.'));
      const c1=rpc('claim');assert.equal(c1.status,'claimed');
      rpc('ingest',input('e2','Post-snapshot request.'));
      expire();
      const c2=rpc('claim');assert.equal(c2.status,'claimed');
      assert.equal(sql('SELECT state FROM vnext_executions WHERE execution_id=$1',[c1.execution_id])[0].state,'expired');
      assert.deepEqual(progress(),{consumed:0,failed:seq('Original request.'),next_wake_at:null});
      assert.deepEqual(c2.inputs.map(x=>x.input_seq),[1,2]);
      assert.deepEqual(messages(c2),['Original request.','Post-snapshot request.']);
    });
    await t.test('repeated recovery advances the watermark one snapshot at a time and never suppresses newer input',()=>{
      reset();
      rpc('ingest',input('p1','Cycle one.'));
      const c1=rpc('claim');assert.equal(c1.status,'claimed');fail(c1);
      assert.equal(progress().failed,seq('Cycle one.'));
      rpc('ingest',input('p2','Cycle two.'));
      const c2=rpc('claim');assert.equal(c2.status,'claimed');
      rpc('checkpoint',{execution_id:c2.execution_id,fence:c2.fence,turn:{disposition:'done',summary:'Cycle two settled.'}});
      const sent=rpc('delivery',{execution_id:rpc('delivery-peek').execution_id});assert.equal(sent.status,'send');
      rpc('record',{execution_id:sent.execution_id,gmail_id:'f1sent1',messageId:sent.envelope.messageId,threadId:sent.envelope.threadId});
      assert.deepEqual(progress(),{consumed:2,failed:0,next_wake_at:null});
      rpc('ingest',input('p3','Cycle three.'));
      const c3=rpc('claim');assert.equal(c3.status,'claimed');assert.deepEqual(messages(c3),['Cycle three.']);
      rpc('ingest',input('p4','Cycle four.'));
      fail(c3);
      assert.deepEqual(progress(),{consumed:2,failed:3,next_wake_at:null});
      const c4=rpc('claim');assert.equal(c4.status,'claimed');assert.deepEqual(messages(c4),['Cycle three.','Cycle four.']);
      rpc('ingest',input('p5','Cycle five.'));
      fail(c4);
      assert.equal(progress().failed,4);
      const c5=rpc('claim');assert.equal(c5.status,'claimed');assert.deepEqual(messages(c5),['Cycle three.','Cycle four.','Cycle five.']);
      assert.equal(Number(sql('SELECT count(*)::int AS n FROM vnext_pilot_inputs')[0].n),5);
    });
    await t.test('failure or expiry without newer input never creates an automatic retry loop',()=>{
      reset();
      rpc('ingest',input('q1','Needs attention.'));
      const c1=rpc('claim');fail(c1);
      assert.deepEqual(progress(),{consumed:0,failed:seq('Needs attention.'),next_wake_at:null});
      assert.equal(sql('SELECT state FROM vnext_work_units')[0].state,'waiting');
      assert.equal(rpc('claim').status,'idle');assert.equal(rpc('claim').status,'idle');
      assert.equal(Number(sql('SELECT count(*)::int AS n FROM vnext_executions')[0].n),1);
      reset();
      rpc('ingest',input('q2','Needs attention.'));
      const e1=rpc('claim');expire();
      assert.equal(rpc('claim').status,'idle');assert.equal(rpc('claim').status,'idle');
      assert.equal(sql('SELECT state FROM vnext_executions WHERE execution_id=$1',[e1.execution_id])[0].state,'expired');
      assert.deepEqual(progress(),{consumed:0,failed:seq('Needs attention.'),next_wake_at:null});
      assert.equal(Number(sql("SELECT count(*)::int AS n FROM vnext_executions WHERE state='running'")[0].n),0);
    });
  }finally{worker.postMessage({type:'close'});await once(worker,'message');await worker.terminate();}
});
