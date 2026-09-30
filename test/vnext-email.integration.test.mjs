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
import { createWorkUnit, createExecution as createExecutionCore, claimWorkUnit, startExecution, failExecution } from '../lib/vnext/kernel.mjs';
import { bridgeFixture } from './email-bridge-fixture.mjs';

async function within(promise, label) {
  let timer;
  try {
    return await Promise.race([promise,new Promise((_,reject)=>{
      timer=setTimeout(()=>reject(new Error(`Timed out waiting for ${label}`)),10000);
    })]);
  } finally { clearTimeout(timer); }
}

test('email intake → durable execution → fenced reply, retries and thread continuity',{timeout:60000},async()=>{
  const pool=await testPool(),dir=await mkdtemp(path.join(tmpdir(),'email-proof-'));
  const fixture=bridgeFixture(),transport=createGmailTransport({url:'https://example.test/exec',secret:'test-secret',fetch:fixture.fetch});
  const projectId='email-'+randomUUID(),mailboxId='test-mailbox';
  fixture.values.CT_EMAIL_MAILBOX_ID=mailboxId;
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

 
test('reconciliation blocks Gmail delivery at the durable admission boundary and explicit reconciliation restores it',{timeout:60000},async()=>{
  const pool=await testPool(),dir=await mkdtemp(path.join(tmpdir(),'email-reconcile-'));
  const fixture=bridgeFixture(),transport=createGmailTransport({url:'https://example.test/exec',secret:'test-secret',fetch:fixture.fetch});
  const projectId='email-reconcile-'+randomUUID(),mailboxId='reconcile-mailbox';
  fixture.values.CT_EMAIL_MAILBOX_ID=mailboxId;
  const config={pool,mailboxId,projectId,allowedSender:'human@example.com',mailboxAddress:'bot@example.com',labelName:'CT-Runtime'};
  const authority={authorizeExecution:async({execution})=>({ref:'test:'+execution.execution_id}),verifyExecution:async(d,{execution})=>d.ref==='test:'+execution.execution_id,authorizeTerminal:async()=>true};
  const store=createPilotStore({pool,authorizationVerifier:authority.verifyExecution});
  const run=executor=>runPilotOnce({store,projectId,workspaceRoot:dir,identityFiles:[path.join(dir,'identity.md')],authority,executor});
  try {
    await pool.query("DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF; IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anonymous') THEN CREATE ROLE anonymous; END IF; END $$");
    await migrateVNext({pool,directory:fileURLToPath(new URL('../vnext-migrations',import.meta.url))});
    await writeFile(path.join(dir,'identity.md'),'Reconstruct, execute and check.');
    const email=createEmailPilot(config);
    await email.configure();
    fixture.add('r1');
    await email.poll(transport);
    await run(async({workUnit})=>({objective_id:workUnit.objective_ref,disposition:'waiting',summary:'Prepared a reply.',continuation:{mode:'condition',condition:{kind:'human',condition:'Reply arrives.'}}}));
    await email.queueResults();
    const outboxBefore=(await pool.query("SELECT state,attempt FROM vnext_email_outbox WHERE mailbox_id=$1",[mailboxId])).rows[0];
    assert.deepEqual(outboxBefore,{state:'pending',attempt:0});

    await email.ingest({id:'r2',threadId:'r1-thread',from:'human@example.com',to:'bot@example.com',subject:'Re: Check',body:'Second request'});
    await assert.rejects(
      () => run(async()=>{ throw new Error('simulated external uncertainty'); }),
      /simulated external uncertainty/,
    );
    const block=(await pool.query("SELECT project_id,work_unit_id,execution_id,fence FROM vnext_project_reconciliation_blocks WHERE project_id=$1",[projectId])).rows[0];
    assert.ok(block);

    const blocked=await email.deliver(transport);
    assert.equal(blocked.sent,0);
    assert.equal(blocked.blocked,1);
    assert.equal(fixture.sends,0);
    assert.deepEqual((await pool.query("SELECT state,attempt,provider_message_id FROM vnext_email_outbox WHERE mailbox_id=$1",[mailboxId])).rows[0],{state:'pending',attempt:0,provider_message_id:null});

    const reconciled=await store.reconcileFailure({
      projectId,
      workUnitId:block.work_unit_id,
      executionId:block.execution_id,
      fence:Number(block.fence),
      resolution:'no_effect',
    });
    assert.equal(reconciled.state,'actionable');
    assert.equal((await pool.query("SELECT count(*)::int AS count FROM vnext_project_reconciliation_blocks WHERE project_id=$1",[projectId])).rows[0].count,0);

    const delivered=await email.deliver(transport);
    assert.equal(delivered.sent,1);
    assert.equal(delivered.blocked,0);
    assert.equal(fixture.sends,1);
    assert.deepEqual((await pool.query("SELECT state,attempt FROM vnext_email_outbox WHERE mailbox_id=$1",[mailboxId])).rows[0],{state:'sent',attempt:1});
  } finally { await pool.end(); await rm(dir,{recursive:true,force:true}); }
});


test('reconciliation-first ordering blocks Gmail admission without sending',{timeout:60000,skip:!process.env.TEST_DATABASE_URL},async()=>{
  const pool=await testPool(),dir=await mkdtemp(path.join(tmpdir(),'email-admission-block-first-'));
  const suffix=randomUUID(),projectId='email-block-first-'+suffix,mailboxId='block-first-mailbox-'+suffix;
  const store=createPilotStore({pool,authorizationVerifier:async()=>true});
  let admission;
  try {
    await pool.query("DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF; IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anonymous') THEN CREATE ROLE anonymous; END IF; END $$");
    await migrateVNext({pool,directory:fileURLToPath(new URL('../vnext-migrations',import.meta.url))});
    const email=createEmailPilot({pool,mailboxId,projectId,allowedSender:'human@example.com',mailboxAddress:'bot@example.com',labelName:'CT-Runtime'});
    await email.configure();
    await pool.query("INSERT INTO vnext_email_outbox(outbox_id,mailbox_id,to_address,subject,body) VALUES ($1,$2,$3,$4,$5)",['block-first-outbox',mailboxId,'human@example.com','Re: Check','Checked.']);
    const raceWork=createWorkUnit({workUnitId:'block-first-work-'+suffix,objectiveRef:'block-first-objective-'+suffix,projectId});
    await pool.query("INSERT INTO vnext_work_units(work_unit_id,objective_ref,project_id,state,fence,created_at,updated_at) VALUES ($1,$2,$3,'actionable',0,clock_timestamp(),clock_timestamp())",[raceWork.work_unit_id,raceWork.objective_ref,projectId]);
    const raceClaim=claimWorkUnit(raceWork,{executionId:'block-first-execution-'+suffix,owner:'block-first-owner'});
    const raceExecution=startExecution(createExecutionCore(raceClaim,{executionId:'block-first-execution-'+suffix,owner:'block-first-owner',authorizationDecisionRef:'test-auth:block-first-'+suffix}));
    await store.beginExecution(raceClaim,raceExecution);

    const holder=await pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['ct-runtime:vnext-project:'+projectId]);
      admission=email.deliver(async()=>{assert.fail('blocked admission must not call transport');});
      admission.catch(()=>{});
      await holder.query(
        "INSERT INTO vnext_project_reconciliation_blocks(project_id,work_unit_id,execution_id,fence,reason) VALUES ($1,$2,$3,$4,'external-effect-uncertain')",
        [projectId,raceWork.work_unit_id,raceExecution.execution_id,1],
      );
      await holder.query('COMMIT');
      const result=await within(admission,'blocked admission');
      assert.equal(result.sent,0);
      assert.equal(result.blocked,1);
      assert.deepEqual((await pool.query("SELECT state,attempt FROM vnext_email_outbox WHERE outbox_id='block-first-outbox'")).rows[0],{state:'pending',attempt:0});
      assert.equal((await pool.query("SELECT count(*)::int AS count FROM vnext_project_reconciliation_blocks WHERE project_id=$1",[projectId])).rows[0].count,1);
    } finally {
      await holder.query('ROLLBACK').catch(()=>{});
      holder.release();
      await Promise.allSettled([admission]);
    }
  } finally { await pool.end(); await rm(dir,{recursive:true,force:true}); }
});

