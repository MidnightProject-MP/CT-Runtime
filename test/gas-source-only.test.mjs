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
test('legacy clasp deployment path remains retired until it implements canonical release authorization',async()=>{
  const w=await readFile(new URL('../.github/workflows/gas-clasp-deploy.yml',import.meta.url),'utf8');
  assert.match(w,/jobs:[\s\S]*?deploy:[\s\S]*?if: \$\{\{ false \}\}/);
  assert.match(w,/Retired: bypasses canonical predecessor comparison and signed readback/);
  assert.match(w,/Re-enable only with the same reviewed release gate and fresh CAS as self-deploy/);
  assert.match(w,/clasp push --force/);
  assert.match(w,/clasp create-deployment/);
  // The dangerous commands remain present only as historical implementation under
  // an unconditional job-level false guard; no PR CI or dispatch can run them.
  assert.match(w,/environment: gas-production/);
  const source=await readFile(new URL('../scripts/gas-source-only.mjs',import.meta.url),'utf8');
  assert.doesNotMatch(source,/clasp push|method:'PUT'|method:'DELETE'/);assert.match(source,/method:'GET'/);
});


