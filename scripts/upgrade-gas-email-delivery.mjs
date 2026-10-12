// Owner-only forward upgrade, original bootstrap ledger remains untouched.
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Pool } from 'pg';
import { TARGET,validateTarget,loadManifest,readback } from './bootstrap-gas-email.mjs';
export const UPGRADE='002_delivery_provider_receipts';
export const UPGRADES=[UPGRADE,'003_model_diagnostics'];
export async function upgradeDelivery(pool,{apply=false}={}){
 const files=await Promise.all(UPGRADES.map(async id=>{const sql=(await readFile(new URL('../deploy/gas-email/'+id+'.sql',import.meta.url),'utf8')).replace(/\r\n/g,'\n');return {id,sql,checksum:createHash('sha256').update(sql).digest('hex')};}));
 const manifest=await loadManifest(),c=await pool.connect();
 try{
  await c.query('BEGIN');await c.query("SET LOCAL lock_timeout='10s'; SET LOCAL statement_timeout='60s'");
  await c.query("SELECT pg_advisory_xact_lock(hashtextextended('ct-runtime:gas-email-bootstrap',0))");
  const ledger=(await c.query('SELECT manifest_sha256,files FROM public.gas_email_bootstrap_ledger')).rows;
  if(ledger.length!==1||ledger[0].manifest_sha256!==manifest.hash||JSON.stringify(ledger[0].files.map(x=>({path:x.path,sha256:x.sha256})))!==JSON.stringify(manifest.checksums))throw new Error('bootstrap ledger mismatch');
  await readback(c);
  const registrations=(await c.query('SELECT instance_id,project_id FROM public.gas_email_instances FOR SHARE')).rows;
  if(registrations.length>1||(registrations.length===1&&(registrations[0].instance_id!=='gas-vnext-email'||registrations[0].project_id!=='celestan-email')))throw new Error('upgrade registration mismatch');
  const exists=(await c.query("SELECT to_regclass('public.gas_email_upgrade_ledger') IS NOT NULL AS present")).rows[0].present;
   const rows=exists?(await c.query('SELECT upgrade_id,sha256 FROM public.gas_email_upgrade_ledger ORDER BY upgrade_id')).rows:[];
   if(rows.length>files.length||rows.some((r,n)=>r.upgrade_id!==files[n].id||r.sha256!==files[n].checksum))throw new Error('upgrade ledger mismatch');
   const pending=files.slice(rows.length),evidence=files.map(f=>({upgrade:f.id,sha256:f.checksum}));
   if(!pending.length||!apply){await c.query('ROLLBACK');return {status:pending.length?'upgrade-ready':'already-applied',applied:rows.map(r=>r.upgrade_id),pending:pending.map(f=>f.id),upgrades:evidence};}
   if(!exists)await c.query('CREATE TABLE public.gas_email_upgrade_ledger(upgrade_id text PRIMARY KEY,sha256 text NOT NULL,applied_at timestamptz NOT NULL DEFAULT clock_timestamp()); REVOKE ALL ON public.gas_email_upgrade_ledger FROM PUBLIC,authenticated,anonymous');
   for(const f of pending){await c.query(f.sql);await c.query('INSERT INTO public.gas_email_upgrade_ledger(upgrade_id,sha256) VALUES($1,$2)',[f.id,f.checksum]);}
   const privileges=await readback(c);await c.query('COMMIT');return {status:'applied',upgrades:evidence,...privileges};
 }catch(e){await c.query('ROLLBACK').catch(()=>{});throw e;}finally{c.release();}
}
async function main(){
 const mode=process.argv[2];if(!['inspect','apply'].includes(mode)||process.argv.length!==3)throw new Error('explicit mode required');
 const pool=new Pool({connectionString:validateTarget(process.env.CT_BOOTSTRAP_DATABASE_URL),max:1,connectionTimeoutMillis:15000});
 try{const r=(await pool.query('SELECT current_database() AS db,current_user AS owner')).rows[0];if(r.db!==TARGET.database||r.owner!==TARGET.owner)throw new Error('wrong target');console.log(JSON.stringify({target:TARGET,...await upgradeDelivery(pool,{apply:mode==='apply'})}));}finally{await pool.end();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(()=>{console.error('Delivery upgrade failed or uncertain; inspect before retry. Credentials and SQL errors withheld.');process.exitCode=1;});
