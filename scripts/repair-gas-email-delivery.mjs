// One explicitly authorized historical repair, NOT a general force-unlock tool.
// No Gmail API or send calls. Positive evidence was supplied by the mailbox owner.
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Pool } from 'pg';
import { TARGET,validateTarget } from './bootstrap-gas-email.mjs';
import { upgradeDelivery } from './upgrade-gas-email-delivery.mjs';
export const REPAIR=Object.freeze({instance:'gas-vnext-email',project:'celestan-email',execution:'gas-turn-479896e4-aea4-4e10-9d01-bb90ff715326',work:'gas-email-aeddebba6b1523e1ba05a2ffb9d10fa7',gmailId:'1a12116729e4a391',thread:'1a121129847fa71a',inputSeq:'1'});
const repairId='owner-delivery-repair:'+REPAIR.execution;
const evidence={repairId,executionId:REPAIR.execution,providerId:REPAIR.gmailId,evidenceKind:'user-supplied-owner-readback-and-receipt-confirmation',ownerConfirmedReceipt:true,completeThread:true,exactlyOneSentCandidate:true,sent:true,thread:true,from:true,to:true,reference:true,subject:true,normalizedBody:true,syntheticMessageId:false,automaticIdentityVerified:false};
const sha=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const validDeploymentAttestation=v=>typeof v==='string'&&v.length<=500&&/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/actions\/runs\/[0-9]+(?:\/attempts\/[0-9]+)?$/.test(v);
export async function repairDelivery(pool,{apply=false,expectedSnapshot,deploymentAttestation=null}={}){
 if((await upgradeDelivery(pool)).status!=='already-applied')throw new Error('delivery extension required');
 const c=await pool.connect();try{
  await c.query('BEGIN');await c.query("SET LOCAL lock_timeout='10s'; SET LOCAL statement_timeout='30s'");
  await c.query("SELECT pg_advisory_xact_lock(hashtextextended('ct-runtime:vnext-project:'||$1,0))",[REPAIR.project]);
  const registrations=(await c.query('SELECT instance_id,project_id,active,mailbox,allowed_sender,grant_ref FROM public.gas_email_instances FOR SHARE')).rows;
  if(registrations.length!==1||registrations[0].instance_id!==REPAIR.instance||registrations[0].project_id!==REPAIR.project||!registrations[0].active)throw new Error('registration changed');
  if(registrations[0].mailbox!=='midnight.project.mp@gmail.com'||registrations[0].allowed_sender!=='midnightprojectantigravity@gmail.com'||registrations[0].grant_ref!=='user-authorized:pr69:gas-text-only:v1')throw new Error('grant changed');
  const rows=(await c.query(`SELECT o.*,e.project_id,e.state AS execution_state,e.fence,e.owner,
   e.work_unit_id AS execution_work,t.input_seq AS turn_input,t.instance_id AS turn_instance
   FROM public.gas_email_outbox o JOIN public.vnext_executions e USING(execution_id)
   JOIN public.gas_email_turns t USING(execution_id) WHERE o.execution_id=$1 FOR UPDATE OF o`,[REPAIR.execution])).rows;
  if(rows.length!==1)throw new Error('missing exact outbox');
  const o=rows[0],e=o.envelope,encoded=JSON.stringify(e);
  if(o.work_unit_id!==REPAIR.work||String(o.fence)!=='1')throw new Error('work or fence changed');
  if(o.instance_id!==REPAIR.instance||o.project_id!==REPAIR.project||o.owner!==REPAIR.instance||o.turn_instance!==REPAIR.instance||o.execution_state!=='succeeded'||o.execution_work!==o.work_unit_id||String(o.input_seq)!==REPAIR.inputSeq||String(o.turn_input)!==REPAIR.inputSeq||e.id!==REPAIR.thread||e.threadId!==REPAIR.thread||e.messageId!==`<${REPAIR.execution}@ct-runtime.invalid>`||e.from!=='midnightprojectantigravity@gmail.com'||e.to!=='midnight.project.mp@gmail.com'||encoded.length!==630||Buffer.byteLength(encoded)!==632||e.body.length!==293||Buffer.byteLength(e.body)!==295||e.subject.length!==8||Buffer.byteLength(e.subject)!==8||o.provider_receipt!==null)throw new Error('outbox snapshot changed');
  const receipt=(await c.query('SELECT envelope FROM public.gas_email_receipts WHERE instance_id=$1 AND input_seq=$2 AND message_id=$3',[REPAIR.instance,REPAIR.inputSeq,REPAIR.thread])).rows;
  if(receipt.length!==1||receipt[0].envelope.reference!==e.reference||receipt[0].envelope.subject!==e.subject||receipt[0].envelope.threadId!==e.threadId)throw new Error('provenance changed');
  const reused=(await c.query('SELECT 1 FROM public.gas_email_outbox WHERE execution_id<>$1 AND (gmail_id=$2 OR provider_receipt=$2)',[REPAIR.execution,REPAIR.gmailId])).rows;
  if(reused.length)throw new Error('provider id reused');
  const audits=(await c.query("SELECT payload FROM public.vnext_events WHERE event_type='gas-email-owner-delivery-repair' AND payload->>'repairId'=$1",[repairId])).rows;
  const blocks=(await c.query('SELECT project_id,work_unit_id,execution_id,fence,reason FROM public.vnext_project_reconciliation_blocks WHERE project_id=$1 FOR UPDATE',[REPAIR.project])).rows;
  if(o.state==='sent'){
   if(o.gmail_id!==REPAIR.gmailId||audits.length!==1||!(await c.query('SELECT $1::jsonb=$2::jsonb AS same',[JSON.stringify(audits[0]?.payload),JSON.stringify(evidence)])).rows[0].same)throw new Error('resolved evidence conflict');
   if(blocks.some(b=>b.execution_id===REPAIR.execution))throw new Error('resolved block conflict');
   await c.query('ROLLBACK');return {status:'already-resolved',executionId:REPAIR.execution,gmailId:REPAIR.gmailId};
  }
  if(o.state!=='admitted'||o.gmail_id!==null||audits.length||blocks.length!==1)throw new Error('repair state changed');
  const b=blocks[0];if(b.execution_id!==REPAIR.execution||b.work_unit_id!==o.work_unit_id||String(b.fence)!==String(o.fence)||b.reason!=='external-effect-uncertain')throw new Error('block changed');
  if((await c.query('SELECT 1 FROM public.vnext_project_mutation_authority WHERE project_id=$1',[REPAIR.project])).rows.length)throw new Error('active authority');
  const snapshot=sha({outbox:o,block:b,evidence});
  if(!apply){await c.query('ROLLBACK');return {status:'repair-ready',executionId:REPAIR.execution,gmailId:REPAIR.gmailId,snapshot,evidence,requiresDeployedReceiptFix:true};}
  if(!validDeploymentAttestation(deploymentAttestation)||expectedSnapshot!==snapshot)throw new Error('deployment attestation reference and exact inspected snapshot required');
  await c.query("INSERT INTO public.vnext_events(event_type,payload) VALUES('gas-email-owner-delivery-repair',$1::jsonb)",[JSON.stringify({...evidence,deploymentAttestation})]);
  const updated=await c.query("UPDATE public.gas_email_outbox SET state='sent',gmail_id=$2 WHERE execution_id=$1 AND state='admitted' AND gmail_id IS NULL",[REPAIR.execution,REPAIR.gmailId]);
  const deleted=await c.query('DELETE FROM public.vnext_project_reconciliation_blocks WHERE project_id=$1 AND execution_id=$2 AND work_unit_id=$3 AND fence=$4',[REPAIR.project,REPAIR.execution,o.work_unit_id,o.fence]);
  if(updated.rowCount!==1||deleted.rowCount!==1)throw new Error('repair atomicity conflict');
  await c.query('COMMIT');return {status:'repaired',executionId:REPAIR.execution,gmailId:REPAIR.gmailId,auditRecorded:true,sendAttempted:false};
 }catch(e){await c.query('ROLLBACK').catch(()=>{});throw e;}finally{c.release();}
}
async function main(){
 const [mode,snapshot,confirmation]=process.argv.slice(2);
 if(!['inspect','apply'].includes(mode)||(mode==='inspect'&&process.argv.length!==3)||(mode==='apply'&&(!/^[a-f0-9]{64}$/.test(snapshot||'')||!validDeploymentAttestation(confirmation?.replace(/^--receipt-fix-attested=/,''))||!confirmation.startsWith('--receipt-fix-attested=')||process.argv.length!==4)))throw new Error('invalid repair command');
 const pool=new Pool({connectionString:validateTarget(process.env.CT_BOOTSTRAP_DATABASE_URL),max:1,connectionTimeoutMillis:15000});
 try{const r=(await pool.query('SELECT current_database() AS db,current_user AS owner')).rows[0];if(r.db!==TARGET.database||r.owner!==TARGET.owner)throw new Error('wrong target');console.log(JSON.stringify({target:TARGET,...await repairDelivery(pool,{apply:mode==='apply',expectedSnapshot:snapshot,deploymentAttestation:mode==='apply'?confirmation.slice('--receipt-fix-attested='.length):null)}));}finally{await pool.end();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(()=>{console.error('Scoped repair rejected or uncertain; inspect reality before retry. Credentials and content withheld.');process.exitCode=1;});
