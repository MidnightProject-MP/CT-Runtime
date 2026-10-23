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
