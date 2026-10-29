import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const root = new URL('..', import.meta.url);
const text = async (path) => readFile(new URL(path, root), 'utf8');

test('vNext arm is a manual-only, canonical control-plane cutover surface', async () => {
  const source = await text('gas/gas_deploy.js');
  const workflow = await text('.github/workflows/gas-arm-vnext.yml');
  assert.match(workflow, /workflow_dispatch:/);
  assert.doesNotMatch(workflow, /push:|schedule:/);
  assert.match(source, /operation!=='assert-legacy-quiesced'&&request\.operation!=='arm-vnext-cutover'/);
  assert.match(source, /function armVnext\(request\)/);
  assert.match(source, /setProperty\('CT_AUTONOMY_MODE','vnext'\)/);
  assert.match(source, /getProperty\('CT_AUTONOMY_MODE'\)/);
  assert.match(source, /request\.operation==='arm-vnext-cutover'\?CT_GAS_DEPLOY\.armVnext\(request\)/);
  assert.doesNotMatch(source, /gas_vnext_arm|CT_GAS_VNEXT_ARM/);
  assert.doesNotMatch(source, /setProperty\([^)]*request\./);
});

test('authoritative GAS bundle contains only the canonical arm implementation', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'ct-runtime-arm-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const output = join(directory, 'bundle.json');
  const { stdout } = await execFileAsync(process.execPath, ['scripts/build-gas-bundle.mjs', 'gas', output], { encoding: 'utf8' });
  const result = JSON.parse(stdout.trim().split('\n').at(-1));
  assert.equal(result.fileCount, 26);
  const bundle = JSON.parse(await readFile(output, 'utf8'));
  assert.ok(bundle.files.some((file) => file.name === 'gas_deploy'));
  assert.ok(!bundle.files.some((file) => file.name === 'gas_vnext_arm'));
  // Qualify the built owner artifact, not just the source manifest: label removal
  // and replies require gmail.modify alongside both email implementation modules.
  for (const name of ['gas_vnext_email', 'gas_vnext_email_owner', 'gas_repository_read']) {
    assert.ok(bundle.files.some(file => file.name === name && file.type === 'SERVER_JS'));
  }
  const manifest = JSON.parse(bundle.files.find(file => file.name === 'appsscript' && file.type === 'JSON').source);
  assert.deepEqual(manifest.oauthScopes.filter(scope => /gmail|mail\.google\.com/.test(scope)),
    ['https://www.googleapis.com/auth/gmail.modify']);
});
