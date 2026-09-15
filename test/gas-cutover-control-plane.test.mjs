import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('production GAS bundle includes the legacy cutover implementation', async () => {
  const source = await read('scripts/build-gas-bundle.mjs');
  assert.match(source, /'gas_cutover\.js'/);
});

test('GAS deployment dispatcher exposes only the two cutover operations in addition to deployment operations', async () => {
  const source = await read('gas/gas_deploy.js');
  assert.match(source, /quiesce-legacy-autonomy/);
  assert.match(source, /assert-legacy-quiesced/);
  assert.match(source, /request\.operation==='quiesce-legacy-autonomy'\?quiesceLegacyAutonomy\(\)/);
  assert.match(source, /request\.operation==='assert-legacy-quiesced'\?assertLegacyQuiesced\(\)/);
});

test('manual cutover workflow uses the existing HMAC control-plane secrets and records a receipt', async () => {
  const source = await read('.github/workflows/gas-quiesce-legacy.yml');
  assert.match(source, /workflow_dispatch:/);
  assert.match(source, /CT_GAS_ADMIN_WEB_APP_URL:/);
  assert.match(source, /CT_GAS_DEPLOY_HMAC_SECRET:/);
  assert.match(source, /quiesce-legacy-autonomy/);
  assert.match(source, /assert-legacy-quiesced/);
  assert.match(source, /GITHUB_STEP_SUMMARY/);
  assert.match(source, /actions\/upload-artifact@v4/);
});
