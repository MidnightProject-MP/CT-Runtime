import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import { binding, inspect, verify, main, SCRIPT_ID, DEPLOYMENT_ID } from '../scripts/gas-source-only.mjs';
import { bundleHash } from '../lib/gas-deploy-contract.mjs';

const files=[{name:'appsscript',type:'JSON',source:'{"runtimeVersion":"V8"}'},{name:'main',type:'SERVER_JS',source:'function tick(){}'}];
const hash=bundleHash(files),env={CT_GAS_SCRIPT_ID:SCRIPT_ID,CT_GAS_ADMIN_WEB_APP_URL:`https://script.google.com/macros/s/${DEPLOYMENT_ID}/exec`,DEPLOYMENT_ID,EXPECTED_HEAD_HASH:hash};
test('source-only read-only API inspection binds script, exact deployment, HEAD and version hashes',async()=>{
  const b=binding(env),paths=[];
  const api=async path=>{paths.push(path);return path.includes('/deployments/')?{deploymentId:b.deployment,deploymentConfig:{scriptId:b.script,versionNumber:42}}:path.includes('/content')?{files}:{scriptId:b.script};};
  const actual=await inspect(api,b);assert.equal(actual.head,hash);assert.equal(actual.live,hash);assert.equal(actual.version,42);assert.equal(paths.length,6);
  verify('prepare',b,actual);verify('head',b,actual,{...actual,desired:hash});verify('final',b,actual,{...actual,desired:hash});
  assert.throws(()=>binding({...env,DEPLOYMENT_ID:''}),/identity/);
  assert.throws(()=>binding({...env,CT_GAS_SCRIPT_ID:'other'}),/identity/);
  assert.throws(()=>binding({...env,EXPECTED_HEAD_HASH:''}),/predecessor/);
  assert.throws(()=>verify('prepare',b,{...actual,head:'drift'}),/drift/);
  assert.throws(()=>verify('prepare',b,{...actual,live:'drift'}),/drift/);
  assert.throws(()=>verify('head',b,{...actual,version:43},{...actual,desired:hash}),/LIVE drift/);
  assert.throws(()=>verify('final',b,{...actual,live:'old'},{...actual,desired:hash}),/version readback/);
  await assert.rejects(inspect(async path=>path.includes('/deployments/')?{deploymentId:'wrong'}:{scriptId:b.script},b),/identity/);
  let reads=0;
  await assert.rejects(inspect(async path=>path.includes('/deployments/')?{deploymentId:b.deployment,deploymentConfig:{scriptId:b.script,versionNumber:++reads===1?42:43}}:path.includes('/content')?{files}:{scriptId:b.script},b),/changed during readback/);
});
test('preflight is metadata-only; same canonical hashing binds preparation and rejects unreviewed source',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'gas-source-preflight-'));
  try{
    // Different field order/API metadata/extensions must normalize identically.
    const apiFiles=files.map(f=>({source:f.source,type:f.type,name:f.name==='main'?'main.js':f.name,extra:'ignored'})).reverse();
    await writeFile(join(dir,'gas-bundle.json'),JSON.stringify({files}));
    const b=binding(env),report=[],api=async path=>path.includes('/deployments/')?{deploymentId:b.deployment,deploymentConfig:{scriptId:b.script,versionNumber:42}}:path.includes('/content')?{files:apiFiles}:{scriptId:b.script};
    const e={...env,RUNNER_TEMP:dir,GITHUB_OUTPUT:join(dir,'outputs'),GITHUB_SHA:'reviewed-commit',EXPECTED_HEAD_HASH:''};
    await main(e,'inspect',{api,report:s=>report.push(JSON.parse(s))});
    assert.deepEqual(await readdir(dir),['gas-bundle.json']);
    assert.equal(report[0].head,hash);assert.equal(report[0].live,hash);assert.equal(report[0].desired,hash);
    assert.equal(report[0].status,'read-only');assert.equal(report[0].hash_format,'ct-runtime-normalizeFiles-sha256-v1');
    assert.doesNotMatch(JSON.stringify(report),/function tick|runtimeVersion/);
    await assert.rejects(main({...e,EXPECTED_HEAD_HASH:hash,EXPECTED_DESIRED_HASH:'unreviewed'},'prepare',{api}),/desired bundle/);
    assert.deepEqual(await readdir(dir),['gas-bundle.json']);
    await assert.rejects(main({...e,EXPECTED_HEAD_HASH:'0'.repeat(64),EXPECTED_DESIRED_HASH:hash},'prepare',{api}),/predecessor drift/);
    await main({...e,EXPECTED_HEAD_HASH:report[0].head,EXPECTED_DESIRED_HASH:report[0].desired},'prepare',{api,report:()=>{}});
    assert.equal(await readFile(join(dir,'outputs'),'utf8'),'needed=false\n');
    assert.deepEqual((await readdir(join(dir,'gas-source-only'))).sort(),['.clasp.json','appsscript.json','main.js']);
  }finally{await rm(dir,{recursive:true,force:true});}
});
test('canonical workflow gates every legacy mutation/Execution API step and source-only is pinned and serialized',async()=>{
  const w=await readFile(new URL('../.github/workflows/gas-clasp-deploy.yml',import.meta.url),'utf8');
  assert.match(w,/source_only:[\s\S]*?default: false/);assert.match(w,/group: gas-production-deploy/);assert.match(w,/cancel-in-progress: false/);
  const steps=w.split('      - name:');
  for(const s of steps.filter(s=>/clasp run |Configure Apps Script project|Show clasp file status/.test(s)))assert.match(s,/if: \$\{\{ !inputs.source_only \}\}/);
  const update=steps.find(s=>s.startsWith(' Update pinned source-only'));
  assert.match(update,/--deploymentId "\$DEPLOYMENT_ID"/);assert.doesNotMatch(update,/else|clasp run/);
  assert.match(w,/gas-source-only.mjs prepare/);assert.match(w,/gas-source-only.mjs head/);assert.match(w,/gas-source-only.mjs final/);
  assert.match(w,/gas-source-only.mjs inspect/);
  assert.match(steps.find(s=>s.startsWith(' Inspect source-only predecessor')),/!inputs.source_only_preflight/);
  assert.match(steps.find(s=>s.startsWith(' Read-only source-only')),/inputs.source_only && inputs.source_only_preflight/);
  for(const s of steps.filter(s=>/clasp push|clasp create-deployment/.test(s)))assert.match(s,/!inputs.source_only|source_prepare.outputs.needed == 'true'/);
  assert.match(w,/Read-only preflight requires source_only=true/);
  const source=await readFile(new URL('../scripts/gas-source-only.mjs',import.meta.url),'utf8');
  assert.doesNotMatch(source,/clasp push|method:'PUT'|method:'DELETE'/);assert.match(source,/method:'GET'/);
});
test('explicit owner configuration is disabled, grant-checked, fixed-field and refuses rotation',async()=>{
  const source=await readFile(new URL('../gas/gas_vnext_email.js',import.meta.url),'utf8');
  const props={OPENROUTER_API_KEY:'private-existing-key'},writes=[];
  const health={instance:'reviewed',mailbox:'midnight.project.mp@gmail.com',allowed_sender:'midnightprojectantigravity@gmail.com',blocked:false};
  const ctx=vm.createContext({PropertiesService:{getScriptProperties:()=>({getProperty:k=>props[k]??null,setProperties:(v,remove)=>{assert.equal(remove,false);writes.push(v);Object.assign(props,v);}})},ScriptApp:{getIdentityToken:()=> 'private-google-token'},UrlFetchApp:{fetch:()=>({getResponseCode:()=>200,getContentText:()=>JSON.stringify(health)})}});
  vm.runInContext(source,ctx);assert.equal(writes.length,0);
  const c={instance:'reviewed',url:'https://reviewed.neon.tech',model:'vendor/explicit-model',label:'Celestan'};
  for(const bad of [null,{...c,enabled:true},{...c,url:'https://attacker.invalid'},{...c,model:''},{...c,label:'bad\nlabel'}])assert.throws(()=>ctx.configureVnextEmailRuntime(bad),/bindings/);
  health.blocked=true;assert.throws(()=>ctx.configureVnextEmailRuntime(c),/grant not ready/);health.blocked=false;
  health.instance='other';assert.throws(()=>ctx.configureVnextEmailRuntime(c),/grant not ready/);health.instance='reviewed';
  assert.equal(writes.length,0);assert.deepEqual(Object.keys(props),['OPENROUTER_API_KEY']);
  assert.equal(ctx.configureVnextEmailRuntime(c).enabled,false);assert.equal(props.CT_VNEXT_EMAIL_ENABLED,'false');assert.equal(props.OPENROUTER_API_KEY,'private-existing-key');
  assert.throws(()=>ctx.configureVnextEmailRuntime({...c,model:'vendor/other'}),/conflict/);
  assert.throws(()=>ctx.configureVnextEmailRuntime({...c,enabled:true}),/bindings/);
  assert.throws(()=>ctx.configureVnextEmailRuntime({...c,model:''}),/bindings/);
  props.CT_VNEXT_EMAIL_ENABLED='true';assert.throws(()=>ctx.configureVnextEmailRuntime(c),/conflict/);
  assert.equal(writes.length,1);assert.equal(props.OPENROUTER_API_KEY,'private-existing-key');
});
