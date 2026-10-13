/* Owner-only controls. Resolve runtime dependencies only when invoked, never at GAS cold load. */
var CT_GAS_VNEXT_EMAIL_OWNER = (function () {
  function deps(){if(typeof CT_GAS_VNEXT_EMAIL==='undefined'||!CT_GAS_VNEXT_EMAIL.owner)throw new Error('email runtime module unavailable');return CT_GAS_VNEXT_EMAIL.owner;}
  var CONFIG=['CT_VNEXT_EMAIL_ENABLED','CT_VNEXT_EMAIL_INSTANCE','CT_VNEXT_EMAIL_DATA_API_URL','CT_VNEXT_EMAIL_MODEL','CT_VNEXT_EMAIL_LABEL','OPENROUTER_API_KEY'];
  var MAILBOX='midnight.project.mp@gmail.com', SENDER='midnightprojectantigravity@gmail.com';
  function props(){return deps().props();} function config(x){return deps().config(x);}
  function hostAllowed(url,approved){var m=String(url||'').match(/^https:\/\/([^\/?#]+)(?:\/|$)/);return !!m&&m[1].indexOf('@')<0&&typeof approved==='string'&&approved.length>0&&m[1].toLowerCase()===approved.toLowerCase();}
  function rpc(){return deps().rpc.apply(null,arguments);} function api(){return deps().api.apply(null,arguments);}
  function address(x){return deps().address(x);} function safeFailure(x){return deps().safeFailure(x);}
  function header(){return deps().header.apply(null,arguments);} function subject(x){return deps().subject(x);}
  function text(x){return deps().text(x);} function mime(x){return deps().mime(x);} function utf8Bytes(x){return deps().utf8Bytes(x);}
  // Owner evidence only. No admission, record, send, model or configuration writes.
  function diagnoseDelivery(){
    var out={status:'uncertain',readOnly:true,stage:'persisted-config',candidates:[]},c,e;
    function id(v){return typeof v==='string'&&/^[a-f0-9]{1,100}$/.test(v)?v:null;}
    function compare(m,source){
      var row={source:source,id:id(m&&m.id),threadId:id(m&&m.threadId),comparisons:{},mismatchFields:[]};
      var checks={sent:function(){return (m.labelIds||[]).indexOf('SENT')>=0;},thread:function(){return m.threadId===e.threadId;},from:function(){return address(header(m,'From'))===MAILBOX;},to:function(){return address(header(m,'To'))===SENDER;},messageId:function(){return header(m,'Message-ID')===e.messageId;},reference:function(){return header(m,'In-Reply-To')===e.reference;},subject:function(){return subject(m)===e.subject;},normalizedBody:function(){return text(m.payload).replace(/\r\n/g,'\n').trim()===e.body.replace(/\r\n/g,'\n').trim();}};
      Object.keys(checks).forEach(function(k){try{row.comparisons[k]=checks[k]();}catch(err){row.comparisons[k]=false;row.failure=safeFailure(err);}if(!row.comparisons[k])row.mismatchFields.push(k);});
      out.candidates.push(row);
    }
    try{
      c=config(false);
       if(!hostAllowed(c.url,props().getProperty('CT_VNEXT_EMAIL_APPROVED_DATA_API_HOST')))throw new Error('data API endpoint is not explicitly approved');
      out.stage='gmail-profile';if(address(api('profile').emailAddress)!==MAILBOX)throw new Error('wrong mailbox');
      out.stage='data-api-health';var h=rpc(c,'health');
      if(h.instance!==c.instance||!h.project||h.mailbox!==MAILBOX||h.allowed_sender!==SENDER||!h.grant_ref)throw new Error('wrong grant');
      out.stage='delivery-peek';var d=rpc(c,'delivery-peek');
      if(['idle','prepare','reconcile'].indexOf(d.status)<0)throw new Error('unexpected peek');
      out.outboxStatus=d.status==='reconcile'?'admitted':d.status==='prepare'?'pending':'none';
      if(d.status==='idle'){out.status='idle';}
      else{
        out.stage='expected-envelope';e=d.envelope;mime(e);
        if(!id(e.threadId)||!id(e.id)||!/^gas-turn-[a-f0-9-]{36}$/.test(d.execution_id)||e.messageId!=='<'+d.execution_id+'@ct-runtime.invalid>')throw new Error('invalid envelope identifiers');
        out.executionId=d.execution_id;out.expectedMessageId=e.messageId;out.expectedThreadId=e.threadId;out.inputMessageId=e.id;
        out.expectedLengths={envelopeChars:JSON.stringify(e).length,envelopeBytes:utf8Bytes(JSON.stringify(e)),bodyChars:e.body.length,bodyBytes:utf8Bytes(e.body),subjectChars:e.subject.length,subjectBytes:utf8Bytes(e.subject)};
        out.stage='sent-search';
        try{
          var page=api('messages?maxResults=10&q='+encodeURIComponent('in:sent rfc822msgid:'+e.messageId)),refs=page.messages||[];
          if(!Array.isArray(refs))throw new Error('invalid search');
          out.searchHasNextPage=!!page.nextPageToken;out.searchTruncated=!!page.nextPageToken||refs.length>10;out.searchCandidateIds=refs.slice(0,10).map(function(r){return id(r.id);});
          refs.slice(0,10).forEach(function(r){try{if(!id(r.id))throw new Error('invalid candidate');compare(api('messages/'+encodeURIComponent(r.id)+'?format=full'),'sent-search');}catch(err){out.candidates.push({source:'sent-search',id:id(r.id),failure:safeFailure(err)});}});
        }catch(err){out.searchFailure=safeFailure(err);}
        out.stage='thread-readback';
        try{
          var thread=api('threads/'+encodeURIComponent(e.threadId)+'?format=full'),messages=thread.messages||[];
          if(!Array.isArray(messages))throw new Error('invalid thread');
          out.threadTruncated=!!thread.nextPageToken||messages.length>10;out.threadMatches=thread.id===e.threadId;
          out.threadCandidateIds=messages.slice(0,10).map(function(m){return id(m.id);});
          messages.slice(0,10).forEach(function(m){compare(m,'thread');});
        }catch(err){out.threadFailure=safeFailure(err);}
        // Evidence is not delivery authorization, even when every comparison matches.
        out.stage='complete';
      }
    }catch(err){out.status='blocked';out.failure=safeFailure(err);}
    console.log(JSON.stringify(out));return out;
  }
  function install() {
    var c=config(true);if(!c)throw new Error('email must be explicitly enabled before installation');
    if(address(api('profile').emailAddress)!==MAILBOX)throw new Error('wrong execution mailbox');
    var h=rpc(c,'health');if(h.mailbox!==MAILBOX||h.allowed_sender!==SENDER)throw new Error('email registration mismatch');
    var all=ScriptApp.getProjectTriggers();
    if(all.some(function(t){return t.getHandlerFunction()!=='vnextEmailTick';}))throw new Error('other triggers require explicit cutover review');
    var triggers=all.filter(function(t){return t.getHandlerFunction()==='vnextEmailTick';});
    if(triggers.length>1)throw new Error('duplicate email triggers require manual reconciliation');
    if(!triggers.length)createEmailTrigger();
    return {status:'installed'};
  }
  function inventory() {
    var names=Object.keys(props().getProperties()).sort(),counts={stable:0,legacy_runtime:0,unknown:0};
    var entries=names.map(function(name){var kind=CONFIG.indexOf(name)>=0?'stable':/^(CT_EMAIL_SEND_|CT_GAS_.*(?:EVENT|WAKE|CHECKPOINT|FENCE|RECEIPT))/.test(name)?'legacy_runtime':'unknown';counts[kind]++;return {name:name,classification:kind};});
    return {counts:counts,total:names.length,properties:entries,cleanup_allowlist:[],cleanup_apply_available:false,
      reason:'No legacy active-reference proof. Preserve all unknown properties and unresolved send fences.'};
  }
  function health(){return rpc(config(false),'health');}
  function configureChecked(input,inspectReady){
     if(props().getProperty('CT_VNEXT_EMAIL_APPROVED_SCRIPT_ID')!==ScriptApp.getScriptId())throw new Error('approved script identity mismatch');
    var p=props();
    if(!input||Object.keys(input).sort().join(',')!=='instance,label,model,url'||
       !/^[A-Za-z0-9_-]{1,100}$/.test(input.instance||'')||
        !hostAllowed(input.url,p.getProperty('CT_VNEXT_EMAIL_APPROVED_DATA_API_HOST'))||
       !/^[A-Za-z0-9._-]+\/[A-Za-z0-9._:/-]+$/.test(input.model||'')||
       typeof input.label!=='string'||!input.label.trim()||input.label.length>100||/[\x00-\x1f]/.test(input.label))throw new Error('invalid explicit email bindings');
    if(!p.getProperty('OPENROUTER_API_KEY'))throw new Error('existing OpenRouter secret required');
    var desired={CT_VNEXT_EMAIL_ENABLED:'false',CT_VNEXT_EMAIL_INSTANCE:input.instance,CT_VNEXT_EMAIL_DATA_API_URL:input.url.replace(/\/$/,''),CT_VNEXT_EMAIL_MODEL:input.model,CT_VNEXT_EMAIL_LABEL:input.label};
    Object.keys(desired).forEach(function(k){var old=p.getProperty(k);if(old!==null&&old!==desired[k])throw new Error('existing binding conflict; explicit owner review required');});
    var h=rpc({instance:input.instance,url:desired.CT_VNEXT_EMAIL_DATA_API_URL},'health');
    if(h.instance!==input.instance||h.mailbox!==MAILBOX||h.allowed_sender!==SENDER||h.blocked!==false)throw new Error('email grant not ready');
    var result=inspectReady?inspectReady(h,desired):{status:'configured',enabled:false,instance:input.instance};
    p.setProperties(desired,false); // Explicit owner invocation only; never a tick/deploy side effect.
    return result;
  }
  function setupLock(fn){var lock=LockService.getScriptLock();lock.waitLock(10000);try{return fn();}finally{lock.releaseLock();}}
  function configure(input){return setupLock(function(){return configureChecked(input);});}
     // The owner must explicitly pin this script before any property preparation write.
  function preparation(mutate){
    var stages=[],failed=false,firstReason=null,lock,locked=false,desired=null,summary={},properties={},preparedMatch=null,writeAttempted=false,readbackConfirmed=false,p,snapshot,model;
    function stage(name,fn){try{var v=fn();stages.push({stage:name,status:'ok'});return {ok:true,value:v};}catch(e){var detail=safeFailure(e);stages.push(Object.assign({stage:name,status:'failed'},detail));failed=true;if(!firstReason)firstReason=detail.reason||'prepare: readiness/configuration outcome unavailable; inspect before retry';return {ok:false};}}
    function skip(name){stages.push({stage:name,status:'skipped',classification:'prerequisite-unavailable'});}
    function countsOf(values){var counts={total:0,stable:0,legacy_runtime:0,unknown:0};Object.keys(values).forEach(function(k){counts.total++;counts[CONFIG.indexOf(k)>=0?'stable':/^(CT_EMAIL_SEND_|CT_GAS_.*(?:EVENT|WAKE|CHECKPOINT|FENCE|RECEIPT))/.test(k)?'legacy_runtime':'unknown']++;});return counts;}
    function matches(values){var all=true;Object.keys(desired).forEach(function(k){properties[k]={present:values[k]!==undefined&&values[k]!==null,matches:values[k]===desired[k]};if(!properties[k].matches)all=false;});properties.OPENROUTER_API_KEY={present:!!values.OPENROUTER_API_KEY};return all;}
    function checkBindings(){Object.keys(desired).forEach(function(k){var old=p.getProperty(k);if(old!==null&&old!==desired[k])throw new Error('existing binding conflict; explicit owner review required');});}
    try{
      locked=stage('script-lock',function(){lock=LockService.getScriptLock();lock.waitLock(10000);return true;}).ok;
      if(locked){
        var profile=stage('gmail-profile',function(){if(address(api('profile').emailAddress)!==MAILBOX)throw new Error('prepare: wrong execution mailbox');});
        var propertyRead=stage('property-read',function(){p=props();snapshot=p.getProperties();summary.propertyCounts=countsOf(snapshot);CONFIG.forEach(function(k){properties[k]={present:!!snapshot[k]};});});
     var approvedScriptId=stage('approved-script-identity',function(){var expected=p&&p.getProperty?p.getProperty('CT_VNEXT_EMAIL_APPROVED_SCRIPT_ID'):props().getProperty('CT_VNEXT_EMAIL_APPROVED_SCRIPT_ID');if(expected!==ScriptApp.getScriptId())throw new Error('prepare: approved script identity mismatch');return expected;});
        var modelCheck={ok:false};
        if(propertyRead.ok){
          modelCheck=stage('model-config',function(){
            model=snapshot.CT_VNEXT_EMAIL_MODEL;if(model===undefined||model===null)model=snapshot.CT_GAS_PROOF_MODEL;
            if(typeof model!=='string'||! /^[A-Za-z0-9._-]+\/[A-Za-z0-9._:/-]+$/.test(model))throw new Error('prepare: set CT_VNEXT_EMAIL_MODEL to an explicit approved provider/model');
            var instance=snapshot.CT_VNEXT_EMAIL_INSTANCE,url=snapshot.CT_VNEXT_EMAIL_DATA_API_URL,label=snapshot.CT_VNEXT_EMAIL_LABEL;
             if(!/^[A-Za-z0-9_-]{1,100}$/.test(instance||'')||!hostAllowed(url,snapshot.CT_VNEXT_EMAIL_APPROVED_DATA_API_HOST)||typeof label!=='string'||!label.trim()||label.length>100||/[\x00-\x1f]/.test(label))throw new Error('prepare: explicit instance, approved HTTPS data API URL and queue label are required');
             desired={CT_VNEXT_EMAIL_ENABLED:'false',CT_VNEXT_EMAIL_INSTANCE:instance,CT_VNEXT_EMAIL_DATA_API_URL:url.replace(/\/$/,''),CT_VNEXT_EMAIL_MODEL:model,CT_VNEXT_EMAIL_LABEL:label};
            preparedMatch=matches(snapshot);checkBindings();if(!snapshot.OPENROUTER_API_KEY)throw new Error('existing OpenRouter secret required');
          });
        }else skip('model-config');
        // These independent read-only checks diagnose data API/property state.
        // after a Gmail failure. Do not inspect labels from a mismatched mailbox.
        stage('data-api-health',function(){var h=rpc({instance:desired?desired.CT_VNEXT_EMAIL_INSTANCE:snapshot.CT_VNEXT_EMAIL_INSTANCE,url:desired?desired.CT_VNEXT_EMAIL_DATA_API_URL:snapshot.CT_VNEXT_EMAIL_DATA_API_URL},'health');if(typeof h.project!=='string'||!h.project.trim())throw new Error('prepare: project identity missing');summary.project=h.project;if(h.instance!==(desired?desired.CT_VNEXT_EMAIL_INSTANCE:snapshot.CT_VNEXT_EMAIL_INSTANCE)||h.mailbox!==MAILBOX||h.allowed_sender!==SENDER||h.blocked!==false)throw new Error('email grant not ready');});
        if(profile.ok)stage('gmail-labels',function(){summary.labelPresent=(api('labels').labels||[]).some(function(l){return l.name==='Celestan';});});else skip('gmail-labels');
        stage('trigger-inventory',function(){var handlers=ScriptApp.getProjectTriggers().map(function(t){var n=String(t.getHandlerFunction());return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(n)?n:'(invalid-handler)';}).sort();summary.triggerHandlerNames=handlers;summary.triggerCount=handlers.length;summary.emailTriggerCount=handlers.filter(function(n){return n==='vnextEmailTick';}).length;});
        if(mutate&&!failed&&modelCheck.ok){
          stage('property-write',function(){checkBindings();writeAttempted=true;p.setProperties(desired,false);});
          if(writeAttempted)stage('property-readback',function(){var actual=p.getProperties();summary.propertyCounts=countsOf(actual);preparedMatch=matches(actual);readbackConfirmed=preparedMatch;if(!preparedMatch)throw new Error('prepare: property readback mismatch');});
        }
        if(!mutate)readbackConfirmed=preparedMatch===true;
      }
    }finally{if(locked)stage('script-lock',function(){lock.releaseLock();});}
    var result=Object.assign({status:failed?'blocked':mutate?'prepared':'diagnosed',readOnly:!mutate,configWriteAttempted:writeAttempted,readbackConfirmed:readbackConfirmed,preparedConfigMatch:preparedMatch,properties:properties,stages:stages},summary);
    if(mutate&&!failed)Object.assign(result,{enabled:false,instance:desired.CT_VNEXT_EMAIL_INSTANCE,mailbox:MAILBOX,allowedSender:SENDER,project:summary.project,model:model});
    if(failed)result.reason=firstReason;
    console.log(JSON.stringify(result));if(mutate&&failed)throw new Error(firstReason);return result;
  }
  function prepare(){return preparation(true);}
  function diagnose(){return preparation(false);}
  function createEmailTrigger(){return ScriptApp.newTrigger('vnextEmailTick').timeBased().everyMinutes(5).create();}
  function activationTriggers(){
    var all=ScriptApp.getProjectTriggers(),legacy=[],email=[];
    all.forEach(function(t){var n=t.getHandlerFunction();if(n==='gasSafetyWake')legacy.push(t);else if(n==='vnextEmailTick')email.push(t);else throw new Error('activation-unknown-trigger');});
    if(legacy.length>1||email.length>1)throw new Error('activation-duplicate-trigger');
    return {legacy:legacy,email:email};
  }
  function activate(){
    var stage='feedback-diagnostic',p,mutated=false,retired=0,creationAttempted=false,counts=null,model=null,result;
      // Reality first, read-only: no Feedback setup, Sheets reads or legacy ledger.
      var feedback=diagnoseFeedbackInbox();
       if(!feedback||typeof feedback.script_id!=='string'||!feedback.script_id||ScriptApp.getScriptId()!==feedback.script_id||props().getProperty('CT_VNEXT_EMAIL_APPROVED_SCRIPT_ID')!==ScriptApp.getScriptId())throw new Error('activation-script-mismatch');
      stage='script-lock';
      result=setupLock(function(){
        try{
          stage='persisted-config';p=props();var c=config(false);model=c.model;
           if(!/^[A-Za-z0-9_-]{1,100}$/.test(c.instance||'')||!/^https:\/\/[^\s/@?#]+(?:\/[A-Za-z0-9._~!$&'()*+,;=:@%-]*)*$/.test(c.url||'')||!c.label||c.label.length>100||! /^[A-Za-z0-9._-]+\/[A-Za-z0-9._:/-]+$/.test(model)||['false','true'].indexOf(p.getProperty('CT_VNEXT_EMAIL_ENABLED'))<0)throw new Error('activation-config-mismatch');
          stage='gmail-profile';if(address(api('profile').emailAddress)!==MAILBOX)throw new Error('activation-mailbox-mismatch');
          stage='data-api-health';var h=rpc(c,'health');
          if(h.instance!==c.instance||!h.project||h.mailbox!==MAILBOX||h.allowed_sender!==SENDER||!h.grant_ref||h.blocked!==false||h.uncertain!==0)throw new Error('activation-grant-not-ready');
          stage='gmail-labels';if(!(api('labels').labels||[]).some(function(l){return l.name==='Celestan';}))throw new Error('activation-label-missing-create-Celestan-filter-in-Gmail');
          stage='trigger-inventory';counts=activationTriggers();
          stage='retire-future-legacy';mutated=true;
          p.setProperty('CT_AUTONOMY_MODE','vnext');if(p.getProperty('CT_AUTONOMY_MODE')!=='vnext')throw new Error('activation-mode-readback');
          var original=counts.legacy;
          original.forEach(function(t){try{ScriptApp.deleteTrigger(t);}catch(_){} });
          counts=activationTriggers();if(counts.legacy.length)throw new Error('activation-legacy-retirement-unresolved');retired=original.length;
          if(p.getProperty('CT_GAS_SAFETY_TRIGGER')!==null)p.deleteProperty('CT_GAS_SAFETY_TRIGGER');
          stage='install-trigger';
          if(!counts.email.length){
            // Keep polling disabled throughout an uncertain trigger creation,
            // including an execution interruption that cannot run compensation.
            if(p.getProperty('CT_VNEXT_EMAIL_ENABLED')!=='false')p.setProperty('CT_VNEXT_EMAIL_ENABLED','false');
            if(p.getProperty('CT_VNEXT_EMAIL_ENABLED')!=='false')throw new Error('activation-enabled-readback');
            creationAttempted=true;try{createEmailTrigger();}catch(_){}
          }
          // An ambiguous create is read back once, never blindly retried.
          stage='trigger-readback';counts=activationTriggers();if(counts.legacy.length||counts.email.length!==1)throw new Error('activation-trigger-outcome-unresolved');
          stage='enable';p.setProperty('CT_VNEXT_EMAIL_ENABLED','true');if(p.getProperty('CT_VNEXT_EMAIL_ENABLED')!=='true')throw new Error('activation-enabled-readback');
          return {status:'active',enabled:true,mailbox:MAILBOX,allowedSender:SENDER,model:model,readiness:'verified',triggerCounts:{legacy:0,email:1},retiredLegacyCount:retired,creationAttempted:creationAttempted,inFlightLegacyCancelled:false};
        }catch(e){
          var disabled=null;if(mutated){try{p.setProperty('CT_VNEXT_EMAIL_ENABLED','false');disabled=p.getProperty('CT_VNEXT_EMAIL_ENABLED')==='false';}catch(_){disabled=null;}}
          var reasons=['activation-config-mismatch','activation-mailbox-mismatch','activation-grant-not-ready','activation-label-missing-create-Celestan-filter-in-Gmail','activation-unknown-trigger','activation-duplicate-trigger','activation-mode-readback','activation-legacy-retirement-unresolved','activation-enabled-readback','activation-trigger-outcome-unresolved'];
          return {status:'blocked',stage:stage,reason:reasons.indexOf(e&&e.message)>=0?e.message:'activation-readiness-or-effect-unavailable',failure:safeFailure(e),enabled:disabled===true?false:null,disabledConfirmed:disabled,mutationAttempted:mutated,creationAttempted:creationAttempted,retiredLegacyCount:retired,next:creationAttempted?'inspect owner triggers before any explicit retry':'resolve reported readiness before activation'};
        }
      });
    }catch(e){result={status:'blocked',stage:stage,reason:e&&e.message==='activation-script-mismatch'?'activation-script-mismatch':'activation-owner-context-unavailable',failure:safeFailure(e),mutationAttempted:mutated,creationAttempted:creationAttempted};}
    console.log(JSON.stringify(result));return result;
  }
  function pause(){var result;try{result=setupLock(function(){var p=props();p.setProperty('CT_VNEXT_EMAIL_ENABLED','false');if(p.getProperty('CT_VNEXT_EMAIL_ENABLED')!=='false')throw new Error('pause-readback-unresolved');return {status:'paused',enabled:false,inFlightCancelled:false};});}catch(_){result={status:'blocked',reason:'pause-outcome-unresolved',enabled:null};}console.log(JSON.stringify(result));return result;}

  return {diagnoseDelivery:diagnoseDelivery,install:install,inventory:inventory,health:health,configure:configure,prepare:prepare,diagnose:diagnose,activate:activate,pause:pause};
}());
function ownerEmailCall(name,args){if(typeof CT_GAS_VNEXT_EMAIL_OWNER==='undefined')throw new Error('email owner module unavailable');return CT_GAS_VNEXT_EMAIL_OWNER[name].apply(null,args||[]);}
function installVnextEmailTrigger(){return ownerEmailCall('install');}
function inventoryVnextEmailProperties(){var result=ownerEmailCall('inventory');console.log(JSON.stringify(result));return result;}
function healthVnextEmailRuntime(){return ownerEmailCall('health');}
function configureVnextEmailRuntime(config){return ownerEmailCall('configure',[config]);}
function prepareVnextEmailRuntime(){return ownerEmailCall('prepare');}
function diagnoseVnextEmailPreparation(){return ownerEmailCall('diagnose');}
function diagnoseVnextEmailDelivery(){return ownerEmailCall('diagnoseDelivery');}
function activateVnextEmailRuntime(){return ownerEmailCall('activate');}
function pauseVnextEmailRuntime(){return ownerEmailCall('pause');}
