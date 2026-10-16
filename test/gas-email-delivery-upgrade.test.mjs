import test from 'node:test';
import assert from 'node:assert/strict';
import { testPool } from './pilot-test-pool.mjs';
import { bootstrap } from '../scripts/bootstrap-gas-email.mjs';
import { upgradeDelivery } from '../scripts/upgrade-gas-email-delivery.mjs';
import { repairDelivery,REPAIR } from '../scripts/repair-gas-email-delivery.mjs';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

test('known 002 prefix upgrades without relabeling its checksum; unknown prefix fails closed',async()=>{
 const pool=await testPool();try{
  await bootstrap(pool,{apply:true});
  const sql=(await readFile(new URL('../deploy/gas-email/002_delivery_provider_receipts.sql',import.meta.url),'utf8')).replace(/\r\n/g,'\n');
  const hash=createHash('sha256').update(sql).digest('hex');await pool.query(sql);
  await pool.query('CREATE TABLE gas_email_upgrade_ledger(upgrade_id text PRIMARY KEY,sha256 text NOT NULL,applied_at timestamptz NOT NULL DEFAULT clock_timestamp()); REVOKE ALL ON gas_email_upgrade_ledger FROM PUBLIC,authenticated,anonymous');
  await pool.query("INSERT INTO gas_email_upgrade_ledger(upgrade_id,sha256) VALUES('002_delivery_provider_receipts',$1)",[hash]);
  const original=(await pool.query('SELECT * FROM gas_email_upgrade_ledger')).rows[0];
  assert.deepEqual((await upgradeDelivery(pool)).pending,['003_model_diagnostics','004_failure_watermark_snapshot','005_failure_recovery_boundary','006_settlement_receipts']);
  assert.equal((await upgradeDelivery(pool,{apply:true})).status,'applied');
  assert.deepEqual((await pool.query("SELECT * FROM gas_email_upgrade_ledger WHERE upgrade_id='002_delivery_provider_receipts'")).rows[0],original);
  await pool.query("INSERT INTO gas_email_upgrade_ledger(upgrade_id,sha256) VALUES('004_unknown','unknown')");await assert.rejects(upgradeDelivery(pool),/ledger mismatch/);
  await pool.query("DELETE FROM gas_email_upgrade_ledger WHERE upgrade_id='004_unknown'");
  await pool.query("INSERT INTO gas_email_instances VALUES('f1-test','f1-owner','f1-client','f1-project','midnight.project.mp@gmail.com','midnightprojectantigravity@gmail.com',true,'reviewed:text-only:v1')");
  const claims={sub:'f1-owner',aud:'f1-client',iss:'https://accounts.google.com',exp:4102444800};
  const rpc=async(operation,input={})=>{const c=await pool.connect();try{await c.query('BEGIN');await c.query("SELECT set_config('request.jwt.claims',$1,true)",[JSON.stringify(claims)]);await c.query('SET LOCAL ROLE authenticated');const r=(await c.query('SELECT gas_email_rpc($1,$2,$3::jsonb) AS result',['f1-test',operation,JSON.stringify(input)])).rows[0].result;await c.query('COMMIT');return r;}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}};
  const message=id=>({id,threadId:'f1thread',from:'midnightprojectantigravity@gmail.com',to:'midnight.project.mp@gmail.com',reference:`<${id}@example.com>`,subject:'Task',body:'Requirement '+id});
  assert.equal((await rpc('ingest',message('a'))).status,'inserted');
  const captured=await rpc('claim');assert.equal(captured.status,'claimed');
  assert.equal((await rpc('ingest',message('b'))).status,'inserted');
  assert.equal((await rpc('failure',{execution_id:captured.execution_id,fence:captured.fence})).status,'settled');
  assert.equal((await pool.query('SELECT failed_through_seq::int AS n FROM vnext_pilot_progress')).rows[0].n,1);
  const recovery=await rpc('claim');assert.equal(recovery.status,'claimed');
  assert.deepEqual(recovery.inputs.map(x=>x.message),['Requirement a','Requirement b']);
 }finally{if(process.env.TEST_DATABASE_URL)await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');await pool.end();}
});

