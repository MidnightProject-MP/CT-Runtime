import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gasDiagnosticProperties } from '../scripts/gas-diagnostic-properties.cjs';
import { inspectGas, inspectSource, SCRIPT_ID, DEPLOYMENT_ID } from '../scripts/inspect-gas-readonly.mjs';

test('property helper reads exactly three keys; strips credentials, query and fragment', () => {
  const read = [];
  const output = gasDiagnosticProperties({ getProperty(key) {
    read.push(key);
    return { CT_GAS_FEDERATION_DATA_API_URL: 'https://user:SECRET@ep-example.neon.tech/sql?token=SECRET#SECRET',
      CT_GAS_DEPLOYMENT_ID: DEPLOYMENT_ID, CT_AUTONOMY_MODE: 'vnext' }[key];
  }, getProperties() { throw Error('broad read'); }, setProperty() { throw Error('write'); } });
  assert.equal(read.length, 3);
  assert.deepEqual(new Set(read), new Set(['CT_GAS_FEDERATION_DATA_API_URL', 'CT_GAS_DEPLOYMENT_ID', 'CT_AUTONOMY_MODE']));
  assert.deepEqual(output.CT_GAS_FEDERATION_DATA_API_URL, { hostname: 'ep-example.neon.tech', path: '/sql' });
  assert.equal(output.CT_GAS_DEPLOYMENT_ID, DEPLOYMENT_ID);
  assert.equal(output.CT_AUTONOMY_MODE, 'vnext');
  assert.ok(!JSON.stringify(output).includes('SECRET'));
});

test('malformed values fail closed and do not reflect arbitrary modes or identifiers', () => {
  for (const url of ['postgres://user:SECRET@host/db', 'https://host\\@evil/path', 'https://host/%53ECRET', 'https://host/\nSECRET', 'not a URL', null]) {
    const out = gasDiagnosticProperties({ getProperty: key => key.endsWith('_URL') ? url : 'SECRET?token=bad' });
    assert.deepEqual(out, { CT_GAS_FEDERATION_DATA_API_URL: null, CT_GAS_DEPLOYMENT_ID: null, CT_AUTONOMY_MODE: null });
  }
});

test('source inspection emits only fixed keys, booleans, counts and manifest enums', () => {
  const out = inspectSource({ files: [
    { name: 'SECRET', type: 'SERVER_JS', source: 'function doPost(e) {} // CT_AUTONOMY_MODE SECRET' },
    { name: 'appsscript', type: 'JSON', source: JSON.stringify({ webapp: { access: 'MYSELF', executeAs: 'USER_DEPLOYING', secret: 'SECRET' }, secret: 'SECRET' }) }
  ] });
  assert.equal(out.hasDoPost, true);
  assert.equal(out.hasDoGet, false);
  assert.equal(out.propertyReferences.CT_AUTONOMY_MODE, true);
  assert.deepEqual(out.webapp, { access: 'MYSELF', executeAs: 'USER_DEPLOYING' });
  assert.ok(!JSON.stringify(out).includes('SECRET'));
  assert.equal(inspectSource({ files: [{ name: 'appsscript', type: 'JSON', source: 'SECRET' }] }).webapp, null);
});

const credentials = { tokens: { default: { refresh_token: 'SECRET', client_id: 'client', client_secret: 'SECRET' } } };
test('workflow isolates manual diagnostic from existing clasp job and does not deploy', () => {
  const workflow = readFileSync(new URL('../.github/workflows/gas-clasp-auth-health.yml', import.meta.url), 'utf8');
  assert.match(workflow, /default: inspect-readonly/);
  assert.match(workflow, /if: github.event_name == 'workflow_dispatch' && inputs.mode == 'inspect-readonly'/);
  assert.match(workflow, /if: github.event_name != 'workflow_dispatch' \|\| inputs.mode == 'auth-health'/);
  const diagnostic = workflow.split('  inspect-readonly:')[1].split('  auth-health:')[0];
  assert.doesNotMatch(diagnostic, /clasp|upload-artifact|deploy-gas|gas-self-deploy|curl|scripts\.run/);
  assert.match(diagnostic, /node scripts\/inspect-gas-readonly\.mjs/);
});
test('network contract: OAuth refresh then exactly three pinned GETs, no GAS execution or writes', async () => {
  const calls = [];
  const out = await inspectGas({ credentials, fetchImpl: async (url, options) => {
    calls.push([url, options.method]);
    assert.equal(options.redirect, 'error');
    const data = calls.length === 1 ? { access_token: 'SECRET' } : calls.length === 2 ? {
      deploymentId: DEPLOYMENT_ID, deploymentConfig: { scriptId: SCRIPT_ID, versionNumber: 100, description: 'SECRET' }
    } : { files: [{ name: 'SECRET', type: 'SERVER_JS', source: 'SECRET' }] };
    return { ok: true, json: async () => data };
  } });
  assert.deepEqual(calls, [
    ['https://oauth2.googleapis.com/token', 'POST'],
    [`https://script.googleapis.com/v1/projects/${SCRIPT_ID}/deployments/${DEPLOYMENT_ID}`, 'GET'],
    [`https://script.googleapis.com/v1/projects/${SCRIPT_ID}/content`, 'GET'],
    [`https://script.googleapis.com/v1/projects/${SCRIPT_ID}/content?versionNumber=100`, 'GET']
  ]);
  assert.equal(out.liveVersion, 100);
  assert.ok(!JSON.stringify(out).includes('SECRET'));
});

test('API failure body is never read or exposed', async () => {
  await assert.rejects(inspectGas({ credentials, fetchImpl: async () => ({ ok: false,
    json() { throw Error('SECRET'); } }) }), { message: 'request-failed' });
});

test('target mismatch stops before source reads', async () => {
  let calls = 0;
  await assert.rejects(inspectGas({ credentials, fetchImpl: async () => ({ ok: true, json: async () => ++calls === 1
    ? { access_token: 'SECRET' } : { deploymentId: 'other', deploymentConfig: { versionNumber: 100 } } }) }), { message: 'target-mismatch' });
  assert.equal(calls, 2);
});
