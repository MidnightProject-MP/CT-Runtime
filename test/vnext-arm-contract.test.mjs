import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
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

test('authoritative GAS bundle contains only the canonical arm implementation', async () => {
  const { stdout } = await execFileAsync(process.execPath, ['scripts/build-gas-bundle.mjs', 'gas', '/tmp/ct-runtime-arm-test-bundle.json'], { encoding: 'utf8' });
  const result = JSON.parse(stdout.trim().split('\n').at(-1));
  assert.equal(result.fileCount, 23);
  const bundle = JSON.parse(await readFile('/tmp/ct-runtime-arm-test-bundle.json', 'utf8'));
  assert.ok(bundle.files.some((file) => file.name === 'gas_deploy'));
  assert.ok(!bundle.files.some((file) => file.name === 'gas_vnext_arm'));
});
