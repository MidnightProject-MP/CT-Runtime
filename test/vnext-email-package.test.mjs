import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile,mkdtemp,rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
test('packaged email entry point, deployable bridge and disabled workflow are connected',async()=>{
  const root=fileURLToPath(new URL('../',import.meta.url)),dir=await mkdtemp(path.join(tmpdir(),'email-bundle-'));
  try {
    const output=path.join(dir,'bundle.json');
    execFileSync(process.execPath,['scripts/build-gas-bundle.mjs','gas',output],{cwd:root});
    const bundle=JSON.parse(await readFile(output,'utf8'));
    assert.ok(bundle.files.some(f=>f.name==='gas_zzz_email'));
    const workflow=await readFile(new URL('../.github/workflows/vnext-email-pilot.yml',import.meta.url),'utf8');
    assert.match(workflow,/vars.CT_EMAIL_PILOT_ENABLED == 'true'/);
    for(const name of ['CT_PILOT_DATABASE_URL','CT_EMAIL_PROJECT_ID','CT_EMAIL_ALLOWED_SENDER','CT_GAS_FEDERATION_HMAC_SECRET'])assert.ok(workflow.includes(name));
    const cli=await readFile(new URL('../bin/vnext-email.mjs',import.meta.url),'utf8');assert.match(cli,/email.poll\(transport\)/);
    const result=execFileSync(process.execPath,['bin/vnext-email.mjs','poll'],{cwd:root,env:{...process.env,CT_EMAIL_PILOT_ENABLED:'false'},stdio:'pipe'});
    assert.fail('disabled entry point must fail');
  } catch(e) {if(e.status!==1 || !String(e.stderr).includes('Email pilot stopped'))throw e;}
  finally {await rm(dir,{recursive:true,force:true});}
});
