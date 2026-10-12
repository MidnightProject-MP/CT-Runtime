import test from 'node:test';
import assert from 'node:assert/strict';
import { PROJECT,SCRIPT,query,sanitize,run } from '../scripts/gas-tick-logs.mjs';
const from='2026-10-12T14:40:00Z',to='2026-10-12T15:00:00Z';
const secret='injected-secret-mail-token-userkey';
const entry={timestamp:'2026-10-12T14:44:05.591Z',resource:{type:'app_script_function',labels:{function_name:'vnextEmailTick',project_id:PROJECT}},labels:{'script.googleapis.com/project_key':SCRIPT},jsonPayload:{message:JSON.stringify({status:'model-failed',stage:'model',failure:{classification:'rate-limited',httpStatus:429,providerReason:secret,sqlState:secret,message:secret},request:secret})}};
test('closed project/script/function scope and maximum hour window',()=>{
  const q=query(from,to);assert.deepEqual(q.resourceNames,[`projects/${PROJECT}`]);assert.equal(q.pageSize,50);
  for(const text of [SCRIPT,'vnextEmailTick','app_script_function',from,to])assert.ok(q.filter.includes(text));
  assert.ok(!q.filter.includes('resource.labels.project_id'));
  for(const bounds of [[secret,to],[from,from],[from,'2026-10-12T16:00:00Z'],[from+'" OR true',to]])assert.throws(()=>query(...bounds));
});
test('only recognized tick JSON fields survive; unknown logs omitted',()=>{
  assert.deepEqual(sanitize(entry,from,to),{timestamp:entry.timestamp,status:'model-failed',stage:'model',classification:'rate-limited',httpStatus:429});
  assert.equal(sanitize({...entry,textPayload:secret,jsonPayload:undefined},from,to),null);
  assert.equal(sanitize({...entry,labels:{}},from,to),null);
  assert.equal(sanitize({...entry,timestamp:secret},from,to),null);
  assert.equal(sanitize({...entry,jsonPayload:{message:JSON.stringify({status:secret,stage:'model'})}},from,to),null);
  assert.ok(sanitize({...entry,jsonPayload:undefined,textPayload:entry.jsonPayload.message},from,to));
  assert.ok(sanitize({...entry,resource:{...entry.resource,labels:{...entry.resource.labels,project_id:'textual-project-id'}}},from,to));
});
const env={FROM_UTC:from,TO_UTC:to,CLASPRC_JSON:JSON.stringify({tokens:{default:{client_id:secret,client_secret:secret,refresh_token:secret}}})};
test('OAuth in memory then only entries:list, bounded two pages and redacted output',async()=>{
  const calls=[],output=[];
  const fetcher=async(url,options)=>{calls.push({url,options});return {ok:true,json:async()=>calls.length===1?{access_token:secret}:{entries:[entry,{textPayload:secret}],nextPageToken:secret}};};
  assert.equal(await run(env,fetcher,x=>output.push(x)),true);assert.equal(calls.length,3);
  assert.equal(calls[0].url,'https://oauth2.googleapis.com/token');
  for(const call of calls.slice(1)){assert.equal(call.url,'https://logging.googleapis.com/v2/entries:list');assert.equal(call.options.method,'POST');assert.equal(JSON.parse(call.options.body).pageSize,50);}
  assert.doesNotMatch(JSON.stringify(output),new RegExp(secret));assert.deepEqual(output.at(-1),{status:'read-complete',matched:2,truncated:true});
});
test('403 retains only allowlisted reason; errors never print raw response or exception',async()=>{
  const output=[];let count=0;
  assert.equal(await run(env,async()=>++count===1?{ok:true,json:async()=>({access_token:secret})}:{ok:false,status:403,json:async()=>({error:{message:secret,status:'PERMISSION_DENIED',details:[{reason:secret}]}})},x=>output.push(x)),false);
  assert.deepEqual(output,[{status:'access-unavailable',stage:'logging',httpStatus:403,providerReason:'PERMISSION_DENIED'}]);
  await run(env,async()=>{throw new Error(secret);},x=>output.push(x));assert.doesNotMatch(JSON.stringify(output),new RegExp(secret));
});
