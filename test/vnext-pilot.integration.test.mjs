import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { testPool } from './pilot-test-pool.mjs';
import { migrateVNext } from '../lib/vnext/migration.mjs';
import { createPilotStore } from '../lib/vnext/pilot-store.mjs';
import { runPilotOnce } from '../lib/vnext/pilot.mjs';

const authority = {
  authorizeExecution: async ({execution}) => ({ref:`test:${execution.execution_id}`}),
  verifyExecution: async (d,{execution}) => d.ref === `test:${execution.execution_id}`,
  authorizeTerminal: async () => true,
};
const next = objective_id => ({objective_id,disposition:'continue',summary:'Verified one useful change.',learned:'Keep the useful observation.',continuation:{mode:'immediate',next_action:'Check next consequence.'}});

test('pilot durable input, fresh wakes, evidence, waits, rollback, and uncertainty', {timeout:60000}, async t => {
  const pool = await testPool();
  const dir = await mkdtemp(path.join(tmpdir(),'pilot-'));
  await writeFile(path.join(dir,'identity.md'),'Celestan: reconstruct, do, check, persist.');
  await pool.query("DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF; IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anonymous') THEN CREATE ROLE anonymous; END IF; END $$");
  await migrateVNext({pool,directory:path.join(import.meta.dirname,'../vnext-migrations')});
  const store = () => createPilotStore({pool,authorizationVerifier:authority.verifyExecution,intervalMs:1000});
  const projectId = `pilot-test-${randomUUID()}`;
  let n=0;
  const input = (s,thread,message='Improve one concrete thing.') => s.submit({projectId,threadId:thread,receiptId:`receipt-${++n}`,message});
  const run = (s,executor) => runPilotOnce({store:s,projectId,workspaceRoot:dir,identityFiles:[path.join(dir,'identity.md')],authority,executor});
  try {
    await t.test('idempotent receipt and conflicting content', async () => {
      const s=store();const args={projectId,threadId:'first',receiptId:'fixed-'+projectId,message:'Improve it.'};
      const a=await s.submit(args);assert.equal((await s.submit(args)).created,false);
      await assert.rejects(s.submit({...args,message:'Changed'}),/conflict/);
      assert.equal((await s.status(projectId)).length,1);
      const result=await run(s,async ({workUnit,identity})=>{assert.match(identity[0].text,/Celestan/);return next(workUnit.objective_ref);});
      assert.equal(result.disposition,'continue');
      const saved=await pool.query('SELECT * FROM vnext_pilot_results WHERE execution_id=$1',[result.execution_id]);
      assert.equal(saved.rows[0].turn.learned,'Keep the useful observation.');
      assert.equal(await store().nextEligible(projectId),null);
      await pool.query("UPDATE vnext_pilot_progress SET next_wake_at=clock_timestamp()-interval '1 second' WHERE work_unit_id=$1",[a.work_unit_id]);
      await writeFile(path.join(dir,'proof.txt'),'verified result');
      const hash=createHash('sha256').update('verified result').digest('hex');
      const terminal=await run(store(),async ({workUnit})=>{assert.equal(workUnit.last_turn.learned,'Keep the useful observation.');return {objective_id:workUnit.objective_ref,disposition:'done',summary:'Outcome checked.',outcome_evidence:[{kind:'file',path:'proof.txt',sha256:hash}]};});
      assert.equal(terminal.disposition,'terminal');assert.notEqual(terminal.execution_id,result.execution_id);
      assert.equal(await store().nextEligible(projectId),null);
    });
    await t.test('waiting resumes on new human input without losing input arriving during execution', async()=>{
      const s=store();const a=await input(s,'waiting');
      await run(s,async ({workUnit})=>({objective_id:workUnit.objective_ref,disposition:'waiting',summary:'Need a choice.',question:'Which behavior?',continuation:{mode:'condition',condition:{kind:'human',condition:'Human replies.'}}}));
      assert.equal(await s.nextEligible(projectId),null);
      await input(s,'waiting','Use the existing behavior.');
      await run(store(),async ({workUnit})=>{await input(store(),'waiting','Also preserve accessibility.');return next(workUnit.objective_ref);});
      assert.equal(await store().nextEligible(projectId),a.work_unit_id);
      await run(store(),async ({workUnit})=>({objective_id:workUnit.objective_ref,disposition:'waiting',summary:'Waiting for test fixture.',continuation:{mode:'condition',condition:{kind:'external',condition:'Fixture arrives.'}}}));
    });
    await t.test('new input during completion remains eligible', async()=>{
      const s=store();const a=await input(s,'completion-reply');
      const hash=createHash('sha256').update('verified result').digest('hex');
      await run(s,async ({workUnit})=>{await input(s,'completion-reply','Check one more consequence.');return {objective_id:workUnit.objective_ref,disposition:'done',summary:'Original goal checked.',outcome_evidence:[{kind:'file',path:'proof.txt',sha256:hash}]};});
      assert.equal(await store().nextEligible(projectId),a.work_unit_id);
      await run(store(),async ({workUnit})=>({objective_id:workUnit.objective_ref,disposition:'waiting',summary:'Follow-up read; waiting for fixture.',continuation:{mode:'condition',condition:{kind:'external',condition:'Fixture arrives.'}}}));
    });
    await t.test('failed result settlement rolls back result and eligibility together, no retry of uncertain effects',async()=>{
      const s=store();const a=await input(s,'rollback');
      const broken={...s,persistTurn:async result=>{result.workUnit.pilot.input_seq=-1;return s.persistTurn(result);}};
      await assert.rejects(run(broken,async ({workUnit})=>next(workUnit.objective_ref)));
      const row=await s.reconstruct({work_unit_id:a.work_unit_id});assert.ok(row.claim);
      assert.equal((await pool.query('SELECT * FROM vnext_pilot_results WHERE work_unit_id=$1',[a.work_unit_id])).rowCount,0);
      assert.equal(await store().nextEligible(projectId),null);
      // Preserve this uncertain claim; it also blocks other objectives in the project.
      await input(s,'other');assert.equal(await s.nextEligible(projectId),null);
    });
  } finally { await pool.end();await rm(dir,{recursive:true,force:true}); }
});
