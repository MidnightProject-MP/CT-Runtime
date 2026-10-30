// One-time initial installation only. Subsequent releases use signed self-deploy.
// No retries of remote writes; only bounded, classified metadata leaves this process.
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { bundleHash, normalizeFiles, deploymentIdFromWebAppUrl } from '../lib/gas-deploy-contract.mjs';
import { isProductionTarget } from '../lib/gas-targets.mjs';

const REPOSITORY='MidnightProject-MP/CT-Runtime';
const TITLE='CT-Runtime GAS Sandbox';
const validId=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{20,}$/.test(value);
const requireThat=(condition,code)=>{if(!condition)throw new Error(code);};

export function authorizeBootstrap(env,files,resolveRef){
  const {GITHUB_SHA:commit,GITHUB_REF:ref,BOOTSTRAP_REQUEST_ID:requestId}=env;
  requireThat(env.GITHUB_REPOSITORY===REPOSITORY&&env.GITHUB_EVENT_NAME==='workflow_dispatch','manual-repository-bound-bootstrap-required');
  requireThat(/^[a-f0-9]{40}$/.test(commit||'')&&env.RELEASE_COMMIT===commit,'commit-mismatch');
  requireThat(/^refs\/tags\/gas-sandbox-release\/[A-Za-z0-9._-]+$/.test(ref||'')&&env.RELEASE_REF===ref&&resolveRef(ref)===commit,'ref-mismatch');
  requireThat(/^[a-z0-9][a-z0-9-]{0,47}$/.test(requestId||''),'request-id-required');
  requireThat(['inspect','create'].includes(env.BOOTSTRAP_MODE),'invalid-mode');
  const owner=env.GAS_SANDBOX_OWNER_EMAIL;
  requireThat(typeof owner==='string'&&/^[^\s@:]+@[^\s@:]+\.[^\s@:]+$/.test(owner)&&owner===owner.toLowerCase(),'sandbox-owner-required');
  const hash=bundleHash(files);
  requireThat(env.DESIRED_BUNDLE_HASH===hash,'bundle-mismatch');
  const manifest=JSON.parse(files.find(f=>f.name==='appsscript').source);
  requireThat(manifest.runtimeVersion==='V8'&&manifest.webapp?.executeAs==='USER_DEPLOYING'&&manifest.webapp?.access==='ANYONE_ANONYMOUS','unexpected-manifest');
  if(env.BOOTSTRAP_MODE==='create'){
    requireThat(env.GITHUB_RUN_ATTEMPT==='1','rerun-write-forbidden');
    requireThat(env.BOOTSTRAP_APPROVED===`${ref}:${commit}:${hash}:${requestId}:${owner}`,'bootstrap-approval-mismatch');
  }
  return {commit,ref,hash,requestId,owner,mode:env.BOOTSTRAP_MODE};
}

