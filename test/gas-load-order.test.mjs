import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createHash,createHmac } from 'node:crypto';
import { readFile,mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec=promisify(execFile);
const digest=s=>createHash('sha256').update(s).digest('hex');

test('actual production bundle is inert and dispatches identically in independent, reversed, shuffled and hoisted load orders',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'gas-order-'));
  try{
    const out=join(dir,'bundle.json');await exec(process.execPath,['scripts/build-gas-bundle.mjs','gas',out]);
    const bundle=JSON.parse(await readFile(out,'utf8')),files=bundle.files.filter(f=>f.type==='SERVER_JS');
    assert.equal(files.filter(f=>/function doPost\(/.test(f.source)).length,1,'one web entry point, no competing global declarations');
    const shuffled=seed=>{const a=[...files];for(let n=a.length-1;n>0;n--){seed=(seed*1664525+1013904223)>>>0;const j=seed%(n+1);[a[n],a[j]]=[a[j],a[n]];}return a;};
    const orders=[files,[...files].reverse(),shuffled(1),shuffled(43),shuffled(2026)];
    for(const order of orders)for(const concatenate of [false,true]){
      let loading=true,serviceCalls=0,federationCalls=0,nonce=0;
      const values={CT_GAS_DEPLOYMENT_ID:'deployment',CT_GAS_DEPLOY_HMAC_SECRET:'test-deploy-secret'},logs=[];
      const guard=()=>{assert.equal(loading,false,'no service calls during global initialization');serviceCalls++;};
      const forbidden=new Proxy({},{get(){guard();throw new Error('unexpected effect');}});
      const contentFiles=[{name:'appsscript',type:'JSON',source:'{}'},{name:'main',type:'SERVER_JS',source:'function example(){}'}];
      const ctx=vm.createContext({console:{log:s=>{guard();logs.push(JSON.parse(s));}},
        PropertiesService:{getScriptProperties(){guard();return {getProperty:k=>values[k]??null,getProperties:()=>({...values}),setProperty:(k,v)=>{values[k]=v;},deleteProperty:k=>{delete values[k];}};}},
        ScriptApp:{getScriptId(){guard();return 'script';},getOAuthToken(){guard();return 'test-oauth';},getIdentityToken(){guard();return 'header.'+Buffer.from(JSON.stringify({sub:'owner-sub',aud:'google-aud'})).toString('base64url')+'.signature';}},
        LockService:{getScriptLock(){guard();return {waitLock(){},releaseLock(){}};}},
        SpreadsheetApp:forbidden,DriveApp:forbidden,GmailApp:forbidden,
        Utilities:{Charset:{UTF_8:'UTF-8'},DigestAlgorithm:{SHA_256:'sha256'},getUuid(){guard();return 'uuid';},
          newBlob(v){guard();return {getBytes:()=>[...Buffer.from(v)],getDataAsString:()=>Buffer.from(v).toString()};},
          base64DecodeWebSafe(v){guard();return Buffer.from(v,'base64url');},
          computeDigest(_,v){guard();return [...createHash('sha256').update(v).digest()];},
          computeHmacSha256Signature(v,k){guard();return [...createHmac('sha256',k).update(v).digest()];}},
        UrlFetchApp:{fetch(url,opts){guard();assert.ok(!opts.method||opts.method.toLowerCase()==='get','qualification must be read-only');assert.match(url,/\/projects\/script\/content/);return {getResponseCode:()=>200,getContentText:()=>JSON.stringify({files:contentFiles})};}},
        ContentService:{MimeType:{JSON:'json'},createTextOutput(text){guard();return {getContent:()=>text,setMimeType(){return this;}};}}
      });
      if(concatenate)vm.runInContext(order.map(f=>f.source).join('\n;\n'),ctx);
      else for(const f of order)vm.runInContext(f.source,ctx,{filename:f.name});
      assert.equal(serviceCalls,0);loading=false;
      assert.throws(()=>ctx.inspectFederationIdentity(),/FEDERATION_IDENTITY.*google-aud.*owner-sub/);
      const call=(operation,overrides={},badSignature=false)=>{
        const req={operation,script_id:'script',deployment_id:'deployment',correlation_id:'correlated',...overrides},raw=JSON.stringify(req),timestamp=String(Math.floor(Date.now()/1000)),n='nonce-'+(++nonce);
        const signed=[operation,timestamp,n,req.deployment_request_id||'',req.script_id,req.deployment_id,req.commit_sha||'',req.github_bundle_hash||'',digest(raw)].join('\n');
        const signature=badSignature?'invalid':createHmac('sha256','test-deploy-secret').update(signed).digest('hex');
        return JSON.parse(ctx.doPost({postData:{contents:raw},parameter:{timestamp,nonce:n,signature}}).getContent());
      };
      ctx.CT_GAS_FEDERATION.verify=()=>{federationCalls++;return {};};
      ctx.CT_GAS_FEDERATION.consume=()=>({status:'federation-ok'});
      ctx.CT_GAS_FEDERATION.ingest=()=>({status:'evidence-ok'});
      const q=call('self-deploy-qualify',{files:contentFiles});
      assert.equal(q.status,'qualified');assert.equal(q.desiredBundleHash,digest(JSON.stringify(contentFiles)));
      assert.equal(q.diagnostic_id,'correlated');assert.equal(federationCalls,0);
      assert.ok(logs.some(l=>l.stage==='received'));assert.ok(logs.some(l=>l.stage==='authenticated'));
      assert.equal(call('self-deploy-qualify',{},true).status,'rejected');assert.equal(federationCalls,0);
      assert.equal(call('self-deploy-qualify',{deployment_id:'wrong'}).reason,'deploy-deployment-id-mismatch');
      assert.ok(logs.some(l=>l.stage==='rejected'));
      ctx.quiesceLegacyAutonomy=()=>({status:'LEGACY_QUIESCED'});ctx.assertLegacyQuiesced=()=>({status:'LEGACY_QUIESCED'});
      ctx.CT_GAS_DEPLOY.deploy=()=>({status:'deploy-route'});ctx.CT_GAS_DEPLOY.plan=()=>({status:'plan-route'});
      assert.equal(call('self-deploy').status,'deploy-route');assert.equal(call('self-deploy-plan').status,'plan-route');
      assert.equal(call('quiesce-legacy-autonomy').status,'LEGACY_QUIESCED');assert.equal(call('assert-legacy-quiesced').status,'LEGACY_QUIESCED');
      assert.equal(call('arm-vnext-cutover').status,'VNEXT_ARMED');assert.equal(values.CT_AUTONOMY_MODE,'vnext');assert.equal(federationCalls,0);
      assert.equal(call('advisory').status,'federation-ok');assert.equal(call('evidence-ingest').status,'evidence-ok');assert.equal(federationCalls,2);
      const malformed=JSON.parse(ctx.doPost({postData:{contents:'{invalid'},parameter:{}}).getContent());assert.equal(malformed.status,'rejected');
      assert.doesNotMatch(JSON.stringify(logs),/test-deploy-secret|test-oauth/);
      // Missing required modules must fail visibly at invocation, not silently
      // drop qualification/tracing or choose another dispatch path.
      const trace=ctx.CT_GAS_AUTH_TRACE;ctx.CT_GAS_AUTH_TRACE=undefined;assert.throws(()=>ctx.doPost({}));ctx.CT_GAS_AUTH_TRACE=trace;
      ctx.CT_GAS_DEPLOY_QUALIFY=undefined;assert.equal(call('self-deploy-qualify',{files:contentFiles}).status,'rejected');
    }
  }finally{await rm(dir,{recursive:true,force:true});}
});
