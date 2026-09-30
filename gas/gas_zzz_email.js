/* Gmail API bridge; fixed mailbox/sender policy and durable send-attempt fences. */
var CT_GAS_EMAIL = (function () {
  function props() { return PropertiesService.getScriptProperties(); }
  function address(s) {
    s=String(s||'').trim().toLowerCase();
    var m=s.match(/^[^<>\r\n]*<([^<>\s]+)>$/); if(m)s=m[1];
    if(!/^[a-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(s))throw new Error('invalid mailbox address');
    return s;
  }
  function config(input) {
    var p=props(), c={id:p.getProperty('CT_EMAIL_MAILBOX_ID'),mailbox:address(p.getProperty('CT_EMAIL_MAILBOX_ADDRESS')),sender:address(p.getProperty('CT_EMAIL_ALLOWED_SENDER')),label:p.getProperty('CT_EMAIL_LABEL')};
    if(p.getProperty('CT_EMAIL_PILOT_ENABLED')!=='true'||!c.id||!c.label||input.mailboxId!==c.id||c.sender===c.mailbox)throw new Error('email disabled or misconfigured');
    if(address(api('profile').emailAddress)!==c.mailbox)throw new Error('wrong execution mailbox');
    return c;
  }
  function api(path,body) {
    var options={method:body===undefined?'get':'post',headers:{Authorization:'Bearer '+ScriptApp.getOAuthToken()},muteHttpExceptions:true};
    if(body!==undefined){options.contentType='application/json';options.payload=JSON.stringify(body);}
    var response=UrlFetchApp.fetch('https://gmail.googleapis.com/gmail/v1/users/me/'+path,options);
    if(response.getResponseCode()<200||response.getResponseCode()>=300)throw new Error('Gmail API failed');
    return JSON.parse(response.getContentText());
  }
  function header(message,name) {return ((message.payload.headers||[]).filter(function(h){return h.name.toLowerCase()===name.toLowerCase();})[0]||{}).value||'';}
  function labelId(c) {var label=(api('labels').labels||[]).filter(function(x){return x.name===c.label;})[0];if(!label)throw new Error('queue label missing');return label.id;}
  function admitted(m,c) {return !(m.labelIds||[]).some(function(x){return x==='SENT'||x==='DRAFT';})&&address(header(m,'From'))===c.sender&&address(header(m,'To'))===c.mailbox;}
  function text(part) {
    if(part.mimeType==='text/plain'&&part.body&&part.body.data)return Utilities.newBlob(Utilities.base64DecodeWebSafe(part.body.data)).getDataAsString('UTF-8');
    var parts=part.parts||[];for(var i=0;i<parts.length;i++){var t=text(parts[i]);if(t)return t;}return '';
  }
  function poll(input) {
    var c=config(input), label=labelId(c);
    var refs=api('messages?labelIds='+encodeURIComponent(label)+'&maxResults=10').messages||[],messages=[];
    refs.forEach(function(ref){var m=api('messages/'+encodeURIComponent(ref.id)+'?format=full');
      if(!admitted(m,c))throw new Error('queue contains disallowed message');
      var body=text(m.payload).trim();if(!body||body.length>16000)throw new Error('unsupported or oversized email body');
      messages.push({id:m.id,threadId:m.threadId,from:c.sender,to:c.mailbox,subject:header(m,'Subject')||'(no subject)',body:body});
    });return {status:'ok',messages:messages};
  }
  function ack(input) {
    var c=config(input),label=labelId(c),m=api('messages/'+encodeURIComponent(String(input.messageId))+'?format=full');
    if(!admitted(m,c))throw new Error('message outside sender policy');
    api('messages/'+encodeURIComponent(m.id)+'/modify',{removeLabelIds:[label]});return {status:'acknowledged'};
  }
  function digest(s){return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,s,Utilities.Charset.UTF_8).map(function(b){return ('0'+(b<0?b+256:b).toString(16)).slice(-2);}).join('');}
  function send(input) {
    var c=config(input);
    if(address(input.to)!==c.sender||!/^reply-[A-Za-z0-9._:-]{1,160}$/.test(input.key||'')||!input.threadId||!input.inReplyTo||!input.body||String(input.body).length>8000)throw new Error('invalid reply');
    var original=api('messages/'+encodeURIComponent(input.inReplyTo)+'?format=full');
    if(!admitted(original,c)||original.threadId!==input.threadId)throw new Error('reply provenance conflict');
    var reference=header(original,'Message-ID');
    if(!/^<[^<>\s]+>$/.test(reference))throw new Error('original Message-ID required');
    var subject=String(input.subject||'');if(subject!==(header(original,'Subject')||'(no subject)').trim().slice(0,500))throw new Error('subject provenance conflict');if(/[\r\n]/.test(subject)||subject.length>600)throw new Error('invalid subject');
    var key='CT_EMAIL_SEND_'+digest(c.id+'\n'+input.key), fingerprint=digest(JSON.stringify([input.threadId,input.inReplyTo,c.sender,subject,input.body]));
    var messageId='<'+digest(c.id+'\n'+input.key)+'@ct-runtime.invalid>';
    var lock=LockService.getScriptLock();lock.waitLock(10000);
    try {
      var p=props(), previous=p.getProperty(key), state=previous?JSON.parse(previous):null;
      if(state){
        if(state.fingerprint!==fingerprint)throw new Error('reply identity conflict');
        if(state.messageId)return {status:'sent',messageId:state.messageId};
        // An uncertain attempt is never resent. Gmail search may lag; absence is
        // not evidence of non-delivery. Keep blocked until exact readback exists.
        var found=api('messages?maxResults=10&q='+encodeURIComponent('in:sent rfc822msgid:'+messageId)).messages||[];
        for(var i=0;i<found.length;i++){
          var actual=api('messages/'+encodeURIComponent(found[i].id)+'?format=full');
          if(actual.threadId===input.threadId&&header(actual,'Message-ID')===messageId&&address(header(actual,'To'))===c.sender){state.messageId=actual.id;p.setProperty(key,JSON.stringify(state));return {status:'sent',messageId:actual.id};}
        }
        return {status:'uncertain'};
      }
      // Bound persistent property use without deleting unresolved send fences.
      var keys=Object.keys(p.getProperties()).filter(function(k){return k.indexOf('CT_EMAIL_SEND_')===0;});
      if(keys.length>=500)throw new Error('email send fence capacity requires review');
      state={fingerprint:fingerprint};p.setProperty(key,JSON.stringify(state));
      var raw=['From: '+c.mailbox,'To: '+c.sender,'Subject: =?UTF-8?B?'+Utilities.base64Encode(subject,Utilities.Charset.UTF_8)+'?=',
        'Message-ID: '+messageId,'In-Reply-To: '+reference,'References: '+reference,'MIME-Version: 1.0','Content-Type: text/plain; charset=UTF-8','Content-Transfer-Encoding: base64','',Utilities.base64Encode(String(input.body),Utilities.Charset.UTF_8).match(/.{1,76}/g).join('\r\n')].join('\r\n');
      var sent=api('messages/send',{threadId:input.threadId,raw:Utilities.base64EncodeWebSafe(raw,Utilities.Charset.UTF_8)});
      if(!sent.id)throw new Error('uncertain Gmail result');
      state.messageId=sent.id;p.setProperty(key,JSON.stringify(state));return {status:'sent',messageId:sent.id};
    } finally {lock.releaseLock();}
  }
  return {poll:poll,ack:ack,send:send,profile:function(){return {emailAddress:api('profile').emailAddress};}};
}());
(function(){
  var previous=doPost;
  doPost=function(e){
    var input;try{input=JSON.parse(String(e&&e.postData&&e.postData.contents||''));}catch(_){return previous(e);}
    var methods={'email-poll':'poll','email-ack':'ack','email-send':'send'};
    if(!Object.prototype.hasOwnProperty.call(methods,input.operation))return previous(e);
    try{CT_GAS_FEDERATION.verify(e);return ContentService.createTextOutput(JSON.stringify(CT_GAS_EMAIL[methods[input.operation]](input))).setMimeType(ContentService.MimeType.JSON);}
    catch(_){return ContentService.createTextOutput(JSON.stringify({status:'rejected',reason:'email-request-failed'})).setMimeType(ContentService.MimeType.JSON);}
  };
}());

// Manual read-only consent/readback helper; does not enable polling or send mail.
function authorizeEmailPilotMailbox(){return CT_GAS_EMAIL.profile();}
