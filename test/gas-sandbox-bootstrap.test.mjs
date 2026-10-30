import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { authorizeBootstrap,bootstrap,googleClient,reserveRequest } from '../scripts/bootstrap-gas-sandbox.mjs';
import { bundleHash } from '../lib/gas-deploy-contract.mjs';
import { PRODUCTION_SCRIPT_ID } from '../lib/gas-targets.mjs';

const commit='a'.repeat(40),ref='refs/tags/gas-sandbox-release/bootstrap-test';
const files=[{name:'appsscript',type:'JSON',source:JSON.stringify({runtimeVersion:'V8',webapp:{executeAs:'USER_DEPLOYING',access:'ANYONE_ANONYMOUS'}})},{name:'handler',type:'SERVER_JS',source:'function doPost() {}'}];
const hash=bundleHash(files),scriptId='sandbox-script-1234567890',deploymentId='sandbox-deployment-1234567890';
const base={GITHUB_REPOSITORY:'MidnightProject-MP/CT-Runtime',GITHUB_EVENT_NAME:'workflow_dispatch',GITHUB_SHA:commit,GITHUB_REF:ref,RELEASE_COMMIT:commit,RELEASE_REF:ref,DESIRED_BUNDLE_HASH:hash,BOOTSTRAP_REQUEST_ID:'first-sandbox',BOOTSTRAP_MODE:'create',GITHUB_RUN_ATTEMPT:'1',GAS_SANDBOX_OWNER_EMAIL:'sandbox@example.com',BOOTSTRAP_APPROVED:`${ref}:${commit}:${hash}:first-sandbox:sandbox@example.com`};
const resolveRef=()=>commit;
function fixture({failure,existing=false,production=false,wrongHash=false,claimed=false,owner='sandbox@example.com',initialContent=[],incomplete=false,wrongDeployment=false,unsafeUrl=false}={}){
  const calls=[],reports=[];let content=initialContent,reserved=claimed;
  const deployment={deploymentId,deploymentConfig:{scriptId,versionNumber:1},entryPoints:[{entryPointType:'WEB_APP',webApp:{url:`https://script.google.com/macros/s/${deploymentId}/exec`}}]};
  const api=async(service,method,path,body)=>{
    calls.push({service,method,path,body});
    if(failure===method+' '+path)throw new Error('PRIVATE_PROVIDER_RESPONSE');
    if(service==='drive')return path.startsWith('/about')?{user:{emailAddress:owner}}:{files:existing?[{id:scriptId,name:'CT-Runtime GAS Sandbox'}]:[],incompleteSearch:incomplete};
    if(method==='POST'&&path==='/projects')return {scriptId:production?PRODUCTION_SCRIPT_ID:scriptId,title:'CT-Runtime GAS Sandbox'};
    if(method==='PUT'){content=body.files;return {scriptId,files:content};}
    if(method==='POST'&&path.endsWith('/versions'))return {scriptId,versionNumber:1};
    if(path.endsWith('/deployments?pageSize=100'))return {deployments:existing?[deployment]:[]};
    if(path.includes('/deployments')){
      if(method==='GET'&&wrongDeployment)return {...deployment,deploymentConfig:{scriptId,versionNumber:2}};
      if(method==='GET'&&unsafeUrl)return {...deployment,entryPoints:[{entryPointType:'WEB_APP',webApp:{url:`https://script.google.com/macros/s/${deploymentId}/exec?token=PRIVATE_TOKEN`}}]};
      return deployment;
    }
    if(path.includes('/content'))return {scriptId,files:wrongHash&&content.length?[files[0]]:existing?files:content};
    throw new Error('unexpected fake route');
  };
  const claim=async()=>{calls.push({service:'github',method:'POST',path:'reservation'});if(reserved)throw new Error('used');reserved=true;};
  return {calls,reports,run:env=>bootstrap({...base,...env},files,{api,claim,resolveRef,report:r=>reports.push(r)})};
}

