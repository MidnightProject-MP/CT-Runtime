import { parentPort, workerData } from 'node:worker_threads';
import { readFile } from 'node:fs/promises';
import { testPool } from './pilot-test-pool.mjs';
const pool=await testPool();
const claims={sub:'gas-owner',aud:'gas-client',iss:'https://accounts.google.com',exp:4102444800};
try {
  await pool.query("DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF; IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anonymous') THEN CREATE ROLE anonymous NOLOGIN; END IF; END $$");
  const bootstrap=JSON.parse(await readFile(new URL('../deploy/gas-email/bootstrap.json',import.meta.url)));
  for(const file of bootstrap.files) await pool.query(await readFile(new URL('../'+file,import.meta.url),'utf8'));
  await pool.query("INSERT INTO gas_email_instances VALUES ('gas-test','gas-owner','gas-client','email-project','midnight.project.mp@gmail.com','midnightprojectantigravity@gmail.com',true,'reviewed:text-only:v1')");
  parentPort.postMessage({ready:true});
} catch(e){parentPort.postMessage({error:e.message});}
parentPort.on('message',async message=>{
  const signal=new Int32Array(workerData.signal),bytes=new Uint8Array(workerData.bytes);
  let answer;
  try {
    if(message.type==='close'){await pool.end();parentPort.postMessage({closed:true});return;}
    if(message.type==='sql')answer=(await pool.query(message.sql,message.args)).rows;
    else {
      const client=await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query("SELECT set_config('request.jwt.claims',$1,true)",[JSON.stringify(message.claims||claims)]);
        await client.query('SET LOCAL ROLE authenticated');
        answer=(await client.query('SELECT gas_email_rpc($1,$2,$3::jsonb) AS result',[message.instance||'gas-test',message.operation,JSON.stringify(message.input||{})])).rows[0].result;
        await client.query('COMMIT');
      }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
    }
    answer={result:answer};
  }catch(e){answer={error:e.message};}
  const encoded=new TextEncoder().encode(JSON.stringify(answer));bytes.set(encoded);Atomics.store(signal,1,encoded.length);Atomics.store(signal,0,1);Atomics.notify(signal,0);
});
