// Read-only Apps Script API inspection. Remote writes remain in the canonical
// Actions workflow's clasp steps. Never print response bodies or credentials.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { bundleHash, normalizeFiles, deploymentIdFromWebAppUrl } from '../lib/gas-deploy-contract.mjs';

export const SCRIPT_ID='1Uzv-r4UW-y9XLuO-f3QEvrwzInGu1JarmqecVtwarJor6Z5qpmUD2dri';
export const DEPLOYMENT_ID='AKfycbwyFPC55MvhCfPUmBlfm7eRp-uHr5tpZ2H9suobETGXod_hLLVDQtC9DelC7ee_WSNawg';
export function binding(env,readOnly=false) {
  const deployment=deploymentIdFromWebAppUrl(env.CT_GAS_ADMIN_WEB_APP_URL);
  if(env.CT_GAS_SCRIPT_ID!==SCRIPT_ID||deployment!==DEPLOYMENT_ID||env.DEPLOYMENT_ID!==deployment)throw new Error('source-only identity mismatch');
  if(!readOnly&&!/^[a-f0-9]{64}$/.test(env.EXPECTED_HEAD_HASH||''))throw new Error('reviewed predecessor HEAD hash required');
  return {script:SCRIPT_ID,deployment,expected:env.EXPECTED_HEAD_HASH};
}
export async function inspect(api,b) {
  const project=await api(`/projects/${b.script}`);
  const deployment=await api(`/projects/${b.script}/deployments/${b.deployment}`);
  const config=deployment.deploymentConfig;
  if(project.scriptId!==b.script||deployment.deploymentId!==b.deployment||config?.scriptId!==b.script||!Number.isSafeInteger(config.versionNumber)||config.versionNumber<1)throw new Error('source-only API identity mismatch');
  const head=await api(`/projects/${b.script}/content`);
  const live=await api(`/projects/${b.script}/content?versionNumber=${config.versionNumber}`);
  const after=await api(`/projects/${b.script}/deployments/${b.deployment}`);
  const afterHead=await api(`/projects/${b.script}/content`);
  if(after.deploymentId!==b.deployment||after.deploymentConfig?.scriptId!==b.script||after.deploymentConfig.versionNumber!==config.versionNumber||bundleHash(afterHead.files)!==bundleHash(head.files))throw new Error('source-only observation changed during readback');
  return {script:b.script,deployment:b.deployment,head:bundleHash(head.files),live:bundleHash(live.files),version:config.versionNumber};
}
export async function preflight(api,b,files){return {...await inspect(api,b),desired:bundleHash(files),hash_format:'ct-runtime-normalizeFiles-sha256-v1'};}
export function verify(stage,b,actual,state) {
  if(actual.script!==b.script||actual.deployment!==b.deployment)throw new Error('source-only identity mismatch');
  if(stage==='prepare'){
    if(actual.head!==b.expected||actual.head!==actual.live)throw new Error('source-only predecessor drift');
  }else{
    if(!state||state.script!==b.script||state.deployment!==b.deployment||state.head!==b.expected)throw new Error('source-only receipt mismatch');
    if(actual.head!==state.desired)throw new Error('source-only HEAD readback mismatch');
    if(stage==='head'&&(actual.live!==state.live||actual.version!==state.version))throw new Error('source-only LIVE drift');
    if(stage==='final'&&actual.live!==state.desired)throw new Error('source-only version readback mismatch');
  }
}
async function apiClient(credentials) {
  const c=JSON.parse(await readFile(credentials,'utf8')),t=c.tokens?.default,s=c.oauth2ClientSettings||{};
  const client_id=t?.client_id||s.clientId||s.client_id,client_secret=t?.client_secret||s.clientSecret||s.client_secret,refresh_token=t?.refresh_token;
  if(!client_id||!client_secret||!refresh_token)throw new Error('source-only refresh credentials unavailable');
  const r=await fetch('https://oauth2.googleapis.com/token',{method:'POST',redirect:'error',signal:AbortSignal.timeout(30000),headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id,client_secret,refresh_token,grant_type:'refresh_token'})});
  if(!r.ok)throw new Error('source-only OAuth refresh failed');
  const token=(await r.json()).access_token;if(!token)throw new Error('source-only OAuth token missing');
  return async path=>{
    const response=await fetch('https://script.googleapis.com/v1'+path,{method:'GET',redirect:'error',signal:AbortSignal.timeout(30000),headers:{Authorization:`Bearer ${token}`}});
    if(!response.ok)throw new Error('source-only API read failed');
    return response.json();
  };
}
export async function main(env=process.env,stage=process.argv[2],dependencies={}) {
  if(!['inspect','prepare','head','final'].includes(stage))throw new Error('source-only stage invalid');
  const b=binding(env,stage==='inspect'),api=dependencies.api||await apiClient(join(env.HOME,'.clasprc.json'));
  const report=dependencies.report||console.log;
  const root=join(env.RUNNER_TEMP,'gas-source-only'),receipt=join(env.RUNNER_TEMP,'gas-source-only-receipt.json');
  if(stage==='prepare'||stage==='inspect'){
    const files=normalizeFiles(JSON.parse(await readFile(join(env.RUNNER_TEMP,'gas-bundle.json'),'utf8')).files);
    const actual=await preflight(api,b,files),desired=actual.desired;
    if(stage==='inspect'){report(JSON.stringify({...actual,status:'read-only',commit:env.GITHUB_SHA||null}));return;}
    verify(stage,b,actual);
    if(env.EXPECTED_DESIRED_HASH!==desired)throw new Error('reviewed desired bundle hash mismatch');
    await mkdir(root); // Refuse stale staging directories from an earlier attempt.
    for(const f of files)await writeFile(join(root,f.name+(f.type==='JSON'?'.json':f.type==='HTML'?'.html':'.js')),f.source);
    await writeFile(join(root,'.clasp.json'),JSON.stringify({scriptId:b.script,rootDir:'.'}));
    await writeFile(receipt,JSON.stringify({...actual,desired}));
    await writeFile(env.GITHUB_OUTPUT,`needed=${actual.head!==desired}\n`,{flag:'a'});
    report(JSON.stringify({...actual,desired,status:actual.head===desired?'already-current':'prepared'}));
  }else{
    const state=JSON.parse(await readFile(receipt,'utf8'));
    // Readback retries only. Never repeat push/version/deployment mutations.
    for(let n=0;n<5;n++){
      try{const actual=await inspect(api,b);verify(stage,b,actual,state);report(JSON.stringify({...actual,status:`verified-${stage}`}));return;}
      catch(_){if(n===4)throw new Error('source-only readback unresolved; inspect before any further mutation');await new Promise(r=>setTimeout(r,2000));}
    }
  }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  main().catch(()=>{console.error('source-only gate failed; no automatic mutation retry; inspect metadata and credentials privately');process.exitCode=1;});
}
