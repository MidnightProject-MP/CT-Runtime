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
  assert.deepEqual((await upgradeDelivery(pool)).pending,['003_model_diagnostics']);
  assert.equal((await upgradeDelivery(pool,{apply:true})).status,'applied');
  assert.deepEqual((await pool.query("SELECT * FROM gas_email_upgrade_ledger WHERE upgrade_id='002_delivery_provider_receipts'")).rows[0],original);
  await pool.query("INSERT INTO gas_email_upgrade_ledger(upgrade_id,sha256) VALUES('004_unknown','unknown')");await assert.rejects(upgradeDelivery(pool),/ledger mismatch/);
 }finally{if(process.env.TEST_DATABASE_URL)await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');await pool.end();}
});

test('forward delivery upgrade preserves bootstrap and scoped owner repair is atomic and evidence-bound',{timeout:120000},async()=>{
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
  for(const options of [{apply:true},{apply:true,expectedSnapshot:inspect.snapshot},{apply:true,deployed:true,expectedSnapshot:'wrong'}])await assert.rejects(repairDelivery(pool,options));
  await pool.query("UPDATE gas_email_outbox SET envelope=jsonb_set(envelope,'{subject}','\"87654321\"')");
  await assert.rejects(repairDelivery(pool,{apply:true,deployed:true,expectedSnapshot:inspect.snapshot}));
  await pool.query('UPDATE gas_email_outbox SET envelope=$1',[JSON.stringify(e)]);
  await pool.query("UPDATE gas_email_outbox SET provider_receipt='unreviewed'");await assert.rejects(repairDelivery(pool));
  await pool.query('UPDATE gas_email_outbox SET provider_receipt=NULL');
  await pool.query("CREATE FUNCTION reject_repair_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected repair failure'; END $$; REVOKE ALL ON FUNCTION reject_repair_test() FROM PUBLIC,authenticated,anonymous; CREATE TRIGGER reject_repair_test BEFORE UPDATE ON gas_email_outbox FOR EACH ROW EXECUTE FUNCTION reject_repair_test()");
  await assert.rejects(repairDelivery(pool,{apply:true,deployed:true,expectedSnapshot:inspect.snapshot}),/injected/);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM vnext_events WHERE event_type='gas-email-owner-delivery-repair'")).rows[0].n,0);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM vnext_project_reconciliation_blocks')).rows[0].n,1);
  await pool.query('DROP TRIGGER reject_repair_test ON gas_email_outbox; DROP FUNCTION reject_repair_test()');
  assert.equal((await repairDelivery(pool,{apply:true,deployed:true,expectedSnapshot:inspect.snapshot})).status,'repaired');
  assert.equal((await repairDelivery(pool,{apply:true,deployed:true,expectedSnapshot:inspect.snapshot})).status,'already-resolved');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM vnext_project_reconciliation_blocks')).rows[0].n,0);
  assert.deepEqual((await pool.query('SELECT state,gmail_id,provider_receipt FROM gas_email_outbox')).rows,[{state:'sent',gmail_id:REPAIR.gmailId,provider_receipt:null}]);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM vnext_events WHERE event_type='gas-email-owner-delivery-repair'")).rows[0].n,1);
  await assert.rejects(pool.query("DELETE FROM vnext_events WHERE event_type='gas-email-owner-delivery-repair'"),/immutable/);
  await assert.rejects(pool.query("UPDATE vnext_events SET payload='{}' WHERE event_type='gas-email-owner-delivery-repair'"),/immutable/);
  await pool.query("UPDATE gas_email_upgrade_ledger SET sha256='changed'");await assert.rejects(upgradeDelivery(pool),/ledger mismatch/);
 }finally{await pool.end();}
});
