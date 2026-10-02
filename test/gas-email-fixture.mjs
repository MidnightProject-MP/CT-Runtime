import vm from 'node:vm';
import { readFileSync } from 'node:fs';
export function gasEmailFixture(rpc) {
  const values={CT_VNEXT_EMAIL_ENABLED:'true',CT_VNEXT_EMAIL_INSTANCE:'gas-test',CT_VNEXT_EMAIL_DATA_API_URL:'https://test.neon.tech',CT_VNEXT_EMAIL_MODEL:'test/model',CT_VNEXT_EMAIL_LABEL:'Celestan',OPENROUTER_API_KEY:'test-openrouter-secret'};
  const messages=new Map();let sends=0,loseSend=false,searchVisible=true,loseCheckpoint=false,loseAdmission=false;
  let model=()=>({disposition:'done',summary:'Here is a useful draft.',artifact:'A bounded answer.'});
  let ticks=0,now=Date.now();const triggers=[];
  function add(id,thread='thread1',body='Draft a brief thank-you.',sender='midnightprojectantigravity@gmail.com') {
    messages.set(id,{id,threadId:thread,labelIds:['queue'],payload:{mimeType:'text/plain',headers:[{name:'From',value:sender},{name:'To',value:'midnight.project.mp@gmail.com'},{name:'Subject',value:'A useful task'},{name:'Message-ID',value:`<${id}@example.com>`}],body:{data:Buffer.from(body).toString('base64url')}}});
  }
  const forbidden=()=>{throw new Error('forbidden runtime persistence');};
  const context=()=>vm.createContext({Date:class extends Date {static now(){return now;}},PropertiesService:{getScriptProperties:()=>({getProperty:k=>values[k]??null,getProperties:()=>({...values}),setProperty:forbidden,setProperties:forbidden,deleteProperty:forbidden})},SpreadsheetApp:new Proxy({},{get:forbidden}),
    ScriptApp:{getIdentityToken:()=> 'test-google-jwt',getOAuthToken:()=> 'test-oauth',getProjectTriggers:()=>triggers,newTrigger:name=>({timeBased(){return this;},everyMinutes(){return this;},create(){triggers.push({getHandlerFunction:()=>name});}})},
    LockService:{getScriptLock:()=>({tryLock:()=>true,releaseLock(){}})},
    Utilities:{Charset:{UTF_8:'UTF-8'},base64Encode:s=>Buffer.from(s).toString('base64'),base64EncodeWebSafe:s=>Buffer.from(s).toString('base64url'),base64DecodeWebSafe:s=>Buffer.from(s,'base64url'),newBlob:s=>({getDataAsString:()=>Buffer.from(s).toString('utf8')})},
    UrlFetchApp:{fetch:(url,opts)=>{
      const u=new URL(url);let result;
      if(u.hostname==='test.neon.tech'){
        if(opts.headers.Authorization!=='Bearer test-google-jwt')throw new Error('missing jwt');
        const p=JSON.parse(opts.payload);result=rpc(p.p_operation,p.p_input);
        if(loseCheckpoint&&p.p_operation==='checkpoint'){loseCheckpoint=false;throw new Error('lost checkpoint response');}
        if(loseAdmission&&p.p_operation==='delivery'&&result.status==='send'){loseAdmission=false;throw new Error('lost admission response');}
      }else if(u.hostname==='openrouter.ai'){
        const request=JSON.parse(opts.payload);if(request.messages[0].role!=='system'||request.messages[1].role!=='user')throw new Error('invalid roles');
        const turn=model(request);result={choices:[{message:{content:typeof turn==='string'?turn:JSON.stringify(turn)}}]};
      }else{
        const route=u.pathname.split('/users/me/')[1];
        if(route==='profile')result={emailAddress:'midnight.project.mp@gmail.com'};
        else if(route==='labels')result={labels:[{id:'queue',name:'Celestan'}]};
        else if(route==='messages'){
          const q=u.searchParams.get('q');result={messages:[...messages.values()].filter(m=>q?searchVisible&&m.labelIds.includes('SENT')&&q.includes(m.payload.headers.find(h=>h.name==='Message-ID').value):m.labelIds.includes('queue')).slice(0,3).map(m=>({id:m.id}))};
        }else if(route==='messages/send'){
          const data=JSON.parse(opts.payload),raw=Buffer.from(data.raw,'base64url').toString(),[head,body]=raw.split('\r\n\r\n'),id='sent'+(++sends);
          const headers=head.split('\r\n').map(line=>{const at=line.indexOf(':');let value=line.slice(at+1).trim();if(value.startsWith('=?UTF-8?B?'))value=Buffer.from(value.slice(10,-2),'base64').toString();return {name:line.slice(0,at),value};});
          messages.set(id,{id,threadId:data.threadId,labelIds:['SENT'],payload:{headers,mimeType:'text/plain',body:{data:Buffer.from(body.replace(/\s/g,''),'base64').toString('base64url')}}});result={id};
          if(loseSend){loseSend=false;throw new Error('lost send response');}
        }else if(route.endsWith('/modify')){const m=messages.get(route.split('/')[1]);m.labelIds=m.labelIds.filter(x=>!JSON.parse(opts.payload).removeLabelIds.includes(x));result=m;}
        else result=messages.get(route.split('/')[1]);
      }
      if(result===undefined)throw new Error('unexpected request');
      return {getResponseCode:()=>200,getContentText:()=>JSON.stringify(result)};
    }}});
  function cold(){const ctx=context();vm.runInContext(readFileSync(new URL('../gas/gas_vnext_email.js',import.meta.url),'utf8'),ctx);return ctx;}
  return {values,messages,add,cold,tick(){ticks++;return cold().vnextEmailTick();},get sends(){return sends;},get ticks(){return ticks;},setModel(fn){model=fn;},advance(ms){now+=ms;},loseNextSend(){loseSend=true;},loseNextCheckpoint(){loseCheckpoint=true;},loseNextAdmission(){loseAdmission=true;},hideSearch(){searchVisible=false;},showSearch(){searchVisible=true;}};
}
