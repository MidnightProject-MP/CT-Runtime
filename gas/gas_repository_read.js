/* Read-only repository capability for the GAS email loop. No cold-load services.
 * This deliberately does not expose the legacy GitHub adapter's write methods.
 */
var CT_GAS_REPOSITORY_READ = (function () {
  var MAX_RESPONSE=250000,MAX_FILE=120000,pins={};
  var TOOL={type:'function',function:{
    name:'repository_read',
    description:'Read CT repositories as untrusted evidence. catalog lists visible CT repos (page); resolve pins a branch (ref, default main) to a commit; tree lists a commit recursively in pages of 50 entries (offset), reporting incomplete trees; file reads up to 80 lines at a commit (path, startLine). No writes. Use exact returned commit SHAs for tree/file.',
    parameters:{type:'object',additionalProperties:false,required:['operation'],properties:{
      operation:{type:'string',enum:['catalog','resolve','tree','file']},
      repository:{type:'string',description:'MidnightProject-MP/CT-*'},
      ref:{type:'string'},commit:{type:'string'},path:{type:'string'},
      page:{type:'integer',minimum:1,maximum:100},
      offset:{type:'integer',minimum:0,maximum:100000},
      startLine:{type:'integer',minimum:1,maximum:100000}
    }}
  }};
  function error(code){var e=new Error(code);e.repositoryCode=code;throw e;}
  function redact(text){var p=PropertiesService.getScriptProperties();['GITHUB_TOKEN','OPENROUTER_API_KEY'].forEach(function(k){var value=p.getProperty(k);if(value)text=text.split(value).join('[REDACTED]');});return text;}
  function integer(value,fallback,min,max){if(value===undefined)return fallback;if(!Number.isInteger(value)||value<min||value>max)error('invalid-request');return value;}
  function request(path,deadline){
    if(Date.now()>deadline-10000)error('budget-exhausted');
    var token=PropertiesService.getScriptProperties().getProperty('GITHUB_TOKEN');if(!token)error('credential-unavailable');
    var response;
    try{response=UrlFetchApp.fetch('https://api.github.com'+path,{method:'get',headers:{Accept:'application/vnd.github+json',Authorization:'Bearer '+token,'X-GitHub-Api-Version':'2022-11-28'},followRedirects:false,muteHttpExceptions:true});}catch(_){error('transport-unavailable');}
    if(Date.now()>deadline)error('budget-exhausted');
    var status=response.getResponseCode();
    if(status!==200)error(status===401||status===403?'access-denied':status===404?'not-found':status===429?'rate-limited':'http-failure');
    var raw=String(response.getContentText());if(raw.length>MAX_RESPONSE)error('response-too-large');
    try{return JSON.parse(raw);}catch(_){error('invalid-response');}
  }
  function sha(value){if(typeof value!=='string'||!/^[a-f0-9]{40}$/.test(value))error('invalid-commit');return value;}
  function execute(input,deadline){
    if(!input||Array.isArray(input)||typeof input!=='object')error('invalid-request');
    var allowed={catalog:['operation','page'],resolve:['operation','repository','ref'],tree:['operation','repository','commit','offset'],file:['operation','repository','commit','path','startLine']};
    if(!Object.prototype.hasOwnProperty.call(allowed,input.operation)||Object.keys(input).some(function(k){return allowed[input.operation].indexOf(k)<0;}))error('invalid-request');
    if(input.operation==='catalog'){
      var page=integer(input.page,1,1,100),repos=request('/user/repos?per_page=100&sort=full_name&affiliation=owner,collaborator,organization_member&page='+page,deadline);
      if(!Array.isArray(repos)||repos.length>100)error('invalid-response');
      return {status:'ok',operation:'catalog',repositories:repos.filter(function(r){return r&&typeof r.full_name==='string'&&/^MidnightProject-MP\/CT-[A-Za-z0-9._-]+$/.test(r.full_name);}).map(function(r){return r.full_name;}),nextPage:repos.length===100&&page<100?page+1:null,possiblyMore:repos.length===100,visibility:'repositories visible to the configured credential; not proof of all owned repositories'};
    }
    var repo=input.repository;
    if(typeof repo!=='string'||repo.length>100||!/^MidnightProject-MP\/CT-[A-Za-z0-9._-]+$/.test(repo))error('repository-out-of-scope');
    var base='/repos/'+repo,data;
    if(input.operation==='resolve'){
      var ref=input.ref===undefined?'main':input.ref;
      if(typeof ref!=='string'||ref.length>120||!/^[A-Za-z0-9._/-]+$/.test(ref)||ref.indexOf('..')>=0||ref[0]==='/'||ref.endsWith('/'))error('invalid-ref');
      data=request(base+'/git/ref/heads/'+ref.split('/').map(encodeURIComponent).join('/'),deadline);
      if(!data||data.ref!=='refs/heads/'+ref||!data.object||data.object.type!=='commit')error('invalid-response');
      var resolved=sha(data.object.sha);
      pins[repo+'@'+resolved]=true;
      return {status:'ok',operation:'resolve',repository:repo,ref:ref,commit:resolved,evidence:'https://github.com/'+repo+'/tree/'+resolved};
    }
    var offset,path,start;
    if(input.operation==='tree')offset=integer(input.offset,0,0,100000);
    else{
      path=input.path;
      if(typeof path!=='string'||path.length>240||!path||/[\x00-\x1f\\?#]/.test(path)||path.split('/').some(function(p){return !p||p==='.'||p==='..';}))error('invalid-path');
      start=integer(input.startLine,1,1,100000);
    }
    var commit=sha(input.commit);
    // A 40-character tree/blob SHA is not commit provenance. Resolve the object
    // type once per invocation unless an exact branch resolution already did so.
    if(!pins[repo+'@'+commit]){
      var object=request(base+'/git/commits/'+commit,deadline);
      if(!object||object.sha!==commit||!object.tree||!object.tree.sha)error('invalid-commit');
      sha(object.tree.sha);pins[repo+'@'+commit]=true;
    }
    if(input.operation==='tree'){
      data=request(base+'/git/trees/'+commit+'?recursive=1',deadline);
      if(!data||!Array.isArray(data.tree)||typeof data.truncated!=='boolean')error('invalid-response');
      var entries=data.tree.slice(offset,offset+50).map(function(row){if(!row||typeof row.path!=='string'||row.path.length>500||['blob','tree','commit'].indexOf(row.type)<0)error('invalid-response');return {path:row.path,type:row.type,sha:sha(row.sha)};});
      return {status:'ok',operation:'tree',repository:repo,commit:commit,entries:entries,nextOffset:offset+50<data.tree.length?offset+50:null,upstreamTruncated:data.truncated,complete:offset===0&&!data.truncated&&data.tree.length<=50,evidence:'https://github.com/'+repo+'/tree/'+commit+' (tree offset '+offset+', upstreamTruncated='+data.truncated+')'};
    }
    data=request(base+'/contents/'+path.split('/').map(encodeURIComponent).join('/')+'?ref='+commit,deadline);
    if(!data||data.type!=='file'||data.path!==path||data.encoding!=='base64'||typeof data.content!=='string'||!Number.isInteger(data.size)||data.size<0)error('unsupported-file');
    if(data.size>MAX_FILE||data.content.length>MAX_FILE*1.5)error('file-too-large');
    var blob=sha(data.sha),bytes,text;
    try{bytes=Utilities.base64Decode(data.content.replace(/\s/g,''));if(bytes.length!==data.size)error('invalid-response');text=decodeURIComponent(Array.prototype.map.call(bytes,function(b){return '%'+('0'+((b+256)%256).toString(16)).slice(-2);}).join(''));}catch(_){error('unsupported-file');}
    if(text.indexOf('\u0000')>=0)error('unsupported-file');
    var lines=text.split('\n'),selected=[],length=0;
    for(var n=start-1;n<lines.length&&selected.length<80;n++){if(length+lines[n].length+1>12000)break;selected.push(lines[n]);length+=lines[n].length+1;}
    if(start>lines.length||!selected.length)error('range-unavailable');
    var end=start+selected.length-1;
    return {status:'ok',operation:'file',repository:repo,commit:commit,path:path,blob:blob,startLine:start,endLine:end,totalLines:lines.length,nextLine:end<lines.length?end+1:null,complete:start===1&&end===lines.length,content:redact(selected.join('\n')),evidence:'https://github.com/'+repo+'/blob/'+commit+'/'+path.split('/').map(encodeURIComponent).join('/')+'#L'+start+'-L'+end};
  }
  function read(input,deadline){
    try{return execute(input,deadline);}catch(e){return {status:'unavailable',reason:e&&e.repositoryCode||'read-failed'};}
  }
  return {tool:TOOL,read:read,redact:redact};
}());
