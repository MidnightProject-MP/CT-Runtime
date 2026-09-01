import test from 'node:test';
import assert from 'node:assert/strict';
import { CAPABILITIES } from '../lib/capabilities/definitions.mjs';
import { ADAPTERS, describeAdapters, getAdapter } from '../lib/capabilities/adapters.mjs';
import { resolveBinding, resolveAllBindings } from '../lib/capabilities/bindings.mjs';
import { request, describeCapabilities } from '../lib/capabilities/registry.mjs';
import { Store } from '../lib/runtime.mjs';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

test('capabilities define purpose, not vendor', () => {
  for (const cap of Object.values(CAPABILITIES)) {
    assert.match(cap.purpose, /./);
    assert.ok(!cap.name.includes('neon') && !cap.name.includes('jira'), 'capability name must not be vendor');
    assert.ok(cap.operations.length > 0);
  }
  assert.equal(CAPABILITIES.durable_state.authority, 'canonical');
  assert.equal(CAPABILITIES.evidence_store.purpose.includes('raw'), true);
});

test('adapters expose purpose-level metadata, not just provider', () => {
  const all = describeAdapters();
  for (const a of all) {
    assert.ok(a.purpose, 'missing purpose');
    assert.ok(a.operations.length);
    assert.ok(a.authority);
    assert.ok(a.configRequirements);
    assert.ok(Array.isArray(a.limitations));
  }
  // durable_state adapters are provider-neutral standard interfaces
  assert.ok(getAdapter('durable_state', 'postgres').meta.provider.includes('postgres'));
  assert.ok(getAdapter('durable_state', 'filesystem').meta.provider.includes('filesystem'));
  assert.ok(getAdapter('evidence_store', 's3').meta.provider.includes('S3-compatible'));
  // provider specifics remain inside adapter
  assert.deepEqual(getAdapter('evidence_store', 's3').meta.configRequirements, ['CT_RUNTIME_S3_BUCKET']);
});

test('binding is replaceable without changing Celestan code', () => {
  // global default: filesystem mode → filesystem
  assert.equal(resolveBinding('durable_state', { env: { CT_RUNTIME_MODE: 'filesystem' } }), 'filesystem');
  assert.equal(resolveBinding('durable_state', { env: { CT_RUNTIME_MODE: 'production' } }), 'postgres');
  assert.equal(resolveBinding('evidence_store', { env: { CT_RUNTIME_MODE: 'production' } }), 's3');

  // per-project override via CELESTAN_BINDINGS_JSON
  const env = {
    CT_RUNTIME_MODE: 'filesystem',
    CELESTAN_BINDINGS_JSON: JSON.stringify({
      global: { project_system: 'github_issues' },
      projects: { BorderCrossing: { project_system: 'jira' } }
    })
  };
  assert.equal(resolveBinding('project_system', { env, project: 'BorderCrossing' }), 'jira');
  assert.equal(resolveBinding('project_system', { env, project: 'CT-Foundry' }), 'github_issues');
  // direct env override
  assert.equal(resolveBinding('durable_state', { env: { ...env, CELESTAN_DURABLE_STATE: 'postgres' } }), 'postgres');
});

test('Celestan requests capability, adapter handles vendor', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ct-cap-'));
  const env = { CT_RUNTIME_MODE: 'filesystem', CT_RUNTIME_STORE: root };
  const viaCapability = await request('durable_state', { env, root });
  assert.ok(viaCapability.createManifest);
  // same contract as direct Store
  const direct = new Store(root);
  const viaDirect = await direct.createManifest({ executionId: 'direct-1', project: 'p', task: 't', model: 'm', agent: 'a' });
  const viaCap = await viaCapability.createManifest({ executionId: 'cap-1', project: 'p', task: 't', model: 'm', agent: 'a' });
  assert.equal(viaCap.created, true);
  assert.equal(viaDirect.created, true);
});

test('publish via knowledge_publishing / persist via durable_state are vendor-agnostic', async () => {
  // Celestan code:
  //   await (await request('knowledge_publishing', {project})).publishChronicle({...})
  // works whether binding is git or confluence. Verify bindings exist.
  const kpGit = getAdapter('knowledge_publishing', 'git');
  const kpConf = getAdapter('knowledge_publishing', 'confluence');
  assert.equal(kpGit.meta.capability, 'knowledge_publishing');
  assert.equal(kpConf.meta.capability, 'knowledge_publishing');
  assert.deepEqual(kpGit.meta.operations, kpConf.meta.operations); // same contract

  const dsFs = getAdapter('durable_state', 'filesystem');
  const dsPg = getAdapter('durable_state', 'postgres');
  assert.deepEqual(dsFs.meta.operations, dsPg.meta.operations);
});

test('describeCapabilities is discoverable per project', () => {
  const env = {
    CELESTAN_BINDINGS_JSON: JSON.stringify({
      global: { durable_state: 'postgres', project_system: 'github_issues' },
      projects: { BorderCrossing: { project_system: 'jira' } }
    }),
    CT_RUNTIME_MODE: 'production',
    CT_RUNTIME_DATABASE_URL: 'postgres://x',
    CT_RUNTIME_S3_BUCKET: 'b',
    CT_RUNTIME_IMAGE_DIGEST: 'sha256:' + 'a'.repeat(64),
    CT_RUNTIME_CONFIG_DIGEST: 'sha256:' + 'b'.repeat(64),
    CT_RUNTIME_DEPLOYMENT_ID: 'd',
    CT_RUNTIME_PROVIDER: 'test',
    CT_RUNTIME_CLASS: 'test',
    CT_RUNTIME_REGION: 'test',
    CT_RUNTIME_GIT_REPOSITORY: 'r',
    CT_RUNTIME_GIT_COMMIT: 'a'.repeat(40)
  };
  const globalCaps = describeCapabilities({ env, project: 'CT-Foundry' });
  const bcCaps = describeCapabilities({ env, project: 'BorderCrossing' });
  assert.equal(globalCaps.find(c => c.capability === 'project_system').binding, 'github_issues');
  assert.equal(bcCaps.find(c => c.capability === 'project_system').binding, 'jira');
  // all caps expose purpose/authority/health needs
  for (const c of globalCaps) {
    assert.ok(c.purpose);
    assert.ok(c.authority);
  }
});

test('no vendor hardcoded in Celestan request path', () => {
  // Celestan never imports 'jira' or 'neon' directly — only capability name
  const allBindings = resolveAllBindings({ env: { CT_RUNTIME_MODE: 'filesystem' } });
  for (const [cap, adapter] of Object.entries(allBindings)) {
    assert.ok(CAPABILITIES[cap], `binding ${cap} unknown`);
    assert.ok(ADAPTERS[cap][adapter], `adapter ${cap}/${adapter} missing`);
  }
});
