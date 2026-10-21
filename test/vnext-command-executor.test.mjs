import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {createCommandExecutor} from '../lib/vnext/command-executor.mjs';

test('command executor returns bounded structured result without inheriting database credentials',async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'command-'));
 try {
  const script=path.join(dir,'worker.mjs');
  await writeFile(script,`import {writeFileSync} from 'node:fs'; writeFileSync(process.env.CT_VNEXT_RESULT_FILE,JSON.stringify({secret:process.env.CT_PILOT_DATABASE_URL??null,ok:true}));`);
  const previous=process.env.CT_PILOT_DATABASE_URL;process.env.CT_PILOT_DATABASE_URL='must-not-reach-worker';
  try {
   const execute=createCommandExecutor({command:process.execPath,args:[script],stateDirectory:dir});
   assert.deepEqual(await execute({execution:{execution_id:'test-good'},workspaceRoot:dir,timeoutMs:1000}),{secret:null,ok:true});
  } finally {if(previous===undefined) delete process.env.CT_PILOT_DATABASE_URL;else process.env.CT_PILOT_DATABASE_URL=previous;}
 } finally {await rm(dir,{recursive:true,force:true});}
});

test('timeout kills the process group and never accepts an early result',async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'timeout-'));
 try {
  const script=path.join(dir,'worker.mjs');
  await writeFile(script,`import {writeFileSync} from 'node:fs';import {spawn} from 'node:child_process';const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});writeFileSync(${JSON.stringify(path.join(dir,'pid'))},String(c.pid));writeFileSync(process.env.CT_VNEXT_RESULT_FILE,'{}');setInterval(()=>{},1000);`);
  const execute=createCommandExecutor({command:process.execPath,args:[script],stateDirectory:dir});
  await assert.rejects(execute({execution:{execution_id:'test-timeout'},workspaceRoot:dir,timeoutMs:2000}),/timed out/);
  const pid=Number(await readFile(path.join(dir,'pid'),'utf8'));
  // A killed descendant can briefly remain running or a zombie until the signal is delivered and PID 1 reaps it.
  let state=null;
  for (const deadline=Date.now()+2000;;) {
   try {state=await readFile(`/proc/${pid}/stat`,'utf8');} catch(e) {assert.ok(e.code==='ENOENT'||e.code==='ESRCH',`unexpected /proc read failure: ${e.code}`);state=null;break;}
   if (/\) [ZX] /.test(state)||Date.now()>=deadline) break;
   await new Promise(r=>setTimeout(r,20));
  }
  if(state) assert.match(state,/\) [ZX] /,`descendant ${pid} still running after timeout`);
 } finally {await rm(dir,{recursive:true,force:true});}
});

test('purpose-bound read-only assignments use their dedicated command profile', { skip: process.platform !== 'linux' }, async () => {
 const dir=await mkdtemp(path.join(tmpdir(),'command-purpose-'));
 try {
  const execution=path.join(dir,'execution.mjs'),review=path.join(dir,'review.mjs');
  await writeFile(execution,`import {writeFileSync} from 'node:fs';writeFileSync(process.env.CT_VNEXT_RESULT_FILE,JSON.stringify({profile:'execution'}));`);
  await writeFile(review,`import {writeFileSync} from 'node:fs';writeFileSync(process.env.CT_VNEXT_RESULT_FILE,JSON.stringify({profile:process.argv[2]}));`);
  const execute=createCommandExecutor({command:process.execPath,args:[execution],stateDirectory:path.join(dir,'exec'),purposeExecutors:{
   review:{command:process.execPath,args:[review,'{assignment.purpose}'],stateDirectory:path.join(dir,'review')},
  }});
  assert.deepEqual(await execute({execution:{execution_id:'purpose-review'},assignment:{purpose:'review',model:'review-model',agent:'read-only-reviewer',access_class:'read-only'},workspaceRoot:dir,timeoutMs:2000}),{profile:'review'});
  await assert.rejects(execute({execution:{execution_id:'purpose-diagnosis'},assignment:{purpose:'diagnosis',model:'model',agent:'agent',access_class:'read-only'},workspaceRoot:dir,timeoutMs:2000}),/purpose-specific read-only executor/);
 } finally {await rm(dir,{recursive:true,force:true});}
});
