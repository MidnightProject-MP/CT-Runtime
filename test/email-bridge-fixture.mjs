import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import crypto from 'node:crypto';
export function bridgeFixture() {
  const values={CT_GAS_FEDERATION_HMAC_SECRET:'test-secret',CT_EMAIL_PILOT_ENABLED:'true',CT_EMAIL_MAILBOX_ID:'test-mailbox',CT_EMAIL_MAILBOX_ADDRESS:'bot@example.com',CT_EMAIL_ALLOWED_SENDER:'human@example.com',CT_EMAIL_LABEL:'CT-Runtime'};
  const messages=new Map();let sends=0,loseSend=false,searchVisible=true;
  const properties={getProperty:k=>values[k]??null,setProperty:(k,v)=>{values[k]=v;},getProperties:()=>({...values})};
  function add(id,thread='t1',body='Please check.',sender='human@example.com') {
    messages.set(id,{id,threadId:thread,labelIds:['queue'],payload:{mimeType:'text/plain',headers:[{name:'From',value:sender},{name:'To',value:'bot@example.com'},{name:'Subject',value:'Check'},{name:'Message-ID',value:`<${id}@example.com>`}],body:{data:Buffer.from(body).toString('base64url')}}});
  }
  const ctx=vm.createContext({console,PropertiesService:{getScriptProperties:()=>properties},ScriptApp:{getOAuthToken:()=> 'test-oauth'},LockService:{getScriptLock:()=>({waitLock(){},releaseLock(){}})},Utilities:{Charset:{UTF_8:'UTF-8'},DigestAlgorithm:{SHA_256:'sha256'},computeDigest:(_,s)=>[...crypto.createHash('sha256').update(s).digest()],computeHmacSha256Signature:(s,k)=>[...crypto.createHmac('sha256',k).update(s).digest()],base64Encode:s=>Buffer.from(s).toString('base64'),base64EncodeWebSafe:s=>Buffer.from(s).toString('base64url'),base64DecodeWebSafe:s=>Buffer.from(s,'base64url'),newBlob:s=>({getDataAsString:()=>Buffer.from(s).toString('utf8')})},ContentService:{MimeType:{JSON:'json'},createTextOutput:text=>({getContent:()=>text,setMimeType(){return this;}})},UrlFetchApp:{fetch:(url,opts)=>{
    const u=new URL(url),route=u.pathname.split('/users/me/')[1];let result;
    if(route==='profile')result={emailAddress:'bot@example.com'};
    else if(route==='labels')result={labels:[{id:'queue',name:'CT-Runtime'}]};
    else if(route==='messages'){
      const q=u.searchParams.get('q');result={messages:[...messages.values()].filter(m=>q?searchVisible&&m.labelIds.includes('SENT')&&q.includes(m.payload.headers.find(h=>h.name==='Message-ID').value):m.labelIds.includes('queue')).slice(0,10).map(m=>({id:m.id}))};
    } else if(route==='messages/send'){
      const data=JSON.parse(opts.payload),raw=Buffer.from(data.raw,'base64url').toString();const id='sent-'+(++sends);
      const headers=raw.split('\r\n\r\n')[0].split('\r\n').map(l=>({name:l.slice(0,l.indexOf(':')),value:l.slice(l.indexOf(':')+1).trim()}));
      messages.set(id,{id,threadId:data.threadId,labelIds:['SENT'],payload:{headers}});result={id,threadId:data.threadId};
      if(loseSend){loseSend=false;throw new Error('lost send response');}
    } else if(route.endsWith('/modify')){const m=messages.get(route.split('/')[1]);m.labelIds=m.labelIds.filter(x=>!JSON.parse(opts.payload).removeLabelIds.includes(x));result=m;}
    else result=messages.get(route.split('/')[1]);
    if(!result)throw new Error('unexpected test request '+route);
    return {getResponseCode:()=>200,getContentText:()=>JSON.stringify(result)};
  }}});
  for(const f of ['gas_federation.js','gas_zzz_email.js'])vm.runInContext(readFileSync(new URL('../gas/'+f,import.meta.url),'utf8'),ctx);
  const fetch=async(url,opts)=>{const u=new URL(url);return {ok:true,text:async()=>ctx.doPost({postData:{contents:opts.body},parameter:Object.fromEntries(u.searchParams)}).getContent()};};
  return {fetch,values,messages,add,get sends(){return sends;},loseNextSend(){loseSend=true;},hideSearch(){searchVisible=false;},showSearch(){searchVisible=true;}};
}
