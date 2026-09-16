import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const dispatch = await readFile('gas/gas_zz_a_dispatch.js', 'utf8');
const federation = await readFile('gas/gas_federation.js', 'utf8');
const trace = await readFile('gas/gas_zz_auth_trace.js', 'utf8');
const quiesce = await readFile('scripts/quiesce-gas.mjs', 'utf8');

async function buildBundle() {
  const output = `/tmp/ct-runtime-gas-control-plane-${process.pid}.json`;
  try {
    await execFileAsync(process.execPath, ['scripts/build-gas-bundle.mjs', 'gas', output], { encoding: 'utf8' });
    return JSON.parse(await readFile(output, 'utf8'));
  } finally {
    await rm(output, { force: true });
  }
}

test('canonical dispatcher routes deployment operations before federation authentication', () => {
  assert.match(dispatch, /var federationDoPost = doPost/);
  assert.match(dispatch, /CT_GAS_DEPLOY\.authenticate\(raw, query\)/);
  assert.match(dispatch, /quiesceLegacyAutonomy\(\)/);
  assert.match(dispatch, /assertLegacyQuiesced\(\)/);
  assert.match(dispatch, /return federationDoPost\(e\)/);
  assert.match(federation, /function doPost\(e\)/);
});

test('privileged dispatch binds requests to the receiving script and configured deployment', () => {
  assert.match(dispatch, /function assertDeploymentIdentity\(request\)/);
  assert.match(dispatch, /ScriptApp\.getScriptId\(\)/);
  assert.match(dispatch, /CT_GAS_DEPLOYMENT_ID/);
  assert.match(dispatch, /deploy-script-id-mismatch/);
  assert.match(dispatch, /deploy-deployment-id-mismatch/);
  assert.match(dispatch, /CT_GAS_DEPLOY\.authenticate\(raw, query\), result/);
  assert.match(dispatch, /assertDeploymentIdentity\(request\)/);
});

test('built bundle contains the canonical control-plane and complete vNext Feedback paths', async () => {
  const bundle = await buildBundle();
  const names = bundle.files.map((file) => file.name);
  const federationIndex = names.indexOf('gas_federation');
  const dispatchIndex = names.indexOf('gas_zz_a_dispatch');
  const traceIndex = names.indexOf('gas_zz_auth_trace');
  assert.ok(federationIndex >= 0);
  assert.ok(dispatchIndex > federationIndex);
  assert.ok(traceIndex > federationIndex);
  assert.ok(dispatchIndex < traceIndex);
  for (const name of ['gas_deploy_qualify', 'gas_feedback_vnext', 'gas_feedback_vnext_projection', 'gas_feedback_vnext_transport', 'gas_vnext_events']) {
    assert.ok(names.includes(name), `missing assembled production file: ${name}`);
  }
  assert.match(trace, /var originalDoPost = doPost/);
});

test('quiescence signs and transmits the same populated request body', () => {
  assert.match(quiesce, /const body = JSON\.stringify\(request\);/);
  assert.doesNotMatch(quiesce, /const body = JSON\.stringify\(\{\}\);/);
  for (const field of ['operation', 'correlation_id', 'deployment_request_id', 'script_id', 'deployment_id', 'commit_sha', 'github_bundle_hash']) {
    assert.match(quiesce, new RegExp(`\\b${field}\\b`));
  }
  assert.match(quiesce, /signature\(request, timestamp, nonce, body, secret\)/);
  assert.match(quiesce, /result\.status !== 'LEGACY_QUIESCED'/);
  assert.match(quiesce, /business failure/);
});