test('an exact 002-004 prefix applies only the next migration and preserves historical ledger rows',async()=>{
 const pool=await testPool();try{
  await bootstrap(pool,{apply:true});
  await pool.query('CREATE TABLE gas_email_upgrade_ledger(upgrade_id text PRIMARY KEY,sha256 text NOT NULL,applied_at timestamptz NOT NULL DEFAULT clock_timestamp()); REVOKE ALL ON gas_email_upgrade_ledger FROM PUBLIC,authenticated,anonymous');
  for(const id of ['002_delivery_provider_receipts','003_model_diagnostics','004_failure_watermark_snapshot']){
   const sql=(await readFile(new URL(`../deploy/gas-email/${id}.sql`,import.meta.url),'utf8')).replace(/\r\n/g,'\n');
   await pool.query(sql);
   await pool.query('INSERT INTO gas_email_upgrade_ledger(upgrade_id,sha256) VALUES($1,$2)',[id,createHash('sha256').update(sql).digest('hex')]);
  }
  const original=(await pool.query('SELECT * FROM gas_email_upgrade_ledger ORDER BY upgrade_id')).rows;
  const inspect=await upgradeDelivery(pool);
  assert.equal(inspect.status,'upgrade-ready');assert.deepEqual(inspect.pending,['005_failure_recovery_boundary','006_settlement_receipts']);
  assert.equal((await upgradeDelivery(pool,{apply:true})).status,'applied');
  const after=(await pool.query('SELECT * FROM gas_email_upgrade_ledger ORDER BY upgrade_id')).rows;
  assert.deepEqual(after.slice(0,3),original);
  assert.equal(after.length,5);assert.equal(after[4].upgrade_id,'006_settlement_receipts');
  assert.equal((await upgradeDelivery(pool)).status,'already-applied');
 }finally{if(process.env.TEST_DATABASE_URL)await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');await pool.end();}
});

test('historically applied 003 checksum is immutable and read-only inspection accepts it, rejects divergence',async()=>{
 const hash='5a8a7d3c5cd5440190ce799e7cb15a2be2f72c14826269a219396ac05a09b818';
 const sql=(await readFile(new URL('../deploy/gas-email/003_model_diagnostics.sql',import.meta.url),'utf8')).replace(/\r\n/g,'\n');
 assert.equal(createHash('sha256').update(sql).digest('hex'),hash);
 const pool=await testPool();try{
  await bootstrap(pool,{apply:true});await upgradeDelivery(pool,{apply:true});
  // Model the historical ledger explicitly, rather than deriving its expected hash from today's file.
  await pool.query("UPDATE gas_email_upgrade_ledger SET sha256=$1 WHERE upgrade_id='003_model_diagnostics'",[hash]);
  const queries=[],wrapped={connect:async()=>{const c=await pool.connect();return {release:()=>c.release(),query:(q,a)=>{queries.push(q);return c.query(q,a);}};}};
  assert.equal((await upgradeDelivery(wrapped)).status,'already-applied');
  assert.equal(queries.at(-1),'ROLLBACK');assert.ok(queries.every(q=>!/^\s*(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|COMMIT)\b/i.test(q)));
  await pool.query("UPDATE gas_email_upgrade_ledger SET sha256='8ff3e75d6935f3572bfe124b0a014403d67aa75f29b1b6a5fe306d3d6f0b5353' WHERE upgrade_id='003_model_diagnostics'");
  await assert.rejects(upgradeDelivery(wrapped),/ledger mismatch/);
 }finally{if(process.env.TEST_DATABASE_URL)await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');await pool.end();}
});

test('forward delivery upgrade rolls back failures; historical repair remains inspect-only',{timeout:120000},async()=>{
 const pool=await testPool();try{
  await bootstrap(pool,{apply:true});
  const original=(await pool.query('SELECT * FROM gas_email_bootstrap_ledger')).rows;
  assert.equal((await upgradeDelivery(pool)).status,'upgrade-ready');
  await pool.query('ALTER TABLE gas_email_outbox ADD COLUMN provider_receipt text');
  await assert.rejects(upgradeDelivery(pool,{apply:true}));
  assert.equal((await pool.query("SELECT to_regclass('gas_email_upgrade_ledger') IS NULL AS absent")).rows[0].absent,true);
  assert.deepEqual((await pool.query('SELECT * FROM gas_email_bootstrap_ledger')).rows,original);
  await pool.query('ALTER TABLE gas_email_outbox DROP COLUMN provider_receipt');
  assert.equal((await upgradeDelivery(pool,{apply:true})).status,'applied');
  assert.equal((await upgradeDelivery(pool,{apply:true})).status,'already-applied');
  assert.deepEqual((await pool.query('SELECT * FROM gas_email_bootstrap_ledger')).rows,original);
  assert.equal((await bootstrap(pool)).status,'already-applied');
  await pool.query("INSERT INTO gas_email_instances VALUES($1,'owner','client',$2,'midnight.project.mp@gmail.com','midnightprojectantigravity@gmail.com',true,'user-authorized:pr69:gas-text-only:v1')",[REPAIR.instance,REPAIR.project]);
  const e={id:REPAIR.thread,threadId:REPAIR.thread,from:'midnightprojectantigravity@gmail.com',to:'midnight.project.mp@gmail.com',reference:'<>',subject:'12345678',body:'éé'+'b'.repeat(291),messageId:`<${REPAIR.execution}@ct-runtime.invalid>`};
  e.reference='<'+ 'r'.repeat(630-JSON.stringify(e).length) +'>';
  assert.equal(JSON.stringify(e).length,630);assert.equal(Buffer.byteLength(JSON.stringify(e)),632);
  const work=REPAIR.work;
  await pool.query("INSERT INTO vnext_work_units(work_unit_id,objective_ref,state,project_id,fence) VALUES($1,'gmail:test','review',$2,1)",[work,REPAIR.project]);
  await pool.query('INSERT INTO gas_email_threads VALUES($1,$2,$3)',[work,REPAIR.instance,REPAIR.thread]);
  await pool.query('INSERT INTO vnext_pilot_progress(work_unit_id) VALUES($1)',[work]);
  await pool.query("INSERT INTO vnext_pilot_inputs(receipt_id,work_unit_id,message) VALUES('repair-input',$1,'test')",[work]);
  await pool.query('INSERT INTO gas_email_receipts VALUES($1,$2,1,$3)',[REPAIR.instance,REPAIR.thread,JSON.stringify(e)]);
  await pool.query("INSERT INTO vnext_executions(execution_id,work_unit_id,project_id,owner,fence,state,started_at,finished_at,authorization_decision_ref) VALUES($1,$2,$3,$4,1,'succeeded',clock_timestamp(),clock_timestamp(),'user-authorized:pr69:gas-text-only:v1')",[REPAIR.execution,work,REPAIR.project,REPAIR.instance]);
  await pool.query('INSERT INTO gas_email_turns VALUES($1,1,$2)',[REPAIR.execution,REPAIR.instance]);
  await pool.query("INSERT INTO gas_email_outbox(execution_id,instance_id,work_unit_id,input_seq,envelope,state) VALUES($1,$2,$3,1,$4,'admitted')",[REPAIR.execution,REPAIR.instance,work,JSON.stringify(e)]);
  await pool.query("INSERT INTO vnext_project_reconciliation_blocks(project_id,work_unit_id,execution_id,fence,reason) VALUES($1,$2,$3,1,'external-effect-uncertain')",[REPAIR.project,work,REPAIR.execution]);
  const inspect=await repairDelivery(pool);assert.equal(inspect.status,'repair-ready');
  assert.equal(inspect.evidence.automaticIdentityVerified,false);
  for(const options of [{apply:true},{apply:true,expectedSnapshot:inspect.snapshot},{apply:true,deploymentAttestation:'https://github.com/MidnightProject-MP/CT-Runtime/actions/runs/123456789',expectedSnapshot:'wrong'}])await assert.rejects(repairDelivery(pool,options));
  await pool.query("UPDATE gas_email_outbox SET envelope=jsonb_set(envelope,'{subject}','\"87654321\"')");
  await assert.rejects(repairDelivery(pool,{apply:true,deploymentAttestation:'https://github.com/MidnightProject-MP/CT-Runtime/actions/runs/123456789',expectedSnapshot:inspect.snapshot}));
  await pool.query('UPDATE gas_email_outbox SET envelope=$1',[JSON.stringify(e)]);
  await pool.query("UPDATE gas_email_outbox SET provider_receipt='unreviewed'");await assert.rejects(repairDelivery(pool));
  await pool.query('UPDATE gas_email_outbox SET provider_receipt=NULL');
   // No historical mutable path is supported without independent exact-artifact
   // binding. Assert the gate before database writes, rather than spoof approval.
   const queries=[],guarded={connect:async()=>{const c=await pool.connect();return {release:()=>c.release(),query:(q,a)=>{queries.push(q);assert.doesNotMatch(q,/^\s*(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|COMMIT)\b/i);return c.query(q,a);}};}};
   await assert.rejects(repairDelivery(guarded,{apply:true,deploymentAttestation:'https://github.com/MidnightProject-MP/CT-Runtime/actions/runs/123456789',expectedSnapshot:inspect.snapshot}),/independent exact-artifact deployment binding required; mutation disabled/);
   assert.equal(queries.at(-1),'ROLLBACK');
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM vnext_events WHERE event_type='gas-email-owner-delivery-repair'")).rows[0].n,0);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM vnext_project_reconciliation_blocks')).rows[0].n,1);
   assert.equal((await repairDelivery(pool)).status,'repair-ready');
   assert.deepEqual((await pool.query('SELECT state,gmail_id,provider_receipt FROM gas_email_outbox')).rows,[{state:'admitted',gmail_id:null,provider_receipt:null}]);
  await pool.query("UPDATE gas_email_upgrade_ledger SET sha256='changed'");await assert.rejects(upgradeDelivery(pool),/ledger mismatch/);
 }finally{await pool.end();}
});
