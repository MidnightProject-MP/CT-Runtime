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
  assert.throws(() => authorizeRelease(env, () => 'd'.repeat(40)));\n  assert.throws(() => authorizeRelease({ ...env, GITHUB_REF: 'refs/heads/main' }, () => commit), /Release ref mismatch/);
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
