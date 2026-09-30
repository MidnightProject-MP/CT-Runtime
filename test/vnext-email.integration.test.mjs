import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID,createHash } from 'node:crypto';
import { mkdtemp,writeFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { testPool } from './pilot-test-pool.mjs';
import { migrateVNext } from '../lib/vnext/migration.mjs';
import { createEmailPilot } from '../lib/vnext/email-pilot.mjs';
import { createPilotStore } from '../lib/vnext/pilot-store.mjs';
import { createGmailTransport } from '../lib/vnext/gmail-transport.mjs';
import { runPilotOnce } from '../lib/vnext/pilot.mjs';
import { bridgeFixture } from './email-bridge-fixture.mjs';

test('email intake → durable execution → fenced reply, retries and thread continuity',{timeout:60000},async()=>{
  const pool=await testPool(),dir=await mkdtemp(path.join(tmpdir(),'email-proof-'));
  const fixture=bridgeFixture(),transport=createGmailTransport({url:'https://example.test/exec',secret:'test-secret',fetch:fixture.fetch});
  const projectId='email-'+randomUUID(),mailboxId='test-mailbox';
  const config={pool,mailboxId,projectId,allowedSender:'human@example.com',mailboxAddress:'bot@example.com',labelName:'CT-Runtime'};
  const authority={authorizeExecution:async({execution})=>({ref:'test:'+execution.execution_id}),verifyExecution:async(d,{execution})=>d.ref==='test:'+execution.execution_id,authorizeTerminal:async()=>true};
  const store=createPilotStore({pool,authorizationVerifier:authority.verifyExecution});
  const run=executor=>runPilotOnce({store,projectId,workspaceRoot:dir,identityFiles:[path.join(dir,'identity.md')],authority,executor});
  const waiting=w=>({objective_id:w.objective_ref,disposition:'waiting',summary:'Checked; waiting for your choice.',continuation:{mode:'condition',condition:{kind:'human',condition:'Human replies.'}}});
  try {
    await pool.query("DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF; IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anonymous') THEN CREATE ROLE anonymous; END IF; END $$");
    await migrateVNext({pool,directory:fileURLToPath(new URL('../vnext-migrations',import.meta.url))});
    await writeFile(path.join(dir,'identity.md'),'Reconstruct, execute and check.');
    const email=createEmailPilot(config);fixture.add('m1');
    // Crash after pilot submission but before email receipt INSERT.
    const interrupted=createEmailPilot({...config,pool:{connect:()=>pool.connect(),query:async(sql,args)=>{if(sql.startsWith('INSERT INTO vnext_email_receipts'))throw new Error('injected crash');return pool.query(sql,args);}}});
    await assert.rejects(interrupted.poll(transport),/injected crash/);
    assert.ok(fixture.messages.get('m1').labelIds.includes('queue'));
    assert.equal((await email.poll(transport)).received,1);
    const work=(await store.status(projectId))[0];assert.equal(Number(work.latest_input_seq),1);
    assert.equal((await email.poll(transport)).received,0);
    const first=await run(async({workUnit})=>waiting(workUnit));assert.equal(first.disposition,'waiting');
    fixture.loseNextSend();fixture.hideSearch();
    assert.equal((await email.poll(transport)).uncertain,1);assert.equal(fixture.sends,1);
    assert.equal((await email.poll(transport)).uncertain,1);assert.equal(fixture.sends,1);
    fixture.showSearch();assert.equal((await email.poll(transport)).sent,1);assert.equal(fixture.sends,1);
    assert.equal((await email.poll(transport)).sent,0);
    // Follow-up reuses the same objective; newer input during execution must
    // not change the reply's provenance or disappear at completion.
    fixture.add('m2');await email.poll(transport);
    await writeFile(path.join(dir,'proof.txt'),'verified');
    const second=await run(async({workUnit})=>{
      assert.equal(workUnit.work_unit_id,work.work_unit_id);
      fixture.add('m3');await email.poll(transport);
      return {objective_id:workUnit.objective_ref,disposition:'done',summary:'Verified requested work.',outcome_evidence:[{kind:'file',path:'proof.txt',sha256:createHash('sha256').update('verified').digest('hex')}]};
    });
    await email.queueResults();
    const out=(await pool.query('SELECT * FROM vnext_email_outbox WHERE outbox_id=$1',['reply-'+second.execution_id])).rows[0];
    assert.equal(out.in_reply_to,'m2');assert.equal(out.to_address,'human@example.com');
    assert.equal(await store.nextEligible(projectId),work.work_unit_id);
    await email.deliver(transport);assert.equal(fixture.sends,2);
    await run(async({workUnit})=>waiting(workUnit));await email.poll(transport);assert.equal(fixture.sends,3);
    assert.equal((await run(()=>{throw new Error('must not execute');})).disposition,'quiesced');
    fixture.add('m4','t2');await email.poll(transport);assert.equal((await store.status(projectId)).length,2);
    await assert.rejects(email.ingest({id:'m4',threadId:'t2',from:'human@example.com',to:'bot@example.com',subject:'Check',body:'Changed content'}),/conflict/);
  } finally {await pool.end();await rm(dir,{recursive:true,force:true});}
});

test('bridge authentication, sender/recipient checks, immutable send identity and queue bounds',async()=>{
  const f=bridgeFixture(),transport=createGmailTransport({url:'https://example.test',secret:'test-secret',fetch:f.fetch});
  f.add('m1');
  const payload={mailboxId:'test-mailbox'};
  assert.equal((await transport('email-poll',payload)).messages.length,1);
  const bad=createGmailTransport({url:'https://example.test',secret:'wrong',fetch:f.fetch});await assert.rejects(bad('email-poll',payload));
  f.values.CT_EMAIL_ALLOWED_SENDER='';await assert.rejects(transport('email-poll',payload));f.values.CT_EMAIL_ALLOWED_SENDER='human@example.com';
  f.add('bad','t1','x','human@example.com.attacker.test');await assert.rejects(transport('email-poll',payload));f.messages.delete('bad');
  const reply={...payload,key:'reply-test',threadId:'t1',inReplyTo:'m1',to:'human@example.com',subject:'Check',body:'Checked.'};
  await assert.rejects(transport('email-send',{...reply,to:'other@example.com'}));assert.equal(f.sends,0);
  await transport('email-send',reply);await transport('email-send',reply);assert.equal(f.sends,1);
  await assert.rejects(transport('email-send',{...reply,body:'Changed.'}));assert.equal(f.sends,1);
  for(let i=2;i<=15;i++)f.add('m'+i);
  let count=0;
  for(let i=0;i<2;i++){const batch=await transport('email-poll',payload);count+=batch.messages.length;for(const m of batch.messages)await transport('email-ack',{...payload,messageId:m.id});}
  assert.equal(count,15);assert.equal((await transport('email-poll',payload)).messages.length,0);
});
