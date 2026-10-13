// Exactly one owner-authorized retry of an existing text-only input. Never sends.
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Pool } from 'pg';
import { TARGET,validateTarget } from './bootstrap-gas-email.mjs';
import { upgradeDelivery } from './upgrade-gas-email-delivery.mjs';
export const RETRY=Object.freeze({instance:'gas-vnext-email',project:'celestan-email',execution:'gas-turn-963627a2-09f8-48b6-8c29-1ad46f8005cc',work:'gas-email-aeddebba6b1523e1ba05a2ffb9d10fa7',message:'1a1308e396490afd',input:'2',fence:'2',oldExecution:'gas-turn-479896e4-aea4-4e10-9d01-bb90ff715326',oldReply:'1a12116729e4a391'});
const retryId='owner-model-retry:'+RETRY.execution+':2';
const validDeploymentAttestation=v=>typeof v==='string'&&v.length<=500&&/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/actions\/runs\/[0-9]+(?:\/attempts\/[0-9]+)?$/.test(v);
export async function retryModel(pool,{apply=false,expectedSnapshot,deploymentAttestation=null}={}){
 if((await upgradeDelivery(pool)).status!=='already-applied')throw new Error('diagnostics extension required');
 const c=await pool.connect();try{
  await c.query('BEGIN');await c.query("SET LOCAL lock_timeout='10s'; SET LOCAL statement_timeout='30s'");
  await c.query("SELECT pg_advisory_xact_lock(hashtextextended('ct-runtime:vnext-project:'||$1,0))",[RETRY.project]);
  const registrations=(await c.query('SELECT * FROM gas_email_instances FOR SHARE')).rows;
  const i=registrations[0];if(registrations.length!==1||i.instance_id!==RETRY.instance||i.project_id!==RETRY.project||!i.active||i.mailbox!=='midnight.project.mp@gmail.com'||i.allowed_sender!=='midnightprojectantigravity@gmail.com'||i.grant_ref!=='user-authorized:pr69:gas-text-only:v1')throw new Error('registration mismatch');
  const audits=(await c.query("SELECT payload FROM vnext_events WHERE event_type='gas-email-owner-model-retry' AND payload->>'retryId'=$1",[retryId])).rows;
  if(audits.length===1){await c.query('ROLLBACK');return {status:'already-retried',retryId,effect:false};}
  const rows=(await c.query(`SELECT e.*,t.input_seq,t.instance_id FROM vnext_executions e JOIN gas_email_turns t USING(execution_id) WHERE e.execution_id=$1 FOR UPDATE OF e`,[RETRY.execution])).rows;
  const e=rows[0];if(rows.length!==1||e.work_unit_id!==RETRY.work||e.project_id!==RETRY.project||e.owner!==RETRY.instance||e.instance_id!==RETRY.instance||e.state!=='failed'||String(e.fence)!==RETRY.fence||String(e.input_seq)!==RETRY.input||e.failure?.reason!=='bounded-model-failure'||!e.finished_at)throw new Error('failed execution mismatch');
  const w=(await c.query('SELECT * FROM vnext_work_units WHERE work_unit_id=$1 FOR UPDATE',[RETRY.work])).rows[0];
  const p=(await c.query('SELECT * FROM vnext_pilot_progress WHERE work_unit_id=$1 FOR UPDATE',[RETRY.work])).rows[0];
  if(!w||w.project_id!==RETRY.project||w.state!=='waiting'||String(w.fence)!==RETRY.fence||w.claim_execution_id||w.claim_owner||w.claim_fence||w.claim_expires_at||!p||String(p.consumed_input_seq)!=='1'||String(p.failed_through_seq)!=='2'||p.next_wake_at)throw new Error('progress mismatch');
  const inputs=(await c.query('SELECT * FROM vnext_pilot_inputs WHERE work_unit_id=$1 ORDER BY input_seq FOR SHARE',[RETRY.work])).rows;
  const input=inputs.at(-1);if(!input||String(input.input_seq)!=='2'||typeof input.message!=='string'||!input.message.trim())throw new Error('input mismatch');
  const receipts=(await c.query('SELECT * FROM gas_email_receipts WHERE instance_id=$1 AND input_seq=2 AND message_id=$2',[RETRY.instance,RETRY.message])).rows;
  if(receipts.length!==1||receipts[0].envelope.body!==input.message||receipts[0].envelope.id!==RETRY.message)throw new Error('receipt mismatch');
  if((await c.query('SELECT 1 FROM vnext_project_mutation_authority WHERE project_id=$1 UNION ALL SELECT 1 FROM vnext_project_reconciliation_blocks WHERE project_id=$1',[RETRY.project])).rows.length)throw new Error('authority or reconciliation active');
  const outbox=(await c.query('SELECT * FROM gas_email_outbox WHERE instance_id=$1 ORDER BY input_seq,created_at FOR SHARE',[RETRY.instance])).rows;
  if(outbox.some(o=>o.state==='pending'||o.state==='admitted'||Number(o.input_seq)>=2)||!outbox.length||outbox.at(-1).state!=='sent'||!outbox.at(-1).gmail_id)throw new Error('delivery mismatch');
  if(outbox.at(-1).execution_id!==RETRY.oldExecution||outbox.at(-1).gmail_id!==RETRY.oldReply||outbox.at(-1).work_unit_id!==RETRY.work)throw new Error('old reply mismatch');
  if((await c.query('SELECT 1 FROM vnext_pilot_results WHERE execution_id=$1',[RETRY.execution])).rows.length)throw new Error('unexpected result');
  const snapshot=createHash('sha256').update(JSON.stringify({e,w,p,inputs,receipts,outbox})).digest('hex');
  if(!apply){await c.query('ROLLBACK');return {status:'retry-ready',retryId,snapshot,requiresModelDiagnosticsDeployed:true,effect:false};}
  if(!validDeploymentAttestation(deploymentAttestation)||expectedSnapshot!==snapshot)throw new Error('deployment attestation reference and exact snapshot required');
  await c.query("INSERT INTO vnext_events(event_type,payload) VALUES('gas-email-owner-model-retry',$1::jsonb)",[JSON.stringify({retryId,failedExecution:RETRY.execution,inputSeq:2,workUnitId:RETRY.work,snapshot,modelDiagnosticsDeploymentAttestation:deploymentAttestation,authorization:'user-authorized:pr69:one-text-only-retry'})]);
  await c.query('UPDATE vnext_pilot_progress SET failed_through_seq=consumed_input_seq,next_wake_at=clock_timestamp(),updated_at=clock_timestamp() WHERE work_unit_id=$1',[RETRY.work]);
  await c.query("UPDATE vnext_work_units SET state='actionable',updated_at=clock_timestamp() WHERE work_unit_id=$1",[RETRY.work]);
  await c.query('COMMIT');return {status:'retry-released',retryId,auditRecorded:true,modelCalled:false,sendAttempted:false};
 }catch(e){await c.query('ROLLBACK').catch(()=>{});throw e;}finally{c.release();}
}
async function main(){
 const [mode,snapshot,confirmation]=process.argv.slice(2);
 if(!['inspect','apply'].includes(mode)||(mode==='inspect'&&process.argv.length!==3)||(mode==='apply'&&(!/^[a-f0-9]{64}$/.test(snapshot||'')||!confirmation?.startsWith('--model-diagnostics-attested=')||!validDeploymentAttestation(confirmation.slice('--model-diagnostics-attested='.length))||process.argv.length!==5)))throw new Error('invalid command');
 const pool=new Pool({connectionString:validateTarget(process.env.CT_BOOTSTRAP_DATABASE_URL),max:1,connectionTimeoutMillis:15000});
 try{const r=(await pool.query('SELECT current_database() AS db,current_user AS owner')).rows[0];if(r.db!==TARGET.database||r.owner!==TARGET.owner)throw new Error('wrong target');console.log(JSON.stringify({target:TARGET,...await retryModel(pool,{apply:mode==='apply',expectedSnapshot:snapshot,deploymentAttestation:mode==='apply'?confirmation.slice('--model-diagnostics-attested='.length):null})}));}finally{await pool.end();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(()=>{console.error('Scoped retry rejected or uncertain; inspect before retry. Credentials and content withheld.');process.exitCode=1;});
