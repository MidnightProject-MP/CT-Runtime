import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectRuntime } from '../scripts/inspect-gas-email-runtime.mjs';
test('status is read-only, pinned, bounded, correlated and never emits row bodies or unclassified failure text',async()=>{
  const queries=[];let released=false;
  const eid='gas-turn-11111111-1111-1111-1111-111111111111',wid='gas-email-'+'a'.repeat(32),secret='PRIVATE_SECRET_BODY';
  const c={release(){released=true;},async query(sql,args){queries.push({sql,args});
    if(sql.startsWith('BEGIN')||sql==='ROLLBACK')return {rows:[]};
    if(sql.includes('clock_timestamp()'))return {rows:[{observed_at:'2026-10-09T00:00:00Z',secret}]};
    if(sql.startsWith('SELECT active'))return {rows:[{active:true,secret}]};
    if(sql.includes('AS receipts'))return {rows:[{receipts:'1',quarantined:'0',work_units:'1',executions:'1',replies:'1',uncertain:'0',recorded_deliveries:'1',reconciliation_blocks:'0',secret}]};
    if(sql.includes('SELECT r.message_id'))return {rows:[{message_id:'123abc',input_seq:1,received_at:'2026-10-09T00:00:00Z',envelope:{body:secret}}]};
    if(sql.startsWith('SELECT message_id'))return {rows:[]};
    if(sql.includes('SELECT w.work_unit_id'))return {rows:[{work_unit_id:wid,state:'review',latest_input_seq:1,consumed_input_seq:1,failed_through_seq:0,last_turn:secret}]};
    if(sql.includes('SELECT e.execution_id'))return {rows:[{execution_id:eid,work_unit_id:wid,input_seq:1,state:'succeeded',result_present:true,failure_class:secret,turn:secret}]};
    return {rows:[{execution_id:eid,work_unit_id:wid,input_seq:1,state:'sent',gmail_id:'456def',envelope:{body:secret}}]};
  }};
  const result=await inspectRuntime({connect:async()=>c});assert.equal(released,true);
  assert.equal(queries[0].sql,'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');assert.equal(queries.at(-1).sql,'ROLLBACK');
  for(const q of queries.slice(2,-1)){assert.ok(q.sql.includes('instance_id=$1'));assert.equal(q.args[0],'gas-vnext-email');assert.doesNotMatch(q.sql,/SELECT \*|\b(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP)\b/);}
  for(const q of queries.filter(q=>q.sql.includes('ORDER BY')))assert.match(q.sql,/LIMIT 10/);
  assert.equal(result.observation,'delivery-record-present');assert.equal(result.executions[0].resultPresent,true);assert.equal(result.outbox[0].executionId,result.executions[0].executionId);assert.equal(result.executions[0].failureClass,'unclassified');assert.doesNotMatch(JSON.stringify(result),/PRIVATE_SECRET_BODY|envelope|summary|"turn"/);
});
test('failed inspection rolls back its read-only transaction and releases the connection',async()=>{
  const queries=[];let released=false;
  const failure=new Error('private database failure');
  const c={release(){released=true;},async query(sql){queries.push(sql);if(sql.startsWith('SELECT'))throw failure;return {rows:[]};}};
  await assert.rejects(inspectRuntime({connect:async()=>c}),e=>e===failure);
  assert.deepEqual(queries,['BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY','SELECT clock_timestamp() AS observed_at,current_database() AS database,current_user AS owner','ROLLBACK']);
  assert.equal(released,true);
});
