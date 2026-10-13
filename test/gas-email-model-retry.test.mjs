import test from 'node:test';
import assert from 'node:assert/strict';
import { testPool } from './pilot-test-pool.mjs';
import { bootstrap } from '../scripts/bootstrap-gas-email.mjs';
import { upgradeDelivery } from '../scripts/upgrade-gas-email-delivery.mjs';
import { retryModel,RETRY as r } from '../scripts/retry-gas-email-model.mjs';
import { modelFailureMetadata } from '../scripts/model-failure-metadata.mjs';
test('inspector excludes arbitrary fields and unbounded metadata',()=>{
 assert.deepEqual(modelFailureMetadata({code:'SECRET',classification:'model-validation',contentChars:Infinity,contentPresent:'SECRET',unknown:'SECRET',httpStatus:500}),{classification:'model-validation',httpStatus:500});
});
test('one-off retry is snapshot guarded, immutable, atomic and never changes original evidence',async()=>{
 const pool=await testPool();try{
  await bootstrap(pool,{apply:true});await upgradeDelivery(pool,{apply:true});
  await pool.query("INSERT INTO gas_email_instances VALUES($1,'owner','client',$2,'midnight.project.mp@gmail.com','midnightprojectantigravity@gmail.com',true,'user-authorized:pr69:gas-text-only:v1')",[r.instance,r.project]);
  await pool.query("INSERT INTO vnext_work_units(work_unit_id,objective_ref,state,project_id,fence) VALUES($1,'gmail:test','waiting',$2,2)",[r.work,r.project]);
  await pool.query('INSERT INTO gas_email_threads VALUES($1,$2,$3)',[r.work,r.instance,'thread']);
  await pool.query('INSERT INTO vnext_pilot_progress(work_unit_id,consumed_input_seq,failed_through_seq) VALUES($1,1,2)',[r.work]);
  for(const n of [1,2])await pool.query('INSERT INTO vnext_pilot_inputs(input_seq,receipt_id,work_unit_id,message) VALUES($1,$2,$3,$4)',[n,'receipt'+n,r.work,'text'+n]);
  await pool.query('INSERT INTO gas_email_receipts VALUES($1,$2,2,$3)',[r.instance,r.message,JSON.stringify({id:r.message,body:'text2'})]);
  for(const [id,fence,state] of [[r.oldExecution,1,'succeeded'],[r.execution,2,'failed']])await pool.query("INSERT INTO vnext_executions(execution_id,work_unit_id,project_id,owner,fence,state,started_at,finished_at,authorization_decision_ref,failure) VALUES($1,$2,$3,$4,$5,$6,clock_timestamp(),clock_timestamp(),'user-authorized:pr69:gas-text-only:v1',$7)",[id,r.work,r.project,r.instance,fence,state,state==='failed'?{reason:'bounded-model-failure'}:null]);
  await pool.query('INSERT INTO gas_email_turns VALUES($1,2,$2)',[r.execution,r.instance]);
  await pool.query('INSERT INTO gas_email_turns VALUES($1,1,$2)',[r.oldExecution,r.instance]);
  await pool.query("INSERT INTO gas_email_outbox(execution_id,instance_id,work_unit_id,input_seq,envelope,state,gmail_id) VALUES($1,$2,$3,1,'{}','sent',$4)",[r.oldExecution,r.instance,r.work,r.oldReply]);
  const before=async()=>({executions:(await pool.query('SELECT * FROM vnext_executions ORDER BY execution_id')).rows,inputs:(await pool.query('SELECT * FROM vnext_pilot_inputs ORDER BY input_seq')).rows,outbox:(await pool.query('SELECT * FROM gas_email_outbox')).rows});
  const original=await before(),inspection=await retryModel(pool);assert.equal(inspection.status,'retry-ready');
  await assert.rejects(retryModel(pool,{apply:true,expectedSnapshot:inspection.snapshot}));
  await assert.rejects(retryModel(pool,{apply:true,deployed:true,expectedSnapshot:'wrong'}));
  await pool.query("UPDATE gas_email_outbox SET state='pending'");await assert.rejects(retryModel(pool));await pool.query("UPDATE gas_email_outbox SET state='sent'");
  await pool.query("CREATE FUNCTION retry_test_reject() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected'; END $$; REVOKE ALL ON FUNCTION retry_test_reject() FROM PUBLIC,authenticated,anonymous; CREATE TRIGGER retry_test_reject BEFORE UPDATE ON vnext_pilot_progress FOR EACH ROW EXECUTE FUNCTION retry_test_reject()");
  await assert.rejects(retryModel(pool,{apply:true,deployed:true,expectedSnapshot:inspection.snapshot}),/injected/);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM vnext_events WHERE event_type='gas-email-owner-model-retry'")).rows[0].n,0);
  await pool.query('DROP TRIGGER retry_test_reject ON vnext_pilot_progress; DROP FUNCTION retry_test_reject()');
  assert.equal((await retryModel(pool,{apply:true,deployed:true,expectedSnapshot:inspection.snapshot})).status,'retry-released');
  assert.equal((await retryModel(pool,{apply:true,deployed:true,expectedSnapshot:inspection.snapshot})).status,'already-retried');
  assert.deepEqual(await before(),original);
  assert.equal((await pool.query('SELECT state FROM vnext_work_units')).rows[0].state,'actionable');
  await assert.rejects(pool.query("DELETE FROM vnext_events WHERE event_type='gas-email-owner-model-retry'"),/immutable/);
 }finally{await pool.end();}
});
