import test from 'node:test';
import assert from 'node:assert/strict';
import { gasEmailFixture } from './gas-email-fixture.mjs';

test('RPC independently binds actual script and explicit HTTPS host before acquiring identity or fetching',()=>{
  for(const bad of ['script','missing-script','missing-host','host','http','auth','query','fragment','backslash','newline']){
    const f=gasEmailFixture(()=>{throw new Error('unexpected RPC');}),ctx=f.cold();
    let tokens=0,requests=0;
    ctx.ScriptApp.getIdentityToken=()=>{tokens++;return 'PRIVATE_TOKEN';};
    ctx.UrlFetchApp.fetch=()=>{requests++;throw new Error('PRIVATE_RESPONSE');};
    const c={url:'https://test.neon.tech',instance:'gas-test',approvedScriptId:'test-script'};
    if(bad==='script')ctx.ScriptApp.getScriptId=()=> 'wrong-script';
    if(bad==='missing-script')delete f.values.CT_VNEXT_EMAIL_APPROVED_SCRIPT_ID;
    if(bad==='missing-host')delete f.values.CT_VNEXT_EMAIL_APPROVED_DATA_API_HOST;
    const urls={host:'https://wrong.example',http:'http://test.neon.tech',auth:'https://user@test.neon.tech',query:'https://test.neon.tech/path?q=x',fragment:'https://test.neon.tech/#x',backslash:'https://test.neon.tech/\\wrong',newline:'https://test.neon.tech/\n'};
    if(urls[bad])c.url=urls[bad];
    assert.throws(()=>ctx.CT_GAS_VNEXT_EMAIL.owner.rpc(c,'health'),/email target not approved/,bad);
    assert.equal(tokens,0,bad);assert.equal(requests,0,bad);
  }
});

test('validated read-only health needs neither Gmail nor model credentials and never follows redirects',()=>{
  const f=gasEmailFixture(()=>({status:'healthy'}));
  delete f.values.OPENROUTER_API_KEY;delete f.values.CT_VNEXT_EMAIL_MODEL;delete f.values.CT_VNEXT_EMAIL_APPROVED_MAILBOX;
  const ctx=f.cold();let tokens=0,requests=0;
  ctx.ScriptApp.getIdentityToken=()=>{tokens++;return 'PRIVATE_TOKEN';};
  ctx.ScriptApp.getOAuthToken=()=>{throw new Error('Gmail is unrelated');};
  ctx.UrlFetchApp.fetch=(url,opts)=>{requests++;assert.equal(url,'https://test.neon.tech/rpc/gas_email_rpc');assert.equal(opts.followRedirects,false);return {getResponseCode:()=>403,getContentText:()=>JSON.stringify({code:'42501',message:'PRIVATE_RESPONSE',error:{errors:[{reason:'PRIVATE_REASON'}]}})};};
  try{ctx.CT_GAS_VNEXT_EMAIL.owner.rpc({url:'https://test.neon.tech',instance:'gas-test'},'health');assert.fail('must reject');}
  catch(e){const safe=ctx.CT_GAS_VNEXT_EMAIL.owner.safeFailure(e);assert.equal(safe.classification,'authorization-denied');assert.equal(safe.sqlState,'42501');assert.doesNotMatch(JSON.stringify(safe),/PRIVATE/);}
  assert.equal(tokens,1);assert.equal(requests,1);
});
