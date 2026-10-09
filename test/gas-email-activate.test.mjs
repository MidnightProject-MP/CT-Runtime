import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
const script='1Uzv-r4UW-y9XLuO-f3QEvrwzInGu1JarmqecVtwarJor6Z5qpmUD2dri';
function fixture(){
  const values={CT_VNEXT_EMAIL_ENABLED:'false',CT_VNEXT_EMAIL_INSTANCE:'gas-vnext-email',CT_VNEXT_EMAIL_DATA_API_URL:'https://ep-weathered-tree-b4v72i6c.apirest.c-6.us-east-2.aws.neon.tech/neondb/rest/v1',CT_VNEXT_EMAIL_MODEL:'openrouter/nvidia/nemotron-3-ultra-550b-a55b:free',CT_VNEXT_EMAIL_LABEL:'Celestan',OPENROUTER_API_KEY:'private-test-secret',CT_GAS_SAFETY_TRIGGER:'present',UNRELATED_PROPERTY:'preserve'};
  const effects=[],logs=[],calls=[];let locked=false,load=true,labels=true,mailbox='midnight.project.mp@gmail.com',scriptId=script,createMode='ok',deleteFails=false,blocked=false,writeFault=null;
  const t=name=>({getHandlerFunction:()=>name});let triggers=[t('gasSafetyWake')];
  function read(k){assert.equal(load,false);calls.push('property:'+k);return values[k]??null;}
  const forbidden=()=>{throw new Error('unexpected mail/model/Sheets effect');};
  const ctx=vm.createContext({console:{log:s=>logs.push(JSON.parse(s))},
    PropertiesService:{getScriptProperties:()=>({getProperty:read,setProperty(k,v){assert.equal(locked,true);effects.push(['set',k,v]);values[k]=v;if(writeFault===k){writeFault=null;throw new Error('private-write-response');}},deleteProperty(k){assert.equal(locked,true);effects.push(['delete-property',k]);delete values[k];}})},
    ScriptApp:{getScriptId:()=>{assert.equal(load,false);calls.push('script-id');return scriptId;},getOAuthToken:()=> 'private-oauth',getIdentityToken:()=> 'private-token',getProjectTriggers:()=>triggers.slice(),deleteTrigger(x){assert.equal(locked,true);effects.push(['delete-trigger',x.getHandlerFunction()]);if(deleteFails)throw new Error('private-error');triggers=triggers.filter(t=>t!==x);},newTrigger(name){assert.equal(locked,true);return {timeBased(){return this;},everyMinutes(n){assert.equal(n,5);return this;},create(){assert.equal(values.CT_VNEXT_EMAIL_ENABLED,'false','never create while polling enabled');effects.push(['create-trigger',name]);if(createMode==='before')throw new Error('private-error');triggers.push(t(name));if(createMode==='duplicate')triggers.push(t(name));if(createMode==='after')throw new Error('private-error');}};}},
    LockService:{getScriptLock:()=>({waitLock(){assert.equal(locked,false);locked=true;},releaseLock(){locked=false;}})},
    SpreadsheetApp:new Proxy({},{get:forbidden}),GmailApp:new Proxy({},{get:forbidden}),
    UrlFetchApp:{fetch(url,opts){calls.push(url);let data;
      if(url.endsWith('/profile'))data={emailAddress:mailbox};
      else if(url.endsWith('/labels'))data={labels:labels?[{name:'Celestan'}]:[]};
      else if(url.endsWith('/rpc/gas_email_rpc')){assert.equal(JSON.parse(opts.payload).p_operation,'health');data={instance:'gas-vnext-email',project:'celestan-email',mailbox:'midnight.project.mp@gmail.com',allowed_sender:'midnightprojectantigravity@gmail.com',grant_ref:'user-authorized:pr69:gas-text-only:v1',blocked,uncertain:0};}
      else forbidden();return {getResponseCode:()=>200,getContentText:()=>JSON.stringify(data)};
    }}});
  // Actual legacy read-only diagnostic and retirement function, not a stub.
  for(const f of ['gas_trigger.js','gas_vnext_email.js'])vm.runInContext(readFileSync(new URL('../gas/'+f,import.meta.url),'utf8'),ctx);
  assert.equal(effects.length,0);assert.equal(calls.length,0);load=false;
  return {values,effects,logs,calls,run:()=>ctx.activateVnextEmailRuntime(),pause:()=>ctx.pauseVnextEmailRuntime(),legacy:()=>ctx.gasSafetyWake(),labels:v=>{labels=v;},mailbox:v=>{mailbox=v;},script:v=>{scriptId=v;},handlers:names=>{triggers=names.map(t);},createMode:v=>{createMode=v;},writeFault:k=>{writeFault=k;},deleteFailure:()=>{deleteFails=true;},block:()=>{blocked=true;},handlersNow:()=>triggers.map(t=>t.getHandlerFunction())};
}
test('owner activation retires exact legacy future wake and creates one five-minute email trigger idempotently',()=>{
  const f=fixture(),r=f.run();assert.equal(r.status,'active');assert.equal(r.enabled,true);assert.equal(r.retiredLegacyCount,1);assert.equal(r.inFlightLegacyCancelled,false);
  assert.deepEqual(f.handlersNow(),['vnextEmailTick']);assert.equal(f.values.CT_AUTONOMY_MODE,'vnext');assert.equal(f.values.CT_GAS_SAFETY_TRIGGER,undefined);assert.equal(f.values.UNRELATED_PROPERTY,'preserve');
  assert.ok(f.calls.indexOf('property:CT_GAS_FEEDBACK_SPREADSHEET_ID')<f.calls.findIndex(x=>x.endsWith('/profile')));
  assert.equal(f.legacy()[0].status,'RETIRED_VNEXT');assert.equal(f.run().status,'active');assert.equal(f.effects.filter(x=>x[0]==='create-trigger').length,1);
  assert.ok(f.effects.filter(x=>x[0]==='set').every(x=>['CT_AUTONOMY_MODE','CT_VNEXT_EMAIL_ENABLED'].includes(x[1])));
  assert.equal(f.pause().enabled,false);assert.equal(f.values.CT_VNEXT_EMAIL_ENABLED,'false');assert.deepEqual(f.handlersNow(),['vnextEmailTick']);
  assert.doesNotMatch(JSON.stringify(f.logs),/private-test-secret|private-token|private-oauth/);
});
test('all readiness failures precede any mutation including missing label and unexpected/duplicate handlers',()=>{
  for(const change of [f=>f.labels(false),f=>f.mailbox('other@example.com'),f=>f.script('wrong'),f=>f.handlers(['gasSafetyWake','unknownWake']),f=>f.handlers(['vnextEmailTick','vnextEmailTick']),f=>f.handlers(['gasSafetyWake','gasSafetyWake']),f=>f.block(),f=>{f.values.CT_VNEXT_EMAIL_INSTANCE='other';}]){
    const f=fixture();change(f);assert.equal(f.run().status,'blocked');assert.equal(f.effects.length,0);assert.equal(f.values.CT_VNEXT_EMAIL_ENABLED,'false');
  }
});
test('ambiguous create reconciles one visible trigger or disables without retry; failed retirement preserves marker',()=>{
  const recovered=fixture();recovered.createMode('after');assert.equal(recovered.run().status,'active');assert.equal(recovered.effects.filter(x=>x[0]==='create-trigger').length,1);
  for(const mode of ['before','duplicate']){const f=fixture();f.createMode(mode);const r=f.run();assert.equal(r.status,'blocked');assert.equal(r.disabledConfirmed,true);assert.equal(f.values.CT_VNEXT_EMAIL_ENABLED,'false');assert.equal(f.effects.filter(x=>x[0]==='create-trigger').length,1);assert.doesNotMatch(JSON.stringify(f.logs),/private-error/);}
  const f=fixture();f.deleteFailure();assert.equal(f.run().status,'blocked');assert.equal(f.values.CT_GAS_SAFETY_TRIGGER,'present');assert.equal(f.values.CT_VNEXT_EMAIL_ENABLED,'false');assert.equal(f.effects.filter(x=>x[0]==='create-trigger').length,0);
  for(const key of ['CT_AUTONOMY_MODE','CT_VNEXT_EMAIL_ENABLED']){const failed=fixture();failed.writeFault(key);const r=failed.run();assert.equal(r.status,'blocked');assert.equal(r.disabledConfirmed,true);assert.equal(failed.values.CT_VNEXT_EMAIL_ENABLED,'false');assert.equal(failed.effects.filter(x=>x[0]==='create-trigger').length,key==='CT_AUTONOMY_MODE'?0:1);assert.doesNotMatch(JSON.stringify(failed.logs),/private-write-response/);}
});
