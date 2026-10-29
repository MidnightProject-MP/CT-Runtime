import test from 'node:test';
import assert from 'node:assert/strict';
import { qualifySandboxTarget } from '../scripts/qualify-gas-target.mjs';
import { PRODUCTION_SCRIPT_ID, PRODUCTION_DEPLOYMENT_ID } from '../lib/gas-targets.mjs';

const deployment = 'sandbox_deployment-1234567890';
const base = {
  CT_GAS_TARGET: 'sandbox',
  GITHUB_EVENT_NAME: 'workflow_dispatch',
  GITHUB_REF: 'refs/tags/gas-sandbox-release/reviewed',
  GITHUB_SHA: 'a'.repeat(40),
  CT_GAS_SCRIPT_ID: 'sandbox-script-1234567890',
  CT_GAS_DEPLOYMENT_ID: deployment,
  CT_GAS_ADMIN_WEB_APP_URL: `https://script.google.com/macros/s/${deployment}/exec`,
  CT_GAS_DEPLOY_HMAC_SECRET: 'sandbox-secret'
};

test('sandbox qualification binds the exact isolated identity without exposing secrets', () => {
  const result = qualifySandboxTarget(base);
  assert.deepEqual(result, {
    target: 'sandbox',
    scriptId: base.CT_GAS_SCRIPT_ID,
    deploymentId: deployment,
    releaseCommit: base.GITHUB_SHA,
    releaseRef: base.GITHUB_REF
  });
  assert.doesNotMatch(JSON.stringify(result), /sandbox-secret/);
});

test('sandbox qualification rejects production or mismatched targets before deployment', () => {
  assert.throws(() => qualifySandboxTarget({ ...base, CT_GAS_TARGET: 'production' }), /sandbox target required/);
  assert.throws(() => qualifySandboxTarget({ ...base, GITHUB_EVENT_NAME: 'push' }), /manual sandbox/);
  assert.throws(() => qualifySandboxTarget({ ...base, GITHUB_REF: 'refs/tags/gas-release/reviewed' }), /sandbox release ref/);
  assert.throws(() => qualifySandboxTarget({ ...base, GITHUB_SHA: 'a'.repeat(39) }), /full sandbox release commit/);
  assert.throws(() => qualifySandboxTarget({ ...base, CT_GAS_SCRIPT_ID: PRODUCTION_SCRIPT_ID }), /production target/);
  assert.throws(() => qualifySandboxTarget({ ...base, CT_GAS_DEPLOYMENT_ID: PRODUCTION_DEPLOYMENT_ID,
    CT_GAS_ADMIN_WEB_APP_URL: `https://script.google.com/macros/s/${PRODUCTION_DEPLOYMENT_ID}/exec` }), /production target/);
  assert.throws(() => qualifySandboxTarget({ ...base, CT_GAS_DEPLOYMENT_ID: 'other_deployment-1234567890' }), /does not match endpoint/);
  assert.throws(() => qualifySandboxTarget({ ...base, CT_GAS_DEPLOY_HMAC_SECRET: '' }), /deploy secret unavailable/);
  assert.throws(() => qualifySandboxTarget({ ...base, CT_GAS_SCRIPT_ID: '' }), /sandbox script id/);
  assert.throws(() => qualifySandboxTarget({ ...base, CT_GAS_DEPLOYMENT_ID: '' }), /sandbox deployment id/);
  assert.throws(() => qualifySandboxTarget({ ...base, CT_GAS_ADMIN_WEB_APP_URL: '' }), /sandbox admin endpoint/);
});
