import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
const source=readFileSync(new URL('../gas/gas_vnext_email.js',import.meta.url),'utf8');
function fixture(overrides={}){
  const values={OPENROUTER_API_KEY:'test-secret-never-log',CT_GAS_PROOF_MODEL:'openrouter/vendor/exact-approved-model',PRIVATE_UNKNOWN_PROPERTY:'private-value',...overrides};
  const writes=[],logs=[],calls=[];let profile='midnight.project.mp@gmail.com',rpcFail=false,project='celestan-email',label=true,locked=false;
  const noEffect=()=>{throw new Error('forbidden setup effect');};
  const ctx=vm.createContext({console:{log:s=>logs.push(JSON.parse(s))},
    LockService:{getScriptLock:()=>({waitLock(){assert.equal(locked,false);locked=true;},releaseLock(){locked=false;}})},
    PropertiesService:{getScriptProperties:()=>({getProperty:k=>values[k]??null,getProperties:()=>({...values}),setProperties(v,remove){assert.equal(locked,true);assert.equal(remove,false);writes.push({...v});Object.assign(values,v);},setProperty:noEffect,deleteProperty:noEffect})},
    ScriptApp:{getOAuthToken:()=> 'private-oauth',getIdentityToken:()=> 'private-identity',getProjectTriggers:()=>[{getHandlerFunction:()=> 'legacySafetyWake'}],newTrigger:noEffect},
    SpreadsheetApp:new Proxy({},{get:noEffect}),GmailApp:new Proxy({},{get:noEffect}),
    UrlFetchApp:{fetch(url,opts){calls.push(url);let data;
      if(url.endsWith('/profile')){assert.equal(opts.method,'get');data={emailAddress:profile};}
      else if(url.endsWith('/labels')){assert.equal(opts.method,'get');data={labels:label?[{name:'Celestan'}]:[]};}
      else if(url.endsWith('/rpc/gas_email_rpc')){assert.equal(JSON.parse(opts.payload).p_operation,'health');if(rpcFail)throw new Error('test-secret-never-log');data={instance:'gas-vnext-email',project,mailbox:profile,allowed_sender:'midnightprojectantigravity@gmail.com',blocked:false};}
      else throw new Error('unexpected model/inbox/send request');
      return {getResponseCode:()=>200,getContentText:()=>JSON.stringify(data)};
    }}});
  vm.runInContext(source,ctx);assert.equal(calls.length,0);assert.equal(writes.length,0);assert.equal(logs.length,0);
  return {values,writes,logs,calls,run:()=>ctx.prepareVnextEmailRuntime(),profile:v=>{profile=v;},rpcFail:()=>{rpcFail=true;},project:v=>{project=v;},missingLabel:()=>{label=false;}};
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
  const wrong=fixture();wrong.profile('other@example.com');assert.throws(()=>wrong.run(),/wrong execution mailbox/);assert.equal(wrong.writes.length,0);assert.equal(wrong.calls.length,1);
  const conflict=fixture({CT_VNEXT_EMAIL_INSTANCE:'another'});assert.throws(()=>conflict.run(),/binding conflict/);assert.equal(conflict.writes.length,0);
  const p=fixture();p.project('another');assert.throws(()=>p.run(),/project mismatch/);assert.equal(p.writes.length,0);
  const unavailable=fixture();unavailable.rpcFail();assert.throws(()=>unavailable.run(),/outcome unavailable/);assert.equal(unavailable.writes.length,0);assert.doesNotMatch(JSON.stringify(unavailable.logs),/test-secret/);
  const missingKey=fixture({OPENROUTER_API_KEY:null});assert.throws(()=>missingKey.run(),/existing OpenRouter secret/);assert.equal(missingKey.writes.length,0);
  const missingLabel=fixture();missingLabel.missingLabel();assert.equal(missingLabel.run().labelPresent,false);assert.equal(missingLabel.writes.length,1);
});