export async function bootstrap(env,source,{api,claim,resolveRef,report=()=>{}}){
  let stage='authorization';
  try{
    const files=normalizeFiles(source),binding=authorizeBootstrap(env,files,resolveRef);
    const metadata={requestId:binding.requestId,commit:binding.commit,bundleHash:binding.hash};
    const emit=(status,values={})=>report({status,...metadata,...values});
    stage='owner-identity';
    const identity=await api('drive','GET','/about?fields=user(emailAddress)');
    requireThat(identity.user?.emailAddress?.toLowerCase()===binding.owner,'sandbox-owner-mismatch');
    stage='inventory';
    const query="trashed = false and mimeType = 'application/vnd.google-apps.script' and name = '"+TITLE+"'";
    const inventory=await api('drive','GET','/files?q='+encodeURIComponent(query)+'&pageSize=100&fields=files(id,name),nextPageToken,incompleteSearch');
    requireThat(Array.isArray(inventory.files)&&inventory.files.length<=1&&!inventory.nextPageToken&&!inventory.incompleteSearch,'inventory-incomplete-or-ambiguous');
    requireThat(inventory.files.every(f=>validId(f.id)&&f.name===TITLE&&!isProductionTarget(f.id,'')),'inventory-identity-conflict');
    if(binding.mode==='inspect'){
      emit('inventory',{projects:inventory.files.map(f=>({scriptId:f.id}))});
      for(const file of inventory.files){
        const content=await api('script','GET',`/projects/${file.id}/content`);
        requireThat(content.scriptId===file.id,'head-identity-conflict');
        const deployments=await api('script','GET',`/projects/${file.id}/deployments?pageSize=100`);
        requireThat(!deployments.nextPageToken&&Array.isArray(deployments.deployments||[]),'deployment-inventory-incomplete');
        const list=[];
        for(const d of deployments.deployments||[]){
          const version=d.deploymentConfig?.versionNumber;
          requireThat(validId(d.deploymentId)&&!isProductionTarget(file.id,d.deploymentId)&&Number.isSafeInteger(version)&&version>0&&d.deploymentConfig.scriptId===file.id,'deployment-identity-conflict');
          const live=await api('script','GET',`/projects/${file.id}/content?versionNumber=${version}`);
          requireThat(live.scriptId===file.id,'live-identity-conflict');
          list.push({deploymentId:d.deploymentId,version,liveBundleHash:bundleHash(live.files)});
        }
        emit('inspected',{scriptId:file.id,headBundleHash:content.files?.length?bundleHash(content.files):null,deployments:list});
      }
      return;
    }
    requireThat(inventory.files.length===0,'existing-sandbox-inspect-only');
    // A durable, create-only Git ref consumes this approval BEFORE Google writes.
    // If its response or any subsequent response is lost, do not remove/reuse it.
    stage='request-reservation';await claim(binding);
    emit('request-reserved');
    stage='project-create';
    const project=await api('script','POST','/projects',{title:TITLE});
    requireThat(validId(project.scriptId)&&project.title===TITLE&&!isProductionTarget(project.scriptId,''),'project-identity-conflict');
    const scriptId=project.scriptId;
    emit('project-created',{scriptId});
    stage='empty-project-readback';
    const empty=await api('script','GET',`/projects/${scriptId}/content`);
    requireThat(empty.scriptId===scriptId&&Array.isArray(empty.files)&&empty.files.every(f=>f.type==='JSON'&&['appsscript','appsscript.json'].includes(f.name)),'new-project-not-empty');
    stage='content-install';await api('script','PUT',`/projects/${scriptId}/content`,{files});
    stage='content-readback';
    const head=await api('script','GET',`/projects/${scriptId}/content`);
    requireThat(head.scriptId===scriptId&&bundleHash(head.files)===binding.hash,'head-mismatch');
    const description=`sandbox-bootstrap:${binding.requestId}:${binding.commit}`;
    stage='version-create';
    const version=await api('script','POST',`/projects/${scriptId}/versions`,{description});
    requireThat(version.scriptId===scriptId&&Number.isSafeInteger(version.versionNumber)&&version.versionNumber>0,'version-identity-conflict');
    emit('version-created',{scriptId,version:version.versionNumber});
    stage='version-readback';
    const versionContent=await api('script','GET',`/projects/${scriptId}/content?versionNumber=${version.versionNumber}`);
    requireThat(versionContent.scriptId===scriptId&&bundleHash(versionContent.files)===binding.hash,'version-mismatch');
    stage='deployment-create';
    const deployment=await api('script','POST',`/projects/${scriptId}/deployments`,{versionNumber:version.versionNumber,manifestFileName:'appsscript',description});
    requireThat(validId(deployment.deploymentId)&&!isProductionTarget(scriptId,deployment.deploymentId),'deployment-identity-conflict');
    emit('deployment-created',{scriptId,version:version.versionNumber,deploymentId:deployment.deploymentId});
    stage='final-readback';
    const observed=await api('script','GET',`/projects/${scriptId}/deployments/${deployment.deploymentId}`);
    requireThat(observed.deploymentId===deployment.deploymentId&&observed.deploymentConfig?.scriptId===scriptId&&observed.deploymentConfig?.versionNumber===version.versionNumber,'deployment-readback-mismatch');
    const urls=(observed.entryPoints||[]).filter(e=>e.entryPointType==='WEB_APP').map(e=>e.webApp?.url);
    const webAppUrl=`https://script.google.com/macros/s/${deployment.deploymentId}/exec`;
    requireThat(urls.length===1&&urls[0]===webAppUrl&&deploymentIdFromWebAppUrl(urls[0])===deployment.deploymentId,'webapp-readback-mismatch');
    const finalHead=await api('script','GET',`/projects/${scriptId}/content`);
    requireThat(finalHead.scriptId===scriptId&&bundleHash(finalHead.files)===binding.hash,'final-head-mismatch');
    emit('installed-owner-setup-required',{scriptId,version:version.versionNumber,deploymentId:deployment.deploymentId,webAppUrl,headBundleHash:binding.hash,liveBundleHash:binding.hash});
  }catch(_){
    // Provider responses and OAuth values must never reach logs or receipts.
    report({status:'stopped',stage,next:'inspect-only; never repeat a write after an uncertain response'});
    throw new Error(`sandbox-bootstrap-stopped:${stage}`);
  }
}

