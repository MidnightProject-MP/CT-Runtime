import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
const source=['gas_vnext_email.js','gas_vnext_email_owner.js'].map(f=>readFileSync(new URL('../gas/'+f,import.meta.url),'utf8')).join('\n');
function run(response,status=200,advance=0,claimDelay=0){
 const logs=[],calls=[];let now=0;
 const values={CT_VNEXT_EMAIL_ENABLED:'true',CT_VNEXT_EMAIL_INSTANCE:'test',CT_VNEXT_EMAIL_DATA_API_URL:'https://test.neon.tech',CT_VNEXT_EMAIL_APPROVED_DATA_API_HOST:'test.neon.tech',CT_VNEXT_EMAIL_APPROVED_SCRIPT_ID:'test-script',CT_VNEXT_EMAIL_APPROVED_MAILBOX:'midnight.project.mp@gmail.com',CT_VNEXT_EMAIL_APPROVED_SENDER:'midnightprojectantigravity@gmail.com',CT_VNEXT_EMAIL_MODEL:'nvidia/nemotron-3-nano-30b-a3b:free',CT_VNEXT_EMAIL_LABEL:'Celestan',OPENROUTER_API_KEY:'SECRET'};
 const ctx=vm.createContext({console:{log:x=>logs.push(x)},Date:class extends Date{static now(){return now;}},PropertiesService:{getScriptProperties:()=>({getProperty:k=>values[k]})},LockService:{getScriptLock:()=>({tryLock:()=>true,releaseLock(){}})},ScriptApp:{getIdentityToken:()=> 'jwt',getOAuthToken:()=> 'oauth'},UrlFetchApp:{fetch:(url,options)=>{
  let data,code=200;
  if(url.includes('openrouter.ai')){data=response;code=status;now+=advance;const p=JSON.parse(options.payload);assert.equal(p.model,values.CT_VNEXT_EMAIL_MODEL);assert.equal(p.max_tokens,2500);}
  else if(url.includes('/rpc/')){const p=JSON.parse(options.payload);calls.push(p);if(p.p_operation==='claim')now+=claimDelay;data=p.p_operation==='health'?{mailbox:'midnight.project.mp@gmail.com',allowed_sender:'midnightprojectantigravity@gmail.com'}:p.p_operation==='claim'?{status:'claimed',execution_id:'test',fence:1,inputs:[]}:p.p_operation==='delivery-peek'?{status:'idle'}:{status:'settled'};}
  else data=url.endsWith('profile')?{emailAddress:'midnight.project.mp@gmail.com'}:url.endsWith('labels')?{labels:[{name:'Celestan',id:'label'}]}:{messages:[]};
  return {getResponseCode:()=>code,getContentText:()=>JSON.stringify(data)};
 }}});vm.runInContext(source,ctx);const result=ctx.vnextEmailTick();return {result,calls,logs};
}
const choice=(content,finish_reason='stop')=>({choices:[{finish_reason,message:{content}}]});
test('bounded taxonomy, transport preservation and no raw failure data',()=>{
 for(const [response,status,code,classification] of [
  [{error:{message:'SECRET'}},429,null,'rate-limited'],[{error:{message:'SECRET'}},500,null,'provider-unavailable'],
  [{error:{message:'SECRET'}},200,'embedded-provider-error'],[{},200,'missing-choice'],[choice(null),200,'missing-content'],[choice('  '),200,'empty-content'],[choice('SECRET','length'),200,'truncated'],[choice('SECRET','content_filter'),200,'content-filter'],[choice('SECRET'),200,'non-json'],[choice('{}'),200,'malformed-contract'],[choice(JSON.stringify({disposition:'done',summary:'x'.repeat(4001)})),200,'field-bounds'],[choice(JSON.stringify({disposition:'done',summary:'漢'.repeat(4000),artifact:'漢'.repeat(3000)})),200,'utf8-byte-bounds'],[choice(JSON.stringify({disposition:'done',summary:'\ud800'})),200,'invalid-text'],[choice(JSON.stringify({disposition:'done',summary:'ok',unknown:'SECRET'})),200,'malformed-contract']]){
  const r=run(response,status);assert.equal(r.result.status,'model-failed');assert.equal(r.result.failure.classification,classification||'model-validation');if(code)assert.equal(r.result.failure.code,code);
  assert.deepEqual(r.calls.find(p=>p.p_operation==='failure').p_input.diagnostics,JSON.parse(JSON.stringify(r.result.failure)));
  assert.equal(r.logs.join('').includes('SECRET'),false);assert.equal(r.calls.some(p=>p.p_operation==='checkpoint'),false);
 }
 assert.equal(run(choice('{}'),200,300000).result.failure.code,'budget-after');
 assert.equal(run(choice('{}'),200,0,200000).result.failure.code,'budget-before');
});
test('only a whole JSON fence is tolerated; strict schema remains',()=>{
 const turn={disposition:'done',summary:'A useful answer'};
 assert.ok(run(choice('```json\n'+JSON.stringify(turn)+'\n```')).calls.some(p=>p.p_operation==='checkpoint'));
 assert.equal(run(choice('prefix '+JSON.stringify(turn))).result.failure.code,'non-json');
});
