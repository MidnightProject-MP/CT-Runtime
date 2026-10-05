import test from 'node:test';
import assert from 'node:assert/strict';
import { testPool } from './pilot-test-pool.mjs';
import { bootstrap,loadManifest,validateTarget,TARGET } from '../scripts/bootstrap-gas-email.mjs';

test('bootstrap URL requires exact new host, database, owner and encrypted direct connection',()=>{
  const url=`postgresql://${TARGET.owner}:test-only@${TARGET.host}/${TARGET.database}?sslmode=require`;
  assert.equal(validateTarget(url),url);
  for(const bad of [url.replace(TARGET.host,'archived.invalid'),url.replace('/neondb','/other'),url.replace('neondb_owner','other'),url.replace('require','disable'),url+'&options=-csearch_path=other'])assert.throws(()=>validateTarget(bad));
});
test('fresh bootstrap is atomic, denies missing principal, checksummed and repeat-safe',{timeout:60000},async()=>{
  const pool=await testPool();
  try{
    await pool.query('CREATE TABLE must_preserve(id integer)');
    await assert.rejects(bootstrap(pool,{apply:true}),/not empty/);
    assert.equal((await pool.query("SELECT to_regclass('must_preserve') IS NOT NULL AS present")).rows[0].present,true);
    await pool.query('DROP TABLE must_preserve');
    const m=await loadManifest();assert.equal((await bootstrap(pool)).status,'empty-ready');
    const broken={...m,files:[...m.files,{path:'injected-test',sql:"SELECT no_such_bootstrap_function()"}]};
    await assert.rejects(bootstrap(pool,{apply:true,manifest:broken}));
    assert.equal((await bootstrap(pool)).status,'empty-ready');
    assert.equal((await bootstrap(pool,{validate:true})).status,'validated-rolled-back');
    assert.equal((await bootstrap(pool)).status,'empty-ready');
    const done=await bootstrap(pool,{apply:true});assert.equal(done.status,'applied');assert.equal(done.tables,17);assert.equal(done.files,7);
    assert.equal(done.registeredInstances,0);assert.equal(done.activeInstances,0);assert.equal(done.directTableGrants,0);assert.equal(done.unauthenticatedDenied,true);
    assert.equal((await bootstrap(pool,{apply:true})).status,'already-applied');
    assert.equal((await bootstrap(pool)).status,'already-applied');
    await assert.rejects(bootstrap(pool,{apply:true,manifest:{...m,hash:'changed'}}),/checksum/);
    await assert.rejects(bootstrap(pool,{apply:true,manifest:{...m,checksums:[]}}),/checksum/);
    const count=await pool.query('SELECT count(*)::int AS n FROM gas_email_bootstrap_ledger');assert.equal(count.rows[0].n,1);
  }finally{await pool.end();}
});