export async function googleClient(raw,fetcher=fetch){
  const c=JSON.parse(raw||'{}'),t=c.tokens?.default,s=c.oauth2ClientSettings||{};
  const client_id=t?.client_id||s.clientId||s.client_id,client_secret=t?.client_secret||s.clientSecret||s.client_secret,refresh_token=t?.refresh_token;
  requireThat(client_id&&client_secret&&refresh_token,'oauth-credentials-unavailable');
  const response=await fetcher('https://oauth2.googleapis.com/token',{method:'POST',redirect:'error',signal:AbortSignal.timeout(30000),headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id,client_secret,refresh_token,grant_type:'refresh_token'})});
  requireThat(response.ok,'oauth-refresh-unavailable');
  const token=(await response.json()).access_token;requireThat(typeof token==='string'&&token.length>0,'oauth-token-unavailable');
  return async(service,method,path,body)=>{
    const origin=service==='drive'?'https://www.googleapis.com/drive/v3':'https://script.googleapis.com/v1';
    const r=await fetcher(origin+path,{method,redirect:'error',signal:AbortSignal.timeout(30000),headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
    requireThat(r.ok,'google-api-unavailable');return r.json();
  };
}

export async function reserveRequest(binding,token,fetcher=fetch){
  requireThat(token,'github-token-unavailable');
  const ref=`refs/tags/gas-sandbox-bootstrap-used/${binding.requestId}`;
  const r=await fetcher(`https://api.github.com/repos/${REPOSITORY}/git/refs`,{method:'POST',redirect:'error',signal:AbortSignal.timeout(30000),headers:{Authorization:`Bearer ${token}`,Accept:'application/vnd.github+json','Content-Type':'application/json'},body:JSON.stringify({ref,sha:binding.commit})});
  requireThat(r.status===201,'request-reservation-unavailable');
  const value=await r.json();requireThat(value.ref===ref&&value.object?.sha===binding.commit,'request-reservation-mismatch');
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  try{
    const files=normalizeFiles(JSON.parse(await readFile(process.env.GAS_BUNDLE_PATH,'utf8')).files);
    const resolveRef=ref=>execFileSync('git',['rev-parse','--verify',`${ref}^{commit}`],{encoding:'utf8'}).trim();
    // Authorization must fail before even refreshing credentials.
    authorizeBootstrap(process.env,files,resolveRef);
    const api=await googleClient(process.env.GAS_SANDBOX_GOOGLE_OAUTH_JSON);
    await bootstrap(process.env,files,{api,resolveRef,claim:b=>reserveRequest(b,process.env.GH_TOKEN),report:r=>console.log(JSON.stringify(r))});
  }catch(_){console.error('Sandbox bootstrap stopped. Inspect metadata; no automatic write retry.');process.exitCode=1;}
}
