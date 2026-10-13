import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const source=readFileSync(new URL('../gas/gas_vnext_email.js',import.meta.url),'utf8');
function fixture(change=()=>{}){
  const execution='gas-turn-479896e4-aea4-4e10-9d01-bb90ff715326';
  const envelope={id:'1a121129847fa71a',threadId:'abcdef',messageId:`<${execution}@ct-runtime.invalid>`,reference:'<private-reference@example.com>',subject:'secret subject',body:'private model body'};
  const message={id:'123abc',threadId:envelope.threadId,labelIds:['SENT'],payload:{mimeType:'text/plain',headers:Object.entries({From:'midnight.project.mp@gmail.com',To:'midnightprojectantigravity@gmail.com','Message-ID':envelope.messageId,'In-Reply-To':envelope.reference,Subject:envelope.subject}).map(([name,value])=>({name,value})),body:{data:Buffer.from(envelope.body).toString('base64url')}}};
  const state={envelope,message,page:{messages:[{id:message.id}]},thread:{id:envelope.threadId,messages:[message]},http:{},peek:'reconcile',profile:'midnight.project.mp@gmail.com'};change(state);
  const values={CT_VNEXT_EMAIL_INSTANCE:'gas-vnext-email',CT_VNEXT_EMAIL_DATA_API_URL:'https://ep-weathered-tree-b4v72i6c.apirest.c-6.us-east-2.aws.neon.tech/neondb/rest/v1',CT_VNEXT_EMAIL_LABEL:'Celestan',CT_VNEXT_EMAIL_MODEL:'vendor/model',OPENROUTER_API_KEY:'credential-secret',CT_VNEXT_EMAIL_ENABLED:'true'};
  const calls=[],logs=[];let effects=0;
  const forbidden=()=>{effects++;throw new Error('credential-secret forbidden effect');};
  const ctx=vm.createContext({console:{log:s=>logs.push(JSON.parse(s))},PropertiesService:{getScriptProperties:()=>({getProperty:k=>values[k]??null,setProperty:forbidden,setProperties:forbidden})},ScriptApp:{getOAuthToken:()=> 'oauth-secret',getIdentityToken:()=> 'identity-secret',getProjectTriggers:forbidden,newTrigger:forbidden},SpreadsheetApp:new Proxy({},{get:forbidden}),LockService:{getScriptLock:()=>({tryLock:()=>true,releaseLock(){}})},Utilities:{Charset:{UTF_8:'UTF-8'},base64Encode:s=>Buffer.from(s).toString('base64'),base64DecodeWebSafe:s=>Buffer.from(s,'base64url'),newBlob:b=>({getDataAsString:()=>Buffer.from(b).toString()})},UrlFetchApp:{fetch(url,opts){
    calls.push({url,method:opts.method});let data,status=200;
    const key=Object.keys(state.http).find(k=>url.includes(k));
    if(key){({data,status}=state.http[key]);}
    else if(url.endsWith('/rpc/gas_email_rpc')){const op=JSON.parse(opts.payload).p_operation;assert.ok(['health','delivery-peek'].includes(op));data=op==='health'?{instance:'gas-vnext-email',project:'celestan-email',mailbox:'midnight.project.mp@gmail.com',allowed_sender:'midnightprojectantigravity@gmail.com',grant_ref:'user-authorized:pr69:gas-text-only:v1'}:{status:state.peek,execution_id:execution,envelope};}
    else{assert.equal(opts.method,'get');if(url.endsWith('/profile'))data={emailAddress:state.profile};else if(url.includes('messages?maxResults=10&q=')){assert.equal(decodeURIComponent(url.split('&q=')[1]),`in:sent rfc822msgid:${envelope.messageId}`);data=state.page;}else if(url.includes('/messages/'))data=message;else if(url.endsWith('/threads/abcdef?format=full'))data=state.thread;else return forbidden();}
    return {getResponseCode:()=>status,getContentText:()=>JSON.stringify(data)};
  }}});
  vm.runInContext(source,ctx);
  return {run:()=>ctx.diagnoseVnextEmailDelivery(),tick:()=>ctx.vnextEmailTick(),calls,logs,values,effects:()=>effects};
}
test('owner diagnostic compares actual Sent and thread without writes or content leakage',()=>{
  const f=fixture(),r=f.run();assert.equal(r.status,'uncertain');assert.equal(r.outboxStatus,'admitted');assert.equal(r.candidates.length,2);assert.ok(r.candidates.every(c=>Object.values(c.comparisons).every(Boolean)));assert.equal(f.effects(),0);assert.equal(f.logs.length,1);
  assert.doesNotMatch(JSON.stringify(r),/private model|secret subject|private-reference|credential-secret|oauth-secret|identity-secret/);
});
for(const field of ['messageId','subject','thread','normalizedBody','reference','from','to','sent'])test(`diagnostic reveals ${field} mismatch without weakening verification`,()=>{
  const f=fixture(s=>{if(field==='thread')s.message.threadId='deadbeef';else if(field==='normalizedBody')s.message.payload.body.data=Buffer.from('injected secret body').toString('base64url');else if(field==='sent')s.message.labelIds=[];else s.message.payload.headers.find(h=>h.name===({messageId:'Message-ID',subject:'Subject',reference:'In-Reply-To',from:'From',to:'To'}[field])).value='injected-secret';});
  const r=f.run();assert.ok(r.candidates.every(c=>c.comparisons[field]===false&&c.mismatchFields.includes(field)));assert.doesNotMatch(JSON.stringify(f.logs),/injected-secret|injected secret/);assert.equal(f.effects(),0);
});
test('403 safe provider reason, per-candidate failure and secondary thread survive search errors',()=>{
  for(const path of ['/profile','messages?','/messages/']){
    const f=fixture(s=>{s.http[path]={status:403,data:{error:{message:'credential-secret',errors:[{reason:'insufficientPermissions'}]}}};});const r=f.run();
    const failure=path==='/profile'?r.failure:path==='messages?'?r.searchFailure:r.candidates[0].failure;
    assert.equal(failure.httpStatus,403);assert.equal(failure.providerReason,'insufficientPermissions');assert.doesNotMatch(JSON.stringify(f.logs),/credential-secret/);
    if(path!=='/profile')assert.ok(r.candidates.some(c=>c.source==='thread'));assert.equal(f.effects(),0);
  }
});
test('pagination and excess thread/search candidates stay uncertain and bounded',()=>{
  const f=fixture(s=>{s.page.nextPageToken='credential-secret';s.page.messages=Array.from({length:20},()=>({id:'123abc'}));s.thread.messages=Array.from({length:20},()=>s.message);});const r=f.run();
  assert.equal(r.searchTruncated,true);assert.equal(r.searchHasNextPage,true);assert.equal(r.threadTruncated,true);assert.equal(r.candidates.length,20);assert.equal(r.threadCandidateIds.length,10);assert.equal(f.calls.filter(c=>c.url.includes('/messages/')).length,10);assert.doesNotMatch(JSON.stringify(f.logs),/credential-secret/);
});
test('oversized thread is rejected and no second page fetched',()=>{
  const f=fixture(s=>{s.thread.extra='credential-secret'.repeat(20000);});const r=f.run();assert.equal(r.threadFailure.classification,'response-too-large');assert.equal(r.status,'uncertain');assert.doesNotMatch(JSON.stringify(f.logs),/credential-secret/);
});
test('config/mailbox validation stops diagnostic and tick failures log only safe fixed stages',()=>{
  const wrong=fixture();wrong.values.CT_VNEXT_EMAIL_DATA_API_URL='https://attacker.example';assert.equal(wrong.run().stage,'persisted-config');assert.equal(wrong.calls.length,0);
  const f=fixture(s=>{s.http['/profile']={status:403,data:{error:{message:'credential-secret',errors:[{reason:'secret-injected-reason'}]}}};});const r=f.tick();assert.equal(r.status,'blocked');assert.equal(r.stage,'gmail-profile');assert.equal(r.failure.providerReason,null);assert.equal(f.logs.length,1);assert.doesNotMatch(JSON.stringify(f.logs),/credential-secret|secret-injected/);
  const bad=fixture(s=>{s.profile='other@example.com';});assert.equal(bad.run().stage,'gmail-profile');assert.equal(bad.calls.length,1);
});
test('unknown property failures are sanitized and diagnostic reads only explicit email properties',()=>{
  const f=fixture(),reads=[];
  for(const key of Object.keys(f.values)){
    const value=f.values[key];
    Object.defineProperty(f.values,key,{get(){reads.push(key);return value;}});
  }
  f.run();
  assert.deepEqual(reads.sort(),['CT_VNEXT_EMAIL_DATA_API_URL','CT_VNEXT_EMAIL_INSTANCE','CT_VNEXT_EMAIL_LABEL','CT_VNEXT_EMAIL_MODEL','OPENROUTER_API_KEY'].sort());
  const broken=fixture();
  Object.defineProperty(broken.values,'CT_VNEXT_EMAIL_INSTANCE',{get(){throw new Error('credential-secret private model body');}});
  const result=broken.run();
  assert.equal(result.status,'blocked');assert.equal(result.stage,'persisted-config');
  assert.equal(result.failure.classification,'unclassified-error');assert.equal(broken.calls.length,0);
  assert.doesNotMatch(JSON.stringify(broken.logs),/credential-secret|private model/);
  assert.equal(broken.effects(),0);
});
