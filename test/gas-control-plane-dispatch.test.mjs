import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const dispatch = await readFile('gas/gas_zz_dispatch.js', 'utf8');
const federation = await readFile('gas/gas_federation.js', 'utf8');
const trace = await readFile('gas/gas_zz_auth_trace.js', 'utf8');
const quiesce = await readFile('scripts/quiesce-gas.mjs', 'utf8');
const bundleBuilder = await readFile('scripts/build-gas-bundle.mjs', 'utf8');

test('canonical dispatcher routes deployment operations before federation authentication', () => {
  assert.match(dispatch, /var federationDoPost = doPost/);
  assert.match(dispatch, /CT_GAS_DEPLOY\.authenticate\(raw, query\)/);
  assert.match(dispatch, /quiesceLegacyAutonomy\(\)/);
  assert.match(dispatch, /assertLegacyQuiesced\(\)/);
  assert.match(dispatch, /return federationDoPost\(e\)/);
  assert.match(federation, /function doPost\(e\)/);
});

test('bundle ordering places canonical dispatcher after federation and before diagnostic wrapper', () => {
  const federationIndex = bundleBuilder.indexOf("  'gas_federation.js',");
  const dispatchIndex = bundleBuilder.indexOf("  'gas_zz_dispatch.js'");
  const traceIndex = bundleBuilder.indexOf("  'gas_zz_auth_trace.js',");
  assert.ok(federationIndex >= 0);
  assert.ok(dispatchIndex > federationIndex);
  assert.ok(traceIndex > federationIndex);
  assert.ok(dispatchIndex < traceIndex);
  assert.match(trace, /var originalDoPost = doPost/);
});

test('quiescence signs and transmits the same populated request body', () => {
  assert.match(quiesce, /const body = JSON\.stringify\(request\);/);
  assert.doesNotMatch(quiesce, /const body = JSON\.stringify\(\{\}\);/);
  for (const field of ['operation', 'correlation_id', 'deployment_request_id', 'script_id', 'deployment_id', 'commit_sha', 'github_bundle_hash']) {
    assert.match(quiesce, new RegExp(`\\b${field}\\b`));
  }
  assert.match(quiesce, /signature\(request, timestamp, nonce, body, secret\)/);
});
