import test from 'node:test';
import assert from 'node:assert/strict';
import { testPool } from './pilot-test-pool.mjs';
import { bootstrap } from '../scripts/bootstrap-gas-email.mjs';
import { configure,INSTANCE,probe,DATA_API_URL } from '../scripts/configure-gas-email-data-api.mjs';
test('HTTP negative probes are pinned, read-only health calls and never report response/token content',async()=>{
  const requests=[];const result=await probe(async(url,opts)=>{requests.push({url,opts});return {status:401,body:{cancel:async()=>{}}};},'test-google-kid');
  assert.equal(requests.length,2);assert.ok(requests.every(r=>r.url===DATA_API_URL+'/rpc/gas_email_rpc'&&JSON.parse(r.opts.body).p_operation==='health'));
  assert.equal(result.matchingGoogleToken,'not-available-not-tested');assert.doesNotMatch(JSON.stringify(result),/invalid-signature\./);
  await assert.rejects(probe(async()=>({status:200}),'test-google-kid'),/unexpected/);
  const rejected=await probe(async(url,opts)=>({status:400,text:async()=>opts.headers.Authorization?'SignatureError':'Missing required Authorization JWT token'}),'test-google-kid');
  assert.equal(rejected.probes[1].denial,'gateway-invalid-signature');
});
test('explicit role handoff preserves bootstrap identities and restores sole RPC grant with inactive exact registration',{timeout:60000},async()=>{
  const pool=await testPool();try{
    await bootstrap(pool,{apply:true});
    assert.equal((await configure(pool,'inspect')).roles.length,2);
    assert.equal((await configure(pool,'prepare-roles')).status,'bootstrap-roles-preserved-under-explicit-names');
    assert.equal((await configure(pool,'inspect')).roles.length,2);
    await assert.rejects(configure(pool,'restrict-register'));
    // Model the provider creating its managed identities, without broad grants.
    await pool.query('CREATE ROLE authenticated NOLOGIN; CREATE ROLE anonymous NOLOGIN');
    const result=await configure(pool,'restrict-register');assert.equal(result.activeInstances,0);assert.equal(result.registeredInstances,1);
    assert.equal(result.directTableGrants,0);assert.equal(result.unauthenticatedDenied,true);
    assert.equal((await bootstrap(pool)).status,'already-applied');
    assert.equal((await configure(pool,'restrict-register')).registeredInstances,1);
    const row=(await pool.query('SELECT * FROM gas_email_instances')).rows[0];assert.equal(row.jwt_sub,INSTANCE.sub);assert.equal(row.jwt_aud,INSTANCE.aud);assert.equal(row.active,false);
    const c=await pool.connect();try{
      for(const aud of [INSTANCE.aud,'wrong-audience']){
        await c.query('BEGIN');await c.query('UPDATE gas_email_instances SET active=true');
        await c.query("SELECT set_config('request.jwt.claims',$1,true)",[JSON.stringify({sub:INSTANCE.sub,aud,iss:'https://accounts.google.com',exp:4102444800})]);
        if(aud===INSTANCE.aud){const h=await c.query("SELECT gas_email_rpc('gas-vnext-email','health','{}') AS health");assert.equal(h.rows[0].health.project,'celestan-email');}
        else await assert.rejects(c.query("SELECT gas_email_rpc('gas-vnext-email','health','{}')"),/principal denied/);
        await c.query('ROLLBACK');
      }
    }finally{c.release();}
    assert.equal((await pool.query('SELECT active FROM gas_email_instances')).rows[0].active,false);
    assert.equal((await pool.query("SELECT has_function_privilege('ct_gas_bootstrap_authenticated','public.gas_email_rpc(text,text,jsonb)','EXECUTE') AS allowed")).rows[0].allowed,false);
    await pool.query("UPDATE gas_email_instances SET jwt_sub='conflicting-subject'");
    await assert.rejects(configure(pool,'activate-for-qualification'),/identity conflict/);
    assert.equal((await pool.query('SELECT active FROM gas_email_instances')).rows[0].active,false);
    await pool.query('UPDATE gas_email_instances SET jwt_sub=$1',[INSTANCE.sub]);
    await pool.query('GRANT SELECT ON gas_email_instances TO authenticated');
    await assert.rejects(configure(pool,'activate-for-qualification'),/privilege readback/);
    assert.equal((await pool.query('SELECT active FROM gas_email_instances')).rows[0].active,false);
    await pool.query('REVOKE SELECT ON gas_email_instances FROM authenticated');
    const activated=await configure(pool,'activate-for-qualification');assert.equal(activated.status,'activated-for-qualification');assert.equal(activated.activeInstances,1);
    assert.equal((await configure(pool,'activate-for-qualification')).status,'already-active-for-qualification');
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM gas_email_instances')).rows[0].n,1);
    assert.equal((await configure(pool,'inspect')).counts.work_units,0);
    await assert.rejects(configure(pool,'restrict-register'));
  }finally{await pool.end();}
});
