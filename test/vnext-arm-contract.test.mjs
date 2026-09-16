import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const root = new URL('..', import.meta.url);
const text = async (path) => readFile(new URL(path, root), 'utf8');

test('vNext arm is a manual-only, narrowly scoped cutover surface', async () => {
  const source = await text('gas/gas_vnext_arm.js');
  const workflow = await text('.github/workflows/gas-arm-vnext.yml');
  const dispatcher = await text('gas/gas_zz_a_dispatch.js');
  assert.match(workflow, /workflow_dispatch:/);
  assert.doesNotMatch(workflow, /push:|schedule:/);
  assert.match(source, /operation = 'arm-vnext-cutover'/);
  assert.match(source, /setProperty\('CT_AUTONOMY_MODE', 'vnext'\)/);
  assert.match(source, /getProperty\('CT_AUTONOMY_MODE'\)/);
  assert.doesNotMatch(source, /setProperty\([^,]+,\s*[^'v][^)]*\)/);
  assert.match(dispatcher, /arm-vnext-cutover/);
  assert.match(dispatcher, /CT_GAS_VNEXT_ARM\.authenticate/);
  assert.match(dispatcher, /CT_GAS_VNEXT_ARM\.arm/);
});

test('authoritative GAS bundle contains the temporary arm capability', async () => {
  const { stdout } = await execFileAsync(process.execPath, ['scripts/build-gas-bundle.mjs', 'gas', '/tmp/ct-runtime-arm-test-bundle.json'], { encoding: 'utf8' });
  const result = JSON.parse(stdout.trim().split('\n').at(-1));
  assert.equal(result.fileCount, 21);
  const bundle = JSON.parse(await readFile('/tmp/ct-runtime-arm-test-bundle.json', 'utf8'));
  assert.ok(bundle.files.some((file) => file.name === 'gas_vnext_arm'));
});
