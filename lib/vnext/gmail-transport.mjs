import crypto from 'node:crypto';
import { canonicalJson } from '../config.mjs';
export function createGmailTransport({url,secret,fetch=globalThis.fetch}={}) {
  if (!url || !secret || typeof fetch!=='function') throw new Error('Gmail transport configuration required');
  return async (operation,payload={}) => {
    if(!['email-poll','email-ack','email-send'].includes(operation)) throw new Error('unsupported operation');
    const body=canonicalJson({...payload,operation});
    if(Buffer.byteLength(body)>32768) throw new Error('email request too large');
    const timestamp=String(Math.floor(Date.now()/1000));
    const target=new URL(url);target.searchParams.set('timestamp',timestamp);
    target.searchParams.set('signature',crypto.createHmac('sha256',secret).update(timestamp+'.'+body).digest('hex'));
    const response=await fetch(target,{method:'POST',headers:{'content-type':'application/json'},body,signal:AbortSignal.timeout(45000)});
    const result=JSON.parse(await response.text());
    if(!response.ok || result.status==='rejected') throw new Error('Gmail bridge rejected request');
    return result;
  };
}
