import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { once } from 'node:events';
import { createSqlWorkerClient } from './gas-email-sql-client.mjs';

test('GAS SQL worker ignores a stale response and returns the matching request', {timeout:60000}, async ()=>{
  const signal=new SharedArrayBuffer(8),bytes=new SharedArrayBuffer(2000000);
  const worker=new Worker(new URL('./gas-email-sql-worker.mjs',import.meta.url),{workerData:{signal,bytes}});
  const [ready]=await once(worker,'message');assert.equal(ready.error,undefined);
  try {
    worker.postMessage({type:'sql',sql:'SELECT 1 AS stale',sequence:1});
    const client=createSqlWorkerClient(worker,{signal,bytes,startSequence:1});
    assert.deepEqual(client.sql('SELECT 2 AS current'),[{current:2}]);
  } finally {
    worker.postMessage({type:'close'});
    await once(worker,'message');
    await worker.terminate();
  }
});

test('stale blocked response cannot masquerade as the current uncertain result', {timeout:10000}, async ()=>{
  const signal=new SharedArrayBuffer(8),bytes=new SharedArrayBuffer(4096);
  const source=`
    const {parentPort,workerData}=require('node:worker_threads');
    const signal=new Int32Array(workerData.signal),bytes=new Uint8Array(workerData.bytes);
    let queue=Promise.resolve();
    parentPort.on('message',message=>{queue=queue.then(async()=>{
      if(message.operation==='claim')await new Promise(resolve=>setTimeout(resolve,100));
      const result=message.operation==='claim'?{status:'blocked'}:{status:'uncertain'};
      const encoded=new TextEncoder().encode(JSON.stringify({result,sequence:message.sequence}));
      bytes.set(encoded);Atomics.store(signal,1,encoded.length);Atomics.store(signal,0,message.sequence);Atomics.notify(signal,0);
    });});
  `;
  const worker=new Worker(source,{eval:true,workerData:{signal,bytes}});
  const client=createSqlWorkerClient(worker,{signal,bytes});
  try{
    client.enqueue({type:'rpc',operation:'claim'});
    assert.deepEqual(client.rawRpc('delivery-peek'),{status:'uncertain'});
  }finally{await worker.terminate();}
});
