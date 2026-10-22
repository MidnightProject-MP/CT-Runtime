// Deterministic disposable-process proof; no model or external project mutation.
// Run twice with the same absolute state directory, at least one second apart.
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {testPool} from '../test/pilot-test-pool.mjs';
import {migrateVNext} from '../lib/vnext/migration.mjs';
import {createPilotStore} from '../lib/vnext/pilot-store.mjs';
import {runPilotOnce} from '../lib/vnext/pilot.mjs';
import {createCommandExecutor} from '../lib/vnext/command-executor.mjs';
import {verifyTurnEvidenceIntegrity} from '../lib/objective-turn.mjs';
const directory=process.argv[2];
if(!directory || !path.isAbsolute(directory)) throw new Error('absolute proof state directory required');
if(process.env.TEST_DATABASE_URL) throw new Error('proof uses its own local database; unset TEST_DATABASE_URL');
await mkdir(directory,{recursive:true});
const identity=path.join(directory,'identity.md');
await writeFile(identity,'Celestan proof identity: make two checked increments, preserve durable continuity.');
 const pool=await testPool({dataDir:path.join(directory,'db')});
 // Acceptance is granted as a distinct decision identity, and the store
 // independently re-confirms it for the same execution and turn.
  const grantAcceptance=async(context)=>{await verifyTurnEvidenceIntegrity(context.turn,{workspaceRoot:directory});return context.turn.summary==='Two checked increments complete.' && context.evidence?.length===1 && (await readFile(path.join(directory,'outcome.txt'),'utf8'))==='2';};
  const decisions=new Map();
  const authority={
  authorizeExecution: async ({execution})=>({ref:`proof:${execution.execution_id}`}),
  verifyExecution: async (d,{execution})=>d.ref===`proof:${execution.execution_id}`,
   authorizeTerminal: async (context)=>{if(!await grantAcceptance(context))return false;const d={ref:`acceptance:${randomUUID()}`,snapshotDigest:context.snapshotDigest};decisions.set(d.ref,d.snapshotDigest);return d;},
   verifyAcceptance: async (decision,context)=>decisions.get(decision.ref)===context.snapshotDigest && decision.snapshotDigest===context.snapshotDigest && await grantAcceptance(context),
 };
try {
 await pool.query("DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF; IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anonymous') THEN CREATE ROLE anonymous; END IF; END $$");
 await migrateVNext({pool,directory:path.join(import.meta.dirname,'../vnext-migrations')});
  const store=createPilotStore({pool,authorizationVerifier:authority.verifyExecution,acceptanceVerifier:authority.verifyAcceptance,intervalMs:1000});
 await store.submit({projectId:'proof-project',threadId:'proof-thread',receiptId:'proof-receipt',message:'Produce two checked increments across separate wakes.'});
 const executor=createCommandExecutor({command:process.execPath,args:[path.join(import.meta.dirname,'../test/fixtures/vnext-proof-worker.mjs')],stateDirectory:path.join(directory,'attempts')});
  const attempt=()=>runPilotOnce({store,projectId:'proof-project',workspaceRoot:directory,identityFiles:[identity],authority,executor});
  let result=await attempt();
  // The proof's scheduling window is wall-clock based. A clock correction can
  // make an already durable continuation temporarily ineligible; retry the
  // coordinator tick until that bounded window passes instead of treating the
  // transient ineligibility as lost work.
  for(let tries=0;tries<10&&result.disposition==='quiesced';tries++){await new Promise(resolve=>setTimeout(resolve,1000));result=await attempt();}
  if(!['continue','terminal'].includes(result.disposition)) throw new Error('proof did not advance or accept work');
  console.log(JSON.stringify(result,null,2));
} finally {await pool.end();}
