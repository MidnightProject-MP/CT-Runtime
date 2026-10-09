import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
const source=readFileSync(new URL('../gas/gas_vnext_email.js',import.meta.url),'utf8');
function fixture(overrides={}){
  const values={OPENROUTER_API_KEY:'test-secret-never-log',CT_GAS_PROOF_MODEL:'openrouter/vendor/exact-approved-model',PRIVATE_UNKNOWN_PROPERTY:'private-value',...overrides};
  const writes=[],logs=[],calls=[],responses={};let profile='midnight.project.mp@gmail.com',rpcFail=false,project='celestan-email',label=true,locked=false,writeMode='normal',readFailure=false,triggerFailure=false,lockFailure=false;
  const noEffect=()=>{throw new Error('forbidden setup effect');};
  const ctx=vm.createContext({console:{log:s=>logs.push(JSON.parse(s))},
    LockService:{getScriptLock:()=>({waitLock(){if(lockFailure)throw new Error('private-oauth lock error');assert.equal(locked,false);locked=true;},releaseLock(){locked=false;}})},
    PropertiesService:{getScriptProperties:()=>({getProperty:k=>values[k]??null,getProperties:()=>{if(readFailure)throw new Error('test-secret-never-log');return {...values};},setProperties(v,remove){assert.equal(locked,true);assert.equal(remove,false);writes.push({...v});if(writeMode==='before')throw new Error('test-secret-never-log');if(writeMode==='partial'){values.CT_VNEXT_EMAIL_ENABLED='false';throw new Error('private-value');}Object.assign(values,v);if(writeMode==='after')throw new Error('private-oauth');},setProperty:noEffect,deleteProperty:noEffect})},
    ScriptApp:{getOAuthToken:()=> 'private-oauth',getIdentityToken:()=> 'private-identity',getProjectTriggers:()=>{if(triggerFailure)throw new Error('private-identity');return [{getHandlerFunction:()=> 'legacySafetyWake'}];},newTrigger:noEffect},
    SpreadsheetApp:new Proxy({},{get:noEffect}),GmailApp:new Proxy({},{get:noEffect}),
    UrlFetchApp:{fetch(url,opts){calls.push(url);let data;
      const suffix=Object.keys(responses).find(s=>url.endsWith(s));if(suffix){const r=responses[suffix];return {getResponseCode:()=>r.status,getContentText:()=>typeof r.body==='string'?r.body:JSON.stringify(r.body)};}
      if(url.endsWith('/profile')){assert.equal(opts.method,'get');data={emailAddress:profile};}
      else if(url.endsWith('/labels')){assert.equal(opts.method,'get');data={labels:label?[{name:'Celestan'}]:[]};}
      else if(url.endsWith('/rpc/gas_email_rpc')){assert.equal(JSON.parse(opts.payload).p_operation,'health');if(rpcFail)throw new Error('test-secret-never-log');data={instance:'gas-vnext-email',project,mailbox:profile,allowed_sender:'midnightprojectantigravity@gmail.com',blocked:false};}
      else throw new Error('unexpected model/inbox/send request');
      return {getResponseCode:()=>200,getContentText:()=>JSON.stringify(data)};
    }}});
  vm.runInContext(source,ctx);assert.equal(calls.length,0);assert.equal(writes.length,0);assert.equal(logs.length,0);
  return {values,writes,logs,calls,run:()=>ctx.prepareVnextEmailRuntime(),diagnose:()=>ctx.diagnoseVnextEmailPreparation(),http:(suffix,status,body)=>{responses[suffix]={status,body};},writeMode:v=>{writeMode=v;},readFailure:()=>{readFailure=true;},triggerFailure:()=>{triggerFailure=true;},lockFailure:()=>{lockFailure=true;},profile:v=>{profile=v;},rpcFail:()=>{rpcFail=true;},project:v=>{project=v;},missingLabel:()=>{label=false;}};
}
test('no-argument preparation pins reviewed bindings, reuses exact model, logs readiness and remains disabled/idempotent',()=>{
  const f=fixture(),r=f.run();assert.equal(r.status,'prepared');assert.equal(r.enabled,false);assert.equal(r.model,'openrouter/vendor/exact-approved-model');assert.equal(r.project,'celestan-email');assert.equal(r.labelPresent,true);assert.equal(r.triggerCount,1);
  assert.equal(f.values.CT_VNEXT_EMAIL_ENABLED,'false');assert.equal(f.values.OPENROUTER_API_KEY,'test-secret-never-log');
  assert.equal(Object.keys(f.writes[0]).length,5);assert.equal(f.writes[0].CT_VNEXT_EMAIL_INSTANCE,'gas-vnext-email');
  assert.equal(r.propertyCounts.total,Object.keys(f.values).length);assert.equal(r.propertyCounts.stable,6);
  assert.doesNotMatch(JSON.stringify(f.logs),/test-secret|private-value|PRIVATE_UNKNOWN_PROPERTY|private-oauth|private-identity/);
  f.values.CT_GAS_PROOF_MODEL='vendor/new-proof-model';assert.equal(f.run().model,r.model,'already configured exact selection wins');assert.equal(f.writes.length,2);
  f.values.CT_VNEXT_EMAIL_ENABLED='true';assert.throws(()=>f.run(),/binding conflict/);assert.equal(f.writes.length,2);assert.equal(f.values.CT_VNEXT_EMAIL_ENABLED,'true');
});
test('preparation never writes on invalid/missing model, identity, conflicting binding, project or RPC failure',()=>{
  const absent=fixture({CT_GAS_PROOF_MODEL:null});assert.throws(()=>absent.run(),/set CT_VNEXT_EMAIL_MODEL/);assert.equal(absent.writes.length,0);
  for(const value of ['', 'not-a-provider-model','vendor/model\n']){const f=fixture({CT_VNEXT_EMAIL_MODEL:value});assert.throws(()=>f.run(),/set CT_VNEXT_EMAIL_MODEL/);assert.equal(f.writes.length,0);}
  const wrong=fixture();wrong.profile('other@example.com');assert.throws(()=>wrong.run(),/wrong execution mailbox/);assert.equal(wrong.writes.length,0);assert.ok(wrong.calls.every(u=>u.endsWith('/profile')||u.endsWith('/rpc/gas_email_rpc')));
  const conflict=fixture({CT_VNEXT_EMAIL_INSTANCE:'another'});assert.throws(()=>conflict.run(),/binding conflict/);assert.equal(conflict.writes.length,0);
  const p=fixture();p.project('another');assert.throws(()=>p.run(),/project mismatch/);assert.equal(p.writes.length,0);
  const unavailable=fixture();unavailable.rpcFail();assert.throws(()=>unavailable.run(),/outcome unavailable/);assert.equal(unavailable.writes.length,0);assert.doesNotMatch(JSON.stringify(unavailable.logs),/test-secret/);
  const missingKey=fixture({OPENROUTER_API_KEY:null});assert.throws(()=>missingKey.run(),/existing OpenRouter secret/);assert.equal(missingKey.writes.length,0);
  const missingLabel=fixture();missingLabel.missingLabel();assert.equal(missingLabel.run().labelPresent,false);assert.equal(missingLabel.writes.length,1);
});
test('read-only diagnostic identifies Gmail service/consent errors without copying provider payloads',()=>{
  for(const reason of ['accessNotConfigured','insufficientPermissions','SERVICE_DISABLED']){
    const f=fixture();f.http('/profile',403,{error:{message:'test-secret-never-log private-oauth',errors:[{reason}],details:[{reason,metadata:{consumer:'secret-project-value'}}]}});
    const d=f.diagnose(),failure=d.stages.find(s=>s.stage==='gmail-profile');assert.equal(d.status,'blocked');assert.equal(d.configWriteAttempted,false);assert.equal(f.writes.length,0);
    assert.equal(failure.httpStatus,403);assert.equal(failure.providerReason,reason);assert.equal(failure.classification,'authorization-denied');
    if(reason==='SERVICE_DISABLED'||reason==='accessNotConfigured')assert.equal(failure.projectNumber,'788761466843');
    assert.ok(d.stages.some(s=>s.stage==='neon-health'&&s.status==='ok'));
    assert.doesNotMatch(JSON.stringify(f.logs),/test-secret|private-oauth|secret-project-value|PRIVATE_UNKNOWN_PROPERTY/);
  }
});
test('Neon HTTP/SQLSTATE, non-JSON 503 and invalid JSON success are diagnosed at their own stages',()=>{
  for(const [suffix,status,body,stage,classification,sql] of [
    ['/rpc/gas_email_rpc',401,{message:'secret JWT text'},'neon-health','authentication-denied',null],
    ['/rpc/gas_email_rpc',403,{code:'42501',message:'private-value'},'neon-health','authorization-denied','42501'],
    ['/labels',503,'<html>private-value</html>','gmail-labels','provider-unavailable',null],
    ['/profile',200,'{broken private-value','gmail-profile','invalid-json',null],
    ['/profile',403,{code:'SECRT',error:{errors:[{reason:'private-value'}],details:'private-oauth'}},'gmail-profile','authorization-denied',null]
  ]){
    const f=fixture();f.http(suffix,status,body);const d=f.diagnose(),e=d.stages.find(s=>s.stage===stage);
    assert.equal(e.classification,classification);assert.equal(e.httpStatus,status);assert.equal(e.sqlState,sql);assert.equal(f.writes.length,0);
    assert.doesNotMatch(JSON.stringify(d),/private-value|private-oauth|secret JWT|SECRT|broken/);
    assert.throws(()=>f.run());assert.equal(f.writes.length,0);assert.equal(f.logs.at(-1).configWriteAttempted,false);
  }
});
test('diagnostic confirms prior completed/partial writes without retrying configuration',()=>{
  const fresh=fixture();const d=fresh.diagnose();assert.equal(d.status,'diagnosed');assert.equal(d.readOnly,true);assert.equal(d.preparedConfigMatch,false);assert.equal(fresh.writes.length,0);
  assert.ok(fresh.calls.every(u=>u.endsWith('/profile')||u.endsWith('/labels')||u.endsWith('/rpc/gas_email_rpc')));
  for(const mode of ['before','partial','after']){
    const f=fixture();f.writeMode(mode);assert.throws(()=>f.run());const failed=f.logs.at(-1);
    assert.equal(failed.configWriteAttempted,true);assert.equal(failed.readbackConfirmed,mode==='after');assert.equal(failed.stages.find(s=>s.stage==='property-write').status,'failed');
    const priorWrites=f.writes.length,inspection=f.diagnose();assert.equal(f.writes.length,priorWrites);assert.equal(inspection.configWriteAttempted,false);assert.equal(inspection.preparedConfigMatch,mode==='after');
    assert.doesNotMatch(JSON.stringify(f.logs),/private-value|private-oauth|test-secret|PRIVATE_UNKNOWN_PROPERTY/);
  }
});
test('missing configuration, property-read, trigger inventory and lock errors stay safe and stage-specific',()=>{
  for(const [set,stage] of [[f=>{f.values.CT_GAS_PROOF_MODEL=null;},'model-config'],[f=>f.readFailure(),'property-read'],[f=>f.triggerFailure(),'trigger-inventory'],[f=>f.lockFailure(),'script-lock']]){
    const f=fixture();set(f);const d=f.diagnose();assert.equal(d.stages.find(s=>s.stage===stage).status,'failed');assert.equal(d.configWriteAttempted,false);assert.equal(f.writes.length,0);
    assert.doesNotMatch(JSON.stringify(d),/test-secret|private-value|private-oauth|private-identity|PRIVATE_UNKNOWN_PROPERTY/);
  }
});