test('delivery-first ordering commits uncertain admission before reconciliation crosses the boundary',{timeout:60000,skip:!process.env.TEST_DATABASE_URL},async()=>{
  const basePool=await testPool(),dir=await mkdtemp(path.join(tmpdir(),'email-admission-delivery-first-'));
  const suffix=randomUUID(),projectId='email-delivery-first-'+suffix,mailboxId='delivery-first-mailbox-'+suffix;
  let admissionLockAcquiredResolve,admissionLockRelease;
  const admissionLockAcquired=new Promise(resolve=>{admissionLockAcquiredResolve=resolve;});
  const admissionRelease=new Promise(resolve=>{admissionLockRelease=resolve;});
  let admissionClient=null,admissionCommitResolve,secondLockRequestedResolve;
  const admissionCommitted=new Promise(resolve=>{admissionCommitResolve=resolve;});
  const secondLockRequested=new Promise(resolve=>{secondLockRequestedResolve=resolve;});
  let lockCount=0;
  let instrumentLocks=false,transportRelease;
  const operations=[];
  const track=promise=>{operations.push(promise);promise.catch(()=>{});return promise;};
  const instrumentedPool=new Proxy(basePool,{
    get(target,property){
      if(property==='connect') return async()=>{
        const raw=await target.connect();
        return new Proxy(raw,{
          get(clientTarget,clientProperty){
            if(clientProperty!=='query') {
              const value=Reflect.get(clientTarget,clientProperty);
              return typeof value==='function'?value.bind(clientTarget):value;
            }
            return async(sql,args)=>{
              const text=String(sql);
              const isProjectLock=instrumentLocks && text.replace(/\s+/g,'').includes('pg_advisory_xact_lock(hashtextextended($1,0))') && args?.[0]===('ct-runtime:vnext-project:'+projectId);
              if(isProjectLock){
                lockCount++;
                if(lockCount===1){
                  admissionClient=clientTarget;
                  const result=await clientTarget.query(sql,args);
                  admissionLockAcquiredResolve();
                  await admissionRelease;
                  return result;
                }
                if(lockCount===2){
                  secondLockRequestedResolve();
                  return clientTarget.query(sql,args);
                }
              }
              if(clientTarget===admissionClient && /^\s*COMMIT\s*;?\s*$/i.test(text)){
                const result=await clientTarget.query(sql,args);
                admissionCommitResolve();
                return result;
              }
              return clientTarget.query(sql,args);
            };
          },
        });
      };
      const value=Reflect.get(target,property);
      return typeof value==='function'?value.bind(target):value;
    },
  });
  const store=createPilotStore({pool:instrumentedPool,authorizationVerifier:async()=>true});
  try {
    await basePool.query("DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF; IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anonymous') THEN CREATE ROLE anonymous; END IF; END $$");
    await migrateVNext({pool:basePool,directory:fileURLToPath(new URL('../vnext-migrations',import.meta.url))});
    const setupEmail=createEmailPilot({pool:basePool,mailboxId,projectId,allowedSender:'human@example.com',mailboxAddress:'bot@example.com',labelName:'CT-Runtime'});
    await setupEmail.configure();
    await basePool.query("INSERT INTO vnext_email_outbox(outbox_id,mailbox_id,to_address,subject,body) VALUES ($1,$2,$3,$4,$5)",['delivery-first-outbox',mailboxId,'human@example.com','Re: Check','Checked.']);

    const failedWork=createWorkUnit({workUnitId:'delivery-first-work-'+suffix,objectiveRef:'delivery-first-objective-'+suffix,projectId});
    await basePool.query("INSERT INTO vnext_work_units(work_unit_id,objective_ref,project_id,state,fence,created_at,updated_at) VALUES ($1,$2,$3,'actionable',0,clock_timestamp(),clock_timestamp())",[failedWork.work_unit_id,failedWork.objective_ref,projectId]);
    const failedClaim=claimWorkUnit(failedWork,{executionId:'delivery-first-execution-'+suffix,owner:'delivery-first-owner'});
    const failedExecution=startExecution(createExecutionCore(failedClaim,{executionId:'delivery-first-execution-'+suffix,owner:'delivery-first-owner',authorizationDecisionRef:'test-auth:delivery-first-'+suffix}));
    const begun=await store.beginExecution(failedClaim,failedExecution);
    const failed=failExecution(begun.workUnit,begun.execution,{failure:{message:'simulated external uncertainty'},reconciliationRequired:true,maxAttempts:1});

    const email=createEmailPilot({pool:instrumentedPool,mailboxId,projectId,allowedSender:'human@example.com',mailboxAddress:'bot@example.com',labelName:'CT-Runtime'});
    let transportCalls=0,transportCalledResolve;
    const transportCalled=new Promise(resolve=>{transportCalledResolve=resolve;});
    const transportReady=new Promise(resolve=>{transportRelease=resolve;});
    const transport=async()=>{transportCalls++;transportCalledResolve();await transportReady;return {status:'sent',messageId:'delivery-first-message'};};

    // Arm only after setup: beginExecution also takes the project lock.
    instrumentLocks=true;
    const delivery=track(email.deliver(transport));
    await within(admissionLockAcquired,'admission lock');

    const reconciliation=track(store.persistFailure(failed));
    await within(secondLockRequested,'reconciliation lock request');
    assert.deepEqual((await basePool.query("SELECT state,attempt FROM vnext_email_outbox WHERE outbox_id='delivery-first-outbox'")).rows[0],{state:'pending',attempt:0});
    assert.equal((await basePool.query("SELECT count(*)::int AS count FROM vnext_project_reconciliation_blocks WHERE project_id=$1",[projectId])).rows[0].count,0);

    admissionLockRelease();
    await within(admissionCommitted,'admission commit');
    assert.deepEqual((await basePool.query("SELECT state,attempt FROM vnext_email_outbox WHERE outbox_id='delivery-first-outbox'")).rows[0],{state:'uncertain',attempt:1});
    await within(transportCalled,'transport call');
    assert.equal(transportCalls,1);

    await within(reconciliation,'reconciliation');
    assert.equal((await basePool.query("SELECT count(*)::int AS count FROM vnext_project_reconciliation_blocks WHERE project_id=$1",[projectId])).rows[0].count,1);
    assert.deepEqual((await basePool.query("SELECT state,attempt FROM vnext_email_outbox WHERE outbox_id='delivery-first-outbox'")).rows[0],{state:'uncertain',attempt:1});

    transportRelease();
    const result=await within(delivery,'delivery');
    assert.deepEqual(result,{sent:1,uncertain:0,blocked:0});
    assert.equal(transportCalls,1);
    assert.deepEqual((await basePool.query("SELECT state,attempt,provider_message_id FROM vnext_email_outbox WHERE outbox_id='delivery-first-outbox'")).rows[0],{state:'sent',attempt:1,provider_message_id:'delivery-first-message'});
  } finally {
    // Release JS barriers before draining operations/pool, including on assertion
    // failure. Otherwise an open transaction can keep CI alive after timeout.
    admissionLockRelease();
    transportRelease?.();
    await Promise.allSettled(operations);
    await basePool.end();
    await rm(dir,{recursive:true,force:true});
  }
});
