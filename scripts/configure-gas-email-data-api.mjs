// Narrow owner-side role handoff/registration for the already bootstrapped target.
// Neon API creation is deliberately separate; inspect its reality before use.
import { Pool } from 'pg';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { TARGET,validateTarget,loadManifest,bootstrap,readback } from './bootstrap-gas-email.mjs';
export const INSTANCE={instance:'gas-vnext-email',project:'celestan-email',sub:'101290949094805660136',aud:'788761466843-bqaho4ssrgp2ahif41uacv3o832o7hoo.apps.googleusercontent.com',mailbox:'midnight.project.mp@gmail.com',sender:'midnightprojectantigravity@gmail.com',grant:'user-authorized:pr69:gas-text-only:v1'};
export const DATA_API_URL='https://ep-weathered-tree-b4v72i6c.apirest.c-6.us-east-2.aws.neon.tech/neondb/rest/v1';
export async function probe(fetchImpl=fetch,kidOverride){
  let kid=kidOverride;
  if(!kid){const keys=await fetchImpl('https://www.googleapis.com/oauth2/v3/certs',{method:'GET',redirect:'error',signal:AbortSignal.timeout(30000)});if(!keys.ok)throw new Error('public Google keys unavailable');kid=(await keys.json()).keys?.[0]?.kid;}
  if(typeof kid!=='string'||! /^[A-Za-z0-9_-]{1,200}$/.test(kid))throw new Error('public Google key identity invalid');
  const fake=[Buffer.from(JSON.stringify({alg:'RS256',kid})).toString('base64url'),Buffer.from(JSON.stringify({iss:'https://accounts.google.com',sub:INSTANCE.sub,aud:INSTANCE.aud,exp:Math.floor(Date.now()/1000)+300})).toString('base64url'),Buffer.alloc(256,1).toString('base64url')].join('.');
  const result=[];
  for(const [name,token] of [['missing-bearer',null],['invalid-signature',fake]]){
    const r=await fetchImpl(DATA_API_URL+'/rpc/gas_email_rpc',{method:'POST',redirect:'error',signal:AbortSignal.timeout(30000),headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},body:JSON.stringify({p_instance:INSTANCE.instance,p_operation:'health',p_input:{}})});
    const body=typeof r.text==='function'?String(await r.text()).slice(0,12000):'';
    const markers=['missing','required','authorization','jwt','token','signature','invalid','role','schema','function','verify','validation','validate','failed','error','jwk','key','malformed','decode','parse','bearer','format','auth','not','found','valid','sign','credential'].filter(k=>body.toLowerCase().includes(k));
    const missingJwt=r.status===400&&name==='missing-bearer'&&['missing','authorization','jwt','token'].every(k=>markers.includes(k));
    const invalidSignature=r.status===400&&name==='invalid-signature'&&markers.includes('signature')&&['invalid','failed','verify','validation','error'].some(k=>markers.includes(k));
    if(![401,403].includes(r.status)&&!missingJwt&&!invalidSignature){const e=new Error('unexpected unauthenticated HTTP outcome');e.httpStatus=r.status;e.probe=name;e.markers=markers;throw e;}result.push({probe:name,status:r.status,denial:missingJwt?'gateway-missing-jwt':invalidSignature?'gateway-invalid-signature':'unauthorized'});
  }
  return {url:DATA_API_URL,probes:result,matchingGoogleToken:'not-available-not-tested'};
}
export async function roleState(client){
  return (await client.query(`SELECT r.rolname AS name,r.rolcanlogin AS login,r.rolsuper AS superuser,r.rolcreaterole AS create_role,r.rolcreatedb AS create_db,r.rolbypassrls AS bypass_rls,
    (SELECT count(*)::int FROM pg_shdepend d WHERE d.refclassid='pg_authid'::regclass AND d.refobjid=r.oid AND d.deptype='o') AS owned_objects,
    (SELECT count(*)::int FROM pg_shdepend d WHERE d.refclassid='pg_authid'::regclass AND d.refobjid=r.oid AND d.dbid<>0 AND d.dbid<>(SELECT oid FROM pg_database WHERE datname=current_database())) AS other_database_dependencies,
    (SELECT coalesce(json_agg(parent.rolname),'[]'::json) FROM pg_auth_members m JOIN pg_roles parent ON parent.oid=m.roleid WHERE m.member=r.oid) AS inherits
    FROM pg_roles r WHERE r.rolname IN ('authenticated','anonymous','ct_gas_bootstrap_authenticated','ct_gas_bootstrap_anonymous') ORDER BY r.rolname`)).rows;
}
export async function configure(pool,mode){
  if(!['inspect','prepare-roles','restrict-register'].includes(mode))throw new Error('invalid mode');
  if(mode==='prepare-roles')await bootstrap(pool); // Exact ledger and current ACL proof before handoff.
  const c=await pool.connect();try{
    await c.query('BEGIN');await c.query("SET LOCAL lock_timeout='10s'; SET LOCAL statement_timeout='30s'");
    await c.query("SELECT pg_advisory_xact_lock(hashtextextended('ct-runtime:gas-email-bootstrap',0))");
    const manifest=await loadManifest(),ledger=(await c.query('SELECT manifest_sha256,files FROM gas_email_bootstrap_ledger')).rows;
    if(ledger.length!==1||ledger[0].manifest_sha256!==manifest.hash||JSON.stringify(ledger[0].files.map(x=>({path:x.path,sha256:x.sha256})))!==JSON.stringify(manifest.checksums))throw new Error('bootstrap ledger mismatch');
    const roles=await roleState(c);
    const defaults=(await c.query(`SELECT count(*)::int AS n FROM pg_default_acl d CROSS JOIN LATERAL aclexplode(d.defaclacl) a JOIN pg_roles r ON r.oid=a.grantee WHERE r.rolname IN ('authenticated','anonymous','ct_gas_bootstrap_authenticated','ct_gas_bootstrap_anonymous')`)).rows[0].n;
    if(defaults!==0)throw new Error('unexpected API default privileges');
    const counts=(await c.query(`SELECT (SELECT count(*)::int FROM gas_email_instances) AS instances,(SELECT count(*)::int FROM vnext_work_units) AS work_units,(SELECT count(*)::int FROM vnext_executions) AS executions,(SELECT count(*)::int FROM gas_email_outbox) AS replies`)).rows[0];
    if(mode==='inspect'){const instances=(await c.query('SELECT instance_id,project_id,jwt_sub,jwt_aud,mailbox,allowed_sender,grant_ref,active FROM gas_email_instances')).rows;await c.query('ROLLBACK');return {status:'inspected',roles,counts,apiDefaultGrants:defaults,instances};}
    if(counts.work_units||counts.executions||counts.replies)throw new Error('runtime is not empty');
    if(mode==='prepare-roles'){
      if(counts.instances||roles.length!==2||roles.some(r=>!['authenticated','anonymous'].includes(r.name)||r.login||r.superuser||r.create_role||r.create_db||r.bypass_rls||r.owned_objects||r.other_database_dependencies||r.inherits.length))throw new Error('role handoff precondition failed');
      await c.query('ALTER ROLE authenticated RENAME TO ct_gas_bootstrap_authenticated; ALTER ROLE anonymous RENAME TO ct_gas_bootstrap_anonymous');
      await c.query('REVOKE ALL ON FUNCTION public.gas_email_rpc(text,text,jsonb) FROM ct_gas_bootstrap_authenticated');
      await c.query('COMMIT');return {status:'bootstrap-roles-preserved-under-explicit-names'};
    }
    const managed=roles.filter(r=>['authenticated','anonymous'].includes(r.name));
    if(managed.length!==2||managed.some(r=>r.superuser||r.create_role||r.create_db||r.bypass_rls||r.owned_objects||r.other_database_dependencies||r.inherits.length))throw new Error('unexpected managed role authority');
    for(const r of managed)if(r.login)await c.query(r.name==='authenticated'?'ALTER ROLE authenticated NOLOGIN':'ALTER ROLE anonymous NOLOGIN');
    await c.query(`REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC,authenticated,anonymous;
      REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC,authenticated,anonymous;
      REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC,authenticated,anonymous;
      REVOKE CREATE ON SCHEMA public FROM PUBLIC,authenticated,anonymous;
      GRANT USAGE ON SCHEMA public TO authenticated;
      GRANT EXECUTE ON FUNCTION public.gas_email_rpc(text,text,jsonb) TO authenticated`);
    const values=[INSTANCE.instance,INSTANCE.sub,INSTANCE.aud,INSTANCE.project,INSTANCE.mailbox,INSTANCE.sender,INSTANCE.grant];
    const found=(await c.query('SELECT * FROM gas_email_instances')).rows;
    if(found.length){
      const r=found[0];if(found.length!==1||r.active||JSON.stringify([r.instance_id,r.jwt_sub,r.jwt_aud,r.project_id,r.mailbox,r.allowed_sender,r.grant_ref])!==JSON.stringify(values))throw new Error('instance registration conflict');
    }else await c.query('INSERT INTO gas_email_instances(instance_id,jwt_sub,jwt_aud,project_id,mailbox,allowed_sender,grant_ref,active) VALUES($1,$2,$3,$4,$5,$6,$7,false)',values);
    const proof=await readback(c);await c.query('COMMIT');return {status:'restricted-and-registered-inactive',instance:INSTANCE,...proof};
  }catch(e){await c.query('ROLLBACK').catch(()=>{});throw e;}finally{c.release();}
}
async function main(){if(process.argv[2]==='probe'){console.log(JSON.stringify(await probe()));return;}const pool=new Pool({connectionString:validateTarget(process.env.CT_BOOTSTRAP_DATABASE_URL),max:1,connectionTimeoutMillis:15000});try{
  const id=(await pool.query('SELECT current_database() AS db,current_user AS owner')).rows[0];if(id.db!==TARGET.database||id.owner!==TARGET.owner)throw new Error('wrong database');
  console.log(JSON.stringify({target:TARGET,...await configure(pool,process.argv[2])}));
}finally{await pool.end();}}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(e=>{console.error(JSON.stringify({status:'failed-or-uncertain',sqlstate:/^[A-Z0-9]{5}$/.test(e.code||'')?e.code:null,httpStatus:Number.isInteger(e.httpStatus)?e.httpStatus:null,probe:e.probe||null,markers:e.markers||[],next:'inspect target before retry; details withheld'}));process.exitCode=1;});
