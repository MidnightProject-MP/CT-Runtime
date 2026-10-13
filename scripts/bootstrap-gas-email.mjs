// Owner-only, exact fresh target. No credential/SQL/raw-error output.
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Pool } from 'pg';

export const TARGET=Object.freeze({project:'steep-fog-88521756',branch:'br-falling-sky-b4d1fow0',host:'ep-weathered-tree-b4v72i6c.c-6.us-east-2.aws.neon.tech',database:'neondb',owner:'neondb_owner'});
const sha=s=>createHash('sha256').update(s).digest('hex');
export function validateTarget(value){
  const u=new URL(value);
  if(!['postgres:','postgresql:'].includes(u.protocol)||u.hostname!==TARGET.host||u.pathname!==`/${TARGET.database}`||decodeURIComponent(u.username)!==TARGET.owner||!u.password||(u.port&&u.port!=='5432')||!['require','verify-full'].includes(u.searchParams.get('sslmode'))||u.hash)throw new Error('bootstrap target rejected');
  for(const k of u.searchParams.keys())if(!['sslmode','channel_binding'].includes(k))throw new Error('bootstrap connection option rejected');
  return value;
}
export async function loadManifest(){
  const root=new URL('../',import.meta.url),raw=await readFile(new URL('deploy/gas-email/bootstrap.json',root),'utf8'),manifest=JSON.parse(raw);
  const files=[];
  for(const path of manifest.files){
    if(!/^(vnext-migrations\/[0-9]{3}_[a-z_]+\.sql|deploy\/gas-email\/schema\.sql)$/.test(path))throw new Error('invalid bootstrap manifest');
    const sql=(await readFile(new URL(path,root),'utf8')).replace(/\r\n/g,'\n');files.push({path,sha256:sha(sql),sql});
  }
  const checksums=files.map(({path,sha256})=>({path,sha256}));
  return {files,checksums,hash:sha(JSON.stringify(checksums))};
}
async function roles(client){
  const r=await client.query("SELECT rolname,rolcanlogin,rolsuper,rolcreaterole,rolcreatedb,rolreplication,rolbypassrls FROM pg_roles WHERE rolname IN ('authenticated','anonymous')");
  if(r.rows.some(row=>Object.entries(row).some(([k,v])=>k!=='rolname'&&v)))throw new Error('unsafe existing API roles');
  const membership=await client.query("SELECT 1 FROM pg_auth_members WHERE member IN (SELECT oid FROM pg_roles WHERE rolname IN ('authenticated','anonymous'))");
  if(membership.rows.length)throw new Error('API role inheritance rejected');
  return r.rows.map(r=>r.rolname);
}
export async function readback(client){
  await roles(client);
  const tables=(await client.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows;
  const denied=(await client.query(`SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace s ON s.oid=c.relnamespace
    CROSS JOIN (VALUES ('authenticated'),('anonymous')) AS roles(name)
    WHERE s.nspname='public' AND c.relkind IN ('r','p','v','m','f') AND
    (has_table_privilege(roles.name,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR has_any_column_privilege(roles.name,c.oid,'SELECT,INSERT,UPDATE,REFERENCES'))`)).rows[0].n;
  const grants=(await client.query(`SELECT has_function_privilege('authenticated','public.gas_email_rpc(text,text,jsonb)','EXECUTE') AS rpc,
    has_function_privilege('anonymous','public.gas_email_rpc(text,text,jsonb)','EXECUTE') AS anonymous_rpc,
    has_function_privilege('authenticated','public.gas_email_principal(text)','EXECUTE') AS internal,
    has_schema_privilege('authenticated','public','CREATE') AS schema_create,
    (SELECT count(*)::int FROM gas_email_instances) AS registered,
    (SELECT count(*)::int FROM gas_email_instances WHERE active) AS active`)).rows[0];
  const otherFunctions=(await client.query(`SELECT count(*)::int AS n FROM pg_proc p JOIN pg_namespace s ON s.oid=p.pronamespace
    CROSS JOIN (VALUES ('authenticated'),('anonymous')) AS roles(name) WHERE s.nspname='public'
    AND has_function_privilege(roles.name,p.oid,'EXECUTE')
    AND NOT (roles.name='authenticated' AND p.oid='public.gas_email_rpc(text,text,jsonb)'::regprocedure)`)).rows[0].n;
  const sequences=(await client.query(`SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace s ON s.oid=c.relnamespace
    CROSS JOIN (VALUES ('authenticated'),('anonymous')) AS roles(name)
    WHERE s.nspname='public' AND c.relkind='S' AND has_sequence_privilege(roles.name,c.oid,'USAGE,SELECT,UPDATE')`)).rows[0].n;
  if(denied!==0||otherFunctions!==0||sequences!==0||!grants.rpc||grants.anonymous_rpc||grants.internal||grants.schema_create)throw new Error('bootstrap privilege readback failed');
  // Even the owner calling this SECURITY DEFINER RPC must present a registered
  // JWT principal. Probe that boundary without SET ROLE: managed Neon owners may
  // create NOLOGIN roles without permission to assume them. ACLs above establish
  // authenticated's sole RPC permission separately; no role grant is needed.
  await client.query('SAVEPOINT auth_probe');let deniedPrincipal=false;
  await client.query("SELECT set_config('request.jwt.claims','{}',true)");
  try{await client.query("SELECT public.gas_email_rpc('unregistered-bootstrap-probe','health','{}'::jsonb)");}
  catch(e){deniedPrincipal=e.code==='42501'&&e.message==='email principal denied';}
  finally{await client.query('ROLLBACK TO SAVEPOINT auth_probe');await client.query('RELEASE SAVEPOINT auth_probe');}
  if(!deniedPrincipal)throw new Error('unauthenticated principal was not denied');
  return {tables:tables.length,registeredInstances:grants.registered,activeInstances:grants.active,directTableGrants:denied,authenticatedRpcOnly:true,unauthenticatedDenied:true};
}
export async function bootstrap(pool,{apply=false,validate=false,manifest}={}){
  manifest=manifest||await loadManifest();const client=await pool.connect();let phase='inspection';
  try{
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout='10s'; SET LOCAL statement_timeout='60s'");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('ct-runtime:gas-email-bootstrap',0))");
    const exists=(await client.query("SELECT to_regclass('public.gas_email_bootstrap_ledger') IS NOT NULL AS present")).rows[0].present;
    if(exists){
      const rows=(await client.query('SELECT manifest_sha256,files FROM public.gas_email_bootstrap_ledger')).rows;
      if(rows.length!==1||rows[0].manifest_sha256!==manifest.hash||JSON.stringify(rows[0].files.map(x=>({path:x.path,sha256:x.sha256})))!==JSON.stringify(manifest.checksums))throw new Error('bootstrap ledger checksum mismatch');
      const result=await readback(client);await client.query('ROLLBACK');return {status:'already-applied',manifestSha256:manifest.hash,files:manifest.files.length,...result};
    }
    const objects=(await client.query(`SELECT
      (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public')+
      (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public')+
      (SELECT count(*) FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname='public') AS n`)).rows[0];
    if(Number(objects.n)!==0)throw new Error('bootstrap public schema is not empty');
    const existing=await roles(client);
    if(!apply&&!validate){await client.query('ROLLBACK');return {status:'empty-ready',manifestSha256:manifest.hash,files:manifest.files.length,publicObjects:0};}
    phase='roles';
    for(const role of ['authenticated','anonymous'])if(!existing.includes(role))await client.query(`CREATE ROLE ${role} NOLOGIN`);
    for(const file of manifest.files){phase=file.path;await client.query(file.sql);}
    // After extension bootstrap: its fresh-schema guard intentionally rejects
    // unrelated pre-existing tables, so the ledger is created last, atomically.
    phase='ledger';await client.query(`CREATE TABLE public.gas_email_bootstrap_ledger (singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),manifest_sha256 text NOT NULL,files jsonb NOT NULL,applied_at timestamptz NOT NULL DEFAULT clock_timestamp());
      REVOKE ALL ON public.gas_email_bootstrap_ledger FROM PUBLIC,authenticated,anonymous`);
    await client.query('INSERT INTO public.gas_email_bootstrap_ledger(manifest_sha256,files) VALUES($1,$2::jsonb)',[manifest.hash,JSON.stringify(manifest.checksums)]);
    phase='readback';const result=await readback(client);phase='commit';await client.query(validate?'ROLLBACK':'COMMIT');return {status:validate?'validated-rolled-back':'applied',manifestSha256:manifest.hash,files:manifest.files.length,...result};
  }catch(e){await client.query('ROLLBACK').catch(()=>{});e.bootstrapPhase=e.bootstrapPhase||phase;throw e;}finally{client.release();}
}
async function main(){
  const mode=process.argv[2];if(!['inspect','validate','apply'].includes(mode))throw new Error('explicit bootstrap mode required');
  const url=validateTarget(process.env.CT_BOOTSTRAP_DATABASE_URL),pool=new Pool({connectionString:url,max:1,connectionTimeoutMillis:15000});
  try{
    const identity=await pool.query('SELECT current_database() AS database,current_user AS owner');
    if(identity.rows[0].database!==TARGET.database||identity.rows[0].owner!==TARGET.owner)throw new Error('bootstrap database identity mismatch');
    const result=await bootstrap(pool,{apply:mode==='apply',validate:mode==='validate'});console.log(JSON.stringify({target:TARGET,...result}));
  }finally{await pool.end();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(e=>{console.error(JSON.stringify({status:'failed-or-uncertain',phase:e.bootstrapPhase||'connection-or-target',sqlstate:/^[0-9A-Z]{5}$/.test(e.code||'')?e.code:null,check:['unsafe existing API roles','API role inheritance rejected','bootstrap privilege readback failed','unauthenticated principal was not denied'].includes(e.message)?e.message:null,next:'inspect before retry; credentials and SQL errors withheld'}));process.exitCode=1;});
