// Read-only owner observation. No runtime RPC, Gmail/model calls, or mutations.
import { Pool } from 'pg';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { TARGET,validateTarget } from './bootstrap-gas-email.mjs';
const INSTANCE='gas-vnext-email',PROJECT='celestan-email';
const stamp=v=>{const d=new Date(v);return v!=null&&!Number.isNaN(d.valueOf())?d.toISOString():null;};
const number=v=>/^\d{1,20}$/.test(String(v))?String(v):null;
const id=v=>v==null?null:/^(?:gas-turn-[0-9a-f-]{36}|gas-email-[0-9a-f]{32}|[0-9a-f]{1,100})$/.test(String(v))?String(v):'opaque-'+createHash('sha256').update(String(v)).digest('hex').slice(0,16);
const state=(v,allowed)=>allowed.includes(v)?v:'unclassified';
export async function inspectRuntime(pool){
  const c=await pool.connect();try{
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const clock=(await c.query('SELECT clock_timestamp() AS observed_at,current_database() AS database,current_user AS owner')).rows[0];
    const registration=(await c.query('SELECT active FROM gas_email_instances WHERE instance_id=$1 AND project_id=$2',[INSTANCE,PROJECT])).rows;
    if(registration.length!==1)throw new Error('pinned instance not found');
    const counts=(await c.query(`SELECT
      (SELECT count(*) FROM gas_email_receipts WHERE instance_id=$1) AS receipts,
      (SELECT count(*) FROM gas_email_quarantine WHERE instance_id=$1) AS quarantined,
      (SELECT count(*) FROM gas_email_threads g JOIN vnext_work_units w USING(work_unit_id) WHERE g.instance_id=$1 AND w.project_id=$2) AS work_units,
      (SELECT count(*) FROM gas_email_turns t JOIN vnext_executions e USING(execution_id) WHERE t.instance_id=$1 AND e.project_id=$2) AS executions,
      (SELECT count(*) FROM gas_email_outbox WHERE instance_id=$1) AS replies,
      (SELECT count(*) FROM gas_email_outbox WHERE instance_id=$1 AND state='admitted') AS uncertain,
      (SELECT count(*) FROM gas_email_outbox WHERE instance_id=$1 AND state='sent' AND gmail_id IS NOT NULL) AS recorded_deliveries,
      (SELECT count(*) FROM vnext_project_reconciliation_blocks WHERE project_id=$2) AS reconciliation_blocks`,[INSTANCE,PROJECT])).rows[0];
    const receipts=(await c.query(`SELECT r.message_id,r.input_seq,p.received_at FROM gas_email_receipts r JOIN vnext_pilot_inputs p USING(input_seq) JOIN vnext_work_units w USING(work_unit_id) WHERE r.instance_id=$1 AND w.project_id=$2 ORDER BY r.input_seq DESC LIMIT 10`,[INSTANCE,PROJECT])).rows;
    const quarantine=(await c.query("SELECT message_id,created_at FROM gas_email_quarantine WHERE instance_id=$1 ORDER BY created_at DESC LIMIT 10",[INSTANCE])).rows;
    const progress=(await c.query(`SELECT w.work_unit_id,w.state,w.updated_at,p.consumed_input_seq,p.failed_through_seq,p.next_wake_at,p.updated_at AS progress_at,
      (SELECT max(input_seq) FROM vnext_pilot_inputs x WHERE x.work_unit_id=w.work_unit_id) AS latest_input_seq
      FROM gas_email_threads g JOIN vnext_work_units w USING(work_unit_id) JOIN vnext_pilot_progress p USING(work_unit_id)
      WHERE g.instance_id=$1 AND w.project_id=$2 ORDER BY w.updated_at DESC LIMIT 10`,[INSTANCE,PROJECT])).rows;
    const turns=(await c.query(`SELECT e.execution_id,e.work_unit_id,e.state,e.started_at,e.finished_at,e.claim_expires_at,t.input_seq,
      CASE WHEN e.failure->>'reason' IN ('bounded-model-failure','text-turn-expired') THEN e.failure->>'reason' WHEN e.failure IS NOT NULL THEN 'unclassified' ELSE NULL END AS failure_class,
      EXISTS(SELECT 1 FROM vnext_pilot_results r WHERE r.execution_id=e.execution_id) AS result_present
      FROM gas_email_turns t JOIN vnext_executions e USING(execution_id)
      WHERE t.instance_id=$1 AND e.project_id=$2 ORDER BY e.started_at DESC LIMIT 10`,[INSTANCE,PROJECT])).rows;
    const outbox=(await c.query('SELECT execution_id,work_unit_id,input_seq,state,gmail_id,created_at FROM gas_email_outbox WHERE instance_id=$1 ORDER BY created_at DESC LIMIT 10',[INSTANCE])).rows;
    await c.query('ROLLBACK');
    const safeCounts={};for(const k of ['receipts','quarantined','work_units','executions','replies','uncertain','recorded_deliveries','reconciliation_blocks'])safeCounts[k]=number(counts[k]);
    return {observedAtUtc:stamp(clock.observed_at),instance:INSTANCE,project:PROJECT,active:registration[0].active===true,counts:safeCounts,
      observation:Number(counts.uncertain)>0||Number(counts.reconciliation_blocks)>0?'delivery-reconciliation-required':Number(counts.recorded_deliveries)>0?'delivery-record-present':Number(counts.replies)>0?'outbox-present':Number(counts.executions)>0?'execution-present':Number(counts.receipts)>0?'input-received':Number(counts.quarantined)>0?'intake-quarantined':'no-intake-observed',
      receipts:receipts.map(r=>({messageId:id(r.message_id),inputSeq:number(r.input_seq),receivedAt:stamp(r.received_at)})),
      quarantine:quarantine.map(r=>({messageId:id(r.message_id),classification:'intake-rejected',recordedAt:stamp(r.created_at)})),
      progress:progress.map(r=>({workUnitId:id(r.work_unit_id),state:state(r.state,['actionable','waiting','review','terminal']),latestInputSeq:number(r.latest_input_seq),consumedInputSeq:number(r.consumed_input_seq),failedThroughSeq:number(r.failed_through_seq),updatedAt:stamp(r.updated_at),progressAt:stamp(r.progress_at),nextWakeAt:stamp(r.next_wake_at)})),
      executions:turns.map(r=>({executionId:id(r.execution_id),workUnitId:id(r.work_unit_id),inputSeq:number(r.input_seq),state:state(r.state,['created','running','succeeded','failed','expired']),startedAt:stamp(r.started_at),finishedAt:stamp(r.finished_at),claimExpiresAt:stamp(r.claim_expires_at),resultPresent:r.result_present===true,failureClass:r.failure_class==null?null:state(r.failure_class,['bounded-model-failure','text-turn-expired'])})),
      outbox:outbox.map(r=>({executionId:id(r.execution_id),workUnitId:id(r.work_unit_id),inputSeq:number(r.input_seq),state:state(r.state,['pending','admitted','sent','superseded']),gmailId:id(r.gmail_id),createdAt:stamp(r.created_at)}))};
  }catch(e){await c.query('ROLLBACK').catch(()=>{});throw e;}finally{c.release();}
}
async function main(){
  const pool=new Pool({connectionString:validateTarget(process.env.CT_BOOTSTRAP_DATABASE_URL),max:1,connectionTimeoutMillis:15000,statement_timeout:15000});
  try{const r=await pool.query('SELECT current_database() AS database,current_user AS owner');if(r.rows[0].database!==TARGET.database||r.rows[0].owner!==TARGET.owner)throw new Error('wrong target');console.log(JSON.stringify({target:TARGET,...await inspectRuntime(pool)}));}finally{await pool.end();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(()=>{console.error('Read-only email status unavailable; credentials and query errors withheld.');process.exitCode=1;});
