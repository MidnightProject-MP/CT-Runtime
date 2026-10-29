import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { authorizeRelease } from '../scripts/authorize-gas-release.mjs';

const commit = 'a'.repeat(40), desired = 'b'.repeat(64), predecessor = 'c'.repeat(64);
const ref = 'refs/tags/gas-release/reviewed';
const env = { GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: ref, GITHUB_SHA: commit,
  RELEASE_COMMIT: commit, RELEASE_REF: ref, DESIRED_BUNDLE_HASH: desired,
  EXPECTED_LIVE_BUNDLE_HASH: predecessor, GAS_BUNDLE_HASH: desired,
  APPROVED_RELEASE: `${ref}:${commit}:${desired}:${predecessor}` };
test('only the exact approved manual release tuple passes', () => {
  assert.equal(authorizeRelease(env, () => commit), true);
  for (const key of Object.keys(env)) {
    assert.throws(() => authorizeRelease({ ...env, [key]: '' }, () => commit), undefined, key);
  }
  assert.throws(() => authorizeRelease(env, () => 'd'.repeat(40)));
  assert.throws(() => authorizeRelease({ ...env, GITHUB_REF: 'refs/heads/main' }, () => commit), /Release ref mismatch/);
  assert.throws(() => authorizeRelease({ ...env, GITHUB_EVENT_NAME: 'push' }, () => commit));
});
test('partial merges cannot auto-deploy and legacy writes fail closed', () => {
  const workflow = readFileSync('.github/workflows/gas-self-deploy.yml', 'utf8');
  assert.doesNotMatch(workflow, /^  push:/m);
  assert.ok(workflow.indexOf('node scripts/authorize-gas-release.mjs') < workflow.indexOf('node scripts/deploy-gas.mjs'));
  assert.match(workflow, /group: gas-production-deploy/);
  for (const name of ['gas-clasp-push', 'gas-clasp-deploy']) {
    assert.match(readFileSync(`.github/workflows/${name}.yml`, 'utf8'), /if: \$\{\{ false \}\}/);
  }
});

test('sandbox release uses a separate tag namespace, environment and target identity', () => {
  const sandboxRef = 'refs/tags/gas-sandbox-release/reviewed';
  const sandboxEnv = { ...env, RELEASE_REF_PREFIX: 'refs/tags/gas-sandbox-release/',
    GITHUB_REF: sandboxRef, RELEASE_REF: sandboxRef,
    APPROVED_RELEASE: `${sandboxRef}:${commit}:${desired}:${predecessor}` };
  assert.equal(authorizeRelease(sandboxEnv, () => commit), true);
  assert.throws(() => authorizeRelease({ ...sandboxEnv, RELEASE_REF_PREFIX: 'refs/heads/' }, () => commit), /prefix not allowed/);
  assert.throws(() => authorizeRelease({ ...sandboxEnv, GITHUB_REF: ref, RELEASE_REF: ref }, () => commit), /Release ref mismatch/);

  const workflow = readFileSync('.github/workflows/gas-sandbox-self-deploy.yml', 'utf8');
  assert.doesNotMatch(workflow, /^  push:/m);
  assert.match(workflow, /environment: gas-sandbox/);
  assert.match(workflow, /group: gas-sandbox-deploy/);
  assert.match(workflow, /GAS_SANDBOX_SCRIPT_ID/);
  assert.match(workflow, /GAS_SANDBOX_DEPLOYMENT_ID/);
  assert.match(workflow, /CT_GAS_INSPECT_ONLY: '1'/);
  assert.match(workflow, /node scripts\/qualify-gas-target\.mjs/);
  assert.ok(workflow.indexOf('Inspect sandbox LIVE and HEAD without mutation') < workflow.indexOf('Authorize exact reviewed sandbox release'));
  assert.ok(workflow.indexOf('node scripts/qualify-gas-target.mjs') < workflow.indexOf('node scripts/authorize-gas-release.mjs'));
  assert.ok(workflow.indexOf('node scripts/authorize-gas-release.mjs') < workflow.lastIndexOf('node scripts/deploy-gas.mjs'));
  assert.doesNotMatch(workflow, /1Uzv-r4UW-y9XLuO-f3QEvrwzInGu1JarmqecVtwarJor6Z5qpmUD2dri/);
  assert.doesNotMatch(workflow, /GAS_APPROVED_RELEASE/);
});
