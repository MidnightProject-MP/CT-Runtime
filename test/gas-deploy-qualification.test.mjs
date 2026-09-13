import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('GAS bundle includes the native qualification adapter', async () => {
  const build = await readFile(new URL('../scripts/build-gas-bundle.mjs', import.meta.url), 'utf8');
  const adapter = await readFile(new URL('../gas/gas_deploy_qualify.js', import.meta.url), 'utf8');
  assert.match(build, /'gas_deploy_qualify\.js'/);
  assert.match(adapter, /desiredBundleHash:\s*bundleHash\(request\.files\)/);
});