test('bootstrap binds exact repository, dispatch, tag, source, hash and approval; reruns cannot write',()=>{
  assert.equal(authorizeBootstrap(base,files,resolveRef).hash,hash);
  for(const mutation of [
    {GITHUB_REPOSITORY:'other/repo'},{GITHUB_EVENT_NAME:'push'},{GITHUB_REF:'refs/heads/main'},
    {RELEASE_COMMIT:'b'.repeat(40)},{RELEASE_REF:ref+'-other'},{DESIRED_BUNDLE_HASH:'b'.repeat(64)},
    {BOOTSTRAP_APPROVED:''},{BOOTSTRAP_REQUEST_ID:'../escape'},{BOOTSTRAP_MODE:'deploy'},{GITHUB_RUN_ATTEMPT:'2'},{GAS_SANDBOX_OWNER_EMAIL:'other@example.com'}
  ])assert.throws(()=>authorizeBootstrap({...base,...mutation},files,resolveRef));
  assert.throws(()=>authorizeBootstrap(base,files,()=> 'b'.repeat(40)));
});

test('creation reserves request first, installs only in new project and independently reads HEAD/version/deployment',async()=>{
  const f=fixture();await f.run();
  assert.equal(f.calls[0].service,'drive');
  const writes=f.calls.filter(c=>c.method!=='GET');
  assert.deepEqual(writes.map(c=>[c.service,c.method,c.path]),[
    ['github','POST','reservation'],['script','POST','/projects'],['script','PUT',`/projects/${scriptId}/content`],
    ['script','POST',`/projects/${scriptId}/versions`],['script','POST',`/projects/${scriptId}/deployments`]
  ]);
  const result=f.reports.at(-1);assert.equal(result.status,'installed-owner-setup-required');assert.equal(result.headBundleHash,hash);assert.equal(result.liveBundleHash,hash);
  assert.ok(f.calls.some(c=>c.path.endsWith('/content?versionNumber=1')));
  assert.equal(f.calls.at(-1).path,`/projects/${scriptId}/content`);
  assert.doesNotMatch(JSON.stringify(writes),/HMAC|setProperty|trigger/);
});

test('inspect is Google GET-only and does not reserve a request or require creation approval',async()=>{
  const f=fixture({existing:true});await f.run({BOOTSTRAP_MODE:'inspect',BOOTSTRAP_APPROVED:'',GITHUB_RUN_ATTEMPT:'2'});
  assert.ok(f.calls.every(c=>c.method==='GET'));assert.equal(f.reports.at(-1).headBundleHash,hash);assert.equal(f.reports.at(-1).deployments[0].liveBundleHash,hash);
});

test('existing sandbox and consumed reservation prevent all Google writes',async()=>{
  for(const options of [{existing:true},{claimed:true},{owner:'wrong@example.com'}]){
    const f=fixture(options);await assert.rejects(f.run(),/sandbox-bootstrap-stopped/);
    assert.equal(f.calls.filter(c=>c.service==='script'&&c.method!=='GET').length,0);
  }
});

test('production identity and mismatched installed content stop before further writes',async()=>{
  const production=fixture({production:true});await assert.rejects(production.run(),/project-create/);
  assert.equal(production.calls.filter(c=>c.service==='script').length,1);
  const drift=fixture({wrongHash:true});await assert.rejects(drift.run(),/content-readback/);
  assert.equal(drift.calls.filter(c=>c.path.endsWith('/versions')).length,0);
});

test('lost response at every mutation stops without retry and reports only sanitized stage metadata',async()=>{
  for(const path of ['/projects',`/projects/${scriptId}/content`,`/projects/${scriptId}/versions`,`/projects/${scriptId}/deployments`]){
    const method=path.endsWith('/content')?'PUT':'POST',f=fixture({failure:method+' '+path});
    await assert.rejects(f.run(),/sandbox-bootstrap-stopped/);
    assert.equal(f.calls.filter(c=>c.method===method&&c.path===path).length,1);
    assert.equal(f.calls.at(-1).path,path);assert.equal(f.reports.at(-1).status,'stopped');
    assert.doesNotMatch(JSON.stringify(f.reports),/PRIVATE_PROVIDER_RESPONSE/);
  }
});

