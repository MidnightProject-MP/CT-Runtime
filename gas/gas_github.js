var CT_GAS_GITHUB = (function () {
  var BOUND_REPOSITORY='MidnightProject-MP/CT-Runtime';
  var MAX=16000;
  function cfg() { var p=PropertiesService.getScriptProperties(), repo=p.getProperty('GITHUB_REPO'), token=p.getProperty('GITHUB_TOKEN'); if (repo!==BOUND_REPOSITORY) throw new Error('GITHUB_REPO is outside the bounded prototype repository'); if (!token) throw new Error('GITHUB_TOKEN is required'); return {repo:repo,token:token}; }
  function safePath(value) { value=String(value || ''); if (!value || value.length>240 || value.indexOf('..')>=0 || !/^[A-Za-z0-9._/-]+$/.test(value) || value[0]==='/' || value[value.length-1]==='/') throw new Error('invalid GitHub path'); return value.split('/').map(encodeURIComponent).join('/'); }
  function safeRef(value) { value=String(value || 'main'); if (value.length>120 || value.indexOf('..')>=0 || !/^[A-Za-z0-9._/-]+$/.test(value) || value[0]==='/') throw new Error('invalid GitHub ref'); return value; }
  function sha(value) { if (!/^[a-f0-9]{7,64}$/i.test(String(value || ''))) throw new Error('invalid GitHub SHA'); return value; }
  function request(method,path,body,clock) { var c=cfg(), options={method:method,headers:{Accept:'application/vnd.github+json',Authorization:'Bearer '+c.token},muteHttpExceptions:true}, own=clock||CT_GAS.clock(Date.now(),PropertiesService.getScriptProperties().getProperty('CT_GAS_BUDGET_MS')), admitted=CT_GAS.runGuard(own,'github-request',5000,function () { if (body) { options.contentType='application/json'; options.payload=JSON.stringify(body); } var r=UrlFetchApp.fetch('https://api.github.com/repos/'+c.repo+path,options); if (!own.canStart(0)) return {status:'preempted',reason:'github-post-operation'}; return r; }); if (admitted.status==='preempted') throw new Error('insufficient budget for GitHub request'); var code=admitted.getResponseCode(); if (code<200 || code>=300) throw new Error('GitHub request failed: '+code); var text=CT_GAS.bound(admitted.getContentText(),MAX); try { return JSON.parse(text); } catch (_) { throw new Error('invalid GitHub response'); } }
  function repoPath(path) { return '/'+path; }
  return {
    readFile:function (file,ref,clock) { return request('GET','/contents/'+safePath(file)+'?ref='+encodeURIComponent(safeRef(ref)),null,clock); },
    tree:function (ref,clock) { return request('GET','/git/trees/'+encodeURIComponent(safeRef(ref))+'?recursive=1',null,clock); },
    blob:function (value,clock) { return request('GET','/git/blobs/'+encodeURIComponent(sha(value)),null,clock); },
    ref:function (value,clock) { return request('GET','/git/ref/'+encodeURIComponent('heads/'+safeRef(value)),null,clock); },
    createBranch:function (name,value,clock) { return request('POST','/git/refs',{ref:'refs/heads/'+safeRef(name),sha:sha(value)},clock); },
    upsertFile:function (file,body,clock) { if (!body || typeof body !== 'object' || !body.message || !body.content) throw new Error('invalid file update'); if (body.sha) sha(body.sha); return request('PUT','/contents/'+safePath(file),body,clock); },
    pullRequest:function (body,clock) { if (!body || !safeRef(body.head) || !safeRef(body.base) || typeof body.title !== 'string' || body.title.length>200) throw new Error('invalid pull request'); return request('POST','/pulls',{title:CT_GAS.bound(body.title,200),head:body.head,base:body.base,body:CT_GAS.bound(body.body,4000)},clock); },
    commits:function (ref,clock) { return request('GET','/commits?sha='+encodeURIComponent(safeRef(ref))+'&per_page=10',null,clock); },
    checks:function (value,clock) { return request('GET','/commits/'+sha(value)+'/check-runs',null,clock); },
    statuses:function (value,clock) { return request('GET','/commits/'+sha(value)+'/statuses',null,clock); },
    dispatchWorkflow:function (workflow,ref,clock) { if (!/^[A-Za-z0-9._-]{1,120}$/.test(workflow)) throw new Error('invalid workflow'); return request('POST','/actions/workflows/'+encodeURIComponent(workflow)+'/dispatches',{ref:safeRef(ref)},clock); },
    workflowRuns:function (clock) { return request('GET','/actions/runs?per_page=1',null,clock); }
  };
}());
function githubWorkspace() { return CT_GAS_GITHUB; }