test('incomplete discovery and nonempty new project cannot authorize an overwrite',async()=>{
  const incomplete=fixture({incomplete:true});await assert.rejects(incomplete.run(),/inventory/);
  assert.ok(incomplete.calls.every(c=>c.method==='GET'));
  const nonempty=fixture({initialContent:files});await assert.rejects(nonempty.run(),/empty-project-readback/);
  assert.ok(nonempty.calls.every(c=>c.method!=='PUT'));
});

test('final deployment mismatch or unexpected URL never reports success or leaks URL parameters',async()=>{
  for(const options of [{wrongDeployment:true},{unsafeUrl:true}]){
    const f=fixture(options);await assert.rejects(f.run(),/final-readback/);
    assert.ok(f.reports.every(r=>r.status!=='installed-owner-setup-required'));
    assert.doesNotMatch(JSON.stringify(f.reports),/PRIVATE_TOKEN/);
    assert.equal(f.calls.filter(c=>c.method==='POST'&&c.path.endsWith('/deployments')).length,1);
  }
});

test('OAuth client refuses redirects and never retries or prints response bodies',async()=>{
  const requests=[];
  const raw=JSON.stringify({tokens:{default:{client_id:'client',client_secret:'secret',refresh_token:'refresh'}}});
  const api=await googleClient(raw,async(url,options)=>{
    requests.push({url,options});assert.equal(options.redirect,'error');
    return url.includes('oauth2')?{ok:true,json:async()=>({access_token:'access-secret'})}:{ok:false,text:async()=> 'PRIVATE_PROVIDER_RESPONSE'};
  });
  await assert.rejects(api('script','POST','/projects',{title:'sandbox'}),/^Error: google-api-unavailable$/);
  assert.equal(requests.length,2);assert.equal(requests[1].options.headers.Authorization,'Bearer access-secret');
});

test('request reservation is create-only and ambiguous/existing outcomes cannot authorize Google writes',async()=>{
  const binding=authorizeBootstrap(base,files,resolveRef);let calls=0;
  await reserveRequest(binding,'secret',async(url,options)=>{
    calls++;assert.equal(options.method,'POST');assert.equal(options.redirect,'error');
    const body=JSON.parse(options.body);assert.equal(body.ref,'refs/tags/gas-sandbox-bootstrap-used/first-sandbox');
    return {status:201,json:async()=>({ref:body.ref,object:{sha:commit}})};
  });
  assert.equal(calls,1);
  await assert.rejects(reserveRequest(binding,'secret',async()=>({status:422})),/request-reservation-unavailable/);
  await assert.rejects(reserveRequest(binding,'secret',async()=>{throw new Error('timeout');}),/timeout/);
});

test('bootstrap workflow is manual, isolated, serialized with sandbox self-deploy and contains no clasp path',async()=>{
  const workflow=await readFile(new URL('../.github/workflows/gas-sandbox-bootstrap.yml',import.meta.url),'utf8');
  assert.match(workflow,/workflow_dispatch:/);assert.doesNotMatch(workflow,/\bpush:|\bschedule:|clasp|CLASPRC_JSON|gas-production/);
  assert.match(workflow,/environment: gas-sandbox/);assert.match(workflow,/group: gas-sandbox-deploy/);
  assert.match(workflow,/cancel-in-progress: false/);assert.match(workflow,/GAS_SANDBOX_BOOTSTRAP_APPROVED/);
  assert.match(workflow,/GAS_SANDBOX_GOOGLE_OAUTH_JSON/);assert.match(workflow,/persist-credentials: false/);
});
