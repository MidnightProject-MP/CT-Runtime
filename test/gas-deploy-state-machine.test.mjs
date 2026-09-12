import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import vm from 'node:vm';
import { bundleHash, signingString } from '../lib/gas-deploy-contract.mjs';

const SOURCE = fs.readFileSync(new URL('../gas/gas_deploy.js', import.meta.url), 'utf8');
const SCRIPT_ID = 'script12345678901234567890';
const DEPLOYMENT_ID = 'deployment12345678';
const SECRET = 'test-secret';
const MANIFEST = 'appsscript';
const DEPLOYMENT_DESCRIPTION = 'production web app';
const OLD_FILES = [
  { name: 'appsscript.json', type: 'JSON', source: '{"runtimeVersion":"V8"}' },
  { name: 'main.js', type: 'SERVER_JS', source: 'old' }
];
const NEW_FILES = [
  { name: 'appsscript.json', type: 'JSON', source: '{"runtimeVersion":"V8"}' },
  { name: 'main.js', type: 'SERVER_JS', source: 'new' }
];
const DRIFT_FILES = [
  { name: 'appsscript.json', type: 'JSON', source: '{"runtimeVersion":"V8"}' },
  { name: 'main.js', type: 'SERVER_JS', source: 'drift' }
];

function deploymentPayload(versionNumber = '1') {
  return {
    deploymentId: DEPLOYMENT_ID,
    deploymentConfig: {
      scriptId: SCRIPT_ID,
      versionNumber: Number(versionNumber),
      manifestFileName: MANIFEST,
      description: DEPLOYMENT_DESCRIPTION
    },
    updateTime: '2026-09-12T00:00:00Z',
    entryPoints: [{
      entryPointType: 'WEB_APP',
      webApp: { url: 'https://example.invalid/exec', entryPointConfig: { executeAs: 'USER_DEPLOYING', access: 'ANYONE_ANONYMOUS' } }
    }]
  };
}

function makeHarness({ versions = null, liveVersion = '1', headFiles = OLD_FILES, patchMode = 'normal', createMode = 'normal' } = {}) {
  const properties = new Map([
    ['CT_GAS_DEPLOY_HMAC_SECRET', SECRET],
    ['CT_GAS_DEPLOYMENT_ID', DEPLOYMENT_ID]
  ]);
  const calls = [];
  const lockEvents = [];
  let now = 1_750_000_000_000;
  let nextVersion = 1;
  const versionFiles = new Map();
  const versionRows = versions ? versions.map((v) => ({ scriptId: SCRIPT_ID, ...v })) : [{ scriptId: SCRIPT_ID, versionNumber: '1', description: 'initial' }];
  versionFiles.set('1', structuredClone(OLD_FILES));
  let deploymentVersion = String(liveVersion);
  let currentHead = structuredClone(headFiles);
  nextVersion = Math.max(0, ...versionRows.map((v) => Number(v.versionNumber))) + 1;
  let createLost = createMode === 'lost-response';
  let patchLost = patchMode === 'lost-response';
  let patchMismatch = patchMode === 'mismatch';

  function content(files) { return { scriptId: SCRIPT_ID, files: structuredClone(files) }; }
  function response(code, payload = {}) { return { getResponseCode: () => code, getContentText: () => JSON.stringify(payload) }; }
  function parse(url) { return new URL(url); }
  function fetch(url, options = {}) {
    const method = String(options.method || 'get').toLowerCase();
    const u = parse(url);
    calls.push({ method, url, body: options.payload ? JSON.parse(options.payload) : undefined });

    if (method === 'get' && /\/deployments\//.test(u.pathname)) return response(200, deploymentPayload(deploymentVersion));
    if (method === 'get' && /\/versions\/[^/]+$/.test(u.pathname)) {
      const n = u.pathname.split('/').pop();
      const row = versionRows.find((v) => String(v.versionNumber) === String(n));
      return row ? response(200, row) : response(404, { error: { message: 'not found' } });
    }
    if (method === 'get' && /\/versions$/.test(u.pathname)) {
      const pageToken = u.searchParams.get('pageToken');
      if (pageToken === 'page-2') return response(200, { versions: versionRows.slice(1), nextPageToken: '' });
      if (versionRows.length > 1) return response(200, { versions: [versionRows[0]], nextPageToken: 'page-2' });
      return response(200, { versions: versionRows, nextPageToken: '' });
    }
    if (method === 'get' && /\/content$/.test(u.pathname)) {
      const n = u.searchParams.get('versionNumber');
      return response(200, n ? content(versionFiles.get(String(n)) || currentHead) : content(currentHead));
    }
    if (method === 'put' && /\/content$/.test(u.pathname)) {
      currentHead = structuredClone(calls.at(-1).body.files);
      return response(200, content(currentHead));
    }
    if (method === 'post' && /\/versions$/.test(u.pathname)) {
      const n = String(nextVersion++);
      const row = { scriptId: SCRIPT_ID, versionNumber: n, description: calls.at(-1).body.description, createTime: '2026-09-12T00:00:00Z' };
      versionRows.push(row);
      versionFiles.set(n, structuredClone(currentHead));
      if (createLost) { createLost = false; throw new Error('deploy-google-api-599 lost response'); }
      return response(200, row);
    }
    if (method === 'put' && /\/deployments\//.test(u.pathname)) {
      const bodyConfig = calls.at(-1).body.deploymentConfig;
      assert.equal(bodyConfig.scriptId, SCRIPT_ID);
      assert.equal(bodyConfig.manifestFileName, MANIFEST);
      assert.equal(bodyConfig.description, DEPLOYMENT_DESCRIPTION);
      const n = String(bodyConfig.versionNumber);
      if (patchMismatch) {
        patchMismatch = false;
        deploymentVersion = String(Number(n) + 1);
        return response(200, deploymentPayload(deploymentVersion));
      }
      deploymentVersion = n;
      if (patchLost) { patchLost = false; throw new Error('deploy-google-api-599 lost response'); }
      return response(200, deploymentPayload(n));
    }
    throw new Error(`unexpected API call: ${method} ${url}`);
  }

  const context = {
    PropertiesService: { getScriptProperties: () => ({
      getProperty: (key) => properties.get(key) ?? null,
      setProperty: (key, value) => properties.set(key, String(value)),
      deleteProperty: (key) => properties.delete(key),
      getProperties: () => Object.fromEntries(properties)
    }) },
    LockService: { getScriptLock: () => ({
      waitLock: (timeout) => lockEvents.push(['wait', timeout]),
      releaseLock: () => lockEvents.push(['release'])
    }) },
    ScriptApp: { getScriptId: () => SCRIPT_ID, getOAuthToken: () => 'token' },
    UrlFetchApp: { fetch },
    Utilities: {
      DigestAlgorithm: { SHA_256: 'sha256' },
      Charset: { UTF_8: 'utf8' },
      computeDigest: (_algorithm, value) => [...crypto.createHash('sha256').update(String(value), 'utf8').digest()],
      computeHmacSha256Signature: (value, secret) => [...crypto.createHmac('sha256', secret).update(String(value), 'utf8').digest()],
      newBlob: (value) => ({ getBytes: () => [...Buffer.from(String(value), 'utf8')] })
    },
    Date: class TestDate extends Date { static now() { return now; } },
    console
  };
  vm.runInNewContext(SOURCE, context, { filename: 'gas_deploy.js' });
  return {
    deploy: context.CT_GAS_DEPLOY.deploy,
    authenticate: context.CT_GAS_DEPLOY.authenticate,
    plan: context.CT_GAS_DEPLOY.plan,
    calls,
    properties,
    lockEvents,
    advance(ms) { now += ms; },
    sign(raw, request, nonce) {
      const timestamp = String(Math.floor(now / 1000));
      const signed = signingString(request, timestamp, nonce, raw);
      return { timestamp, nonce, signature: crypto.createHmac('sha256', SECRET).update(signed).digest('hex') };
    },
    state() { return { deploymentVersion, head: structuredClone(currentHead), versions: structuredClone(versionRows) }; }
  };
}

function requestFor(files = NEW_FILES, overrides = {}) {
  return {
    operation: 'self-deploy',
    deployment_request_id: 'request-12345678',
    script_id: SCRIPT_ID,
    deployment_id: DEPLOYMENT_ID,
    commit_sha: 'a'.repeat(40),
    bundle_hash: bundleHash(files),
    expected_live_version: '1',
    expected_live_bundle_hash: bundleHash(OLD_FILES),
    ...overrides
  };
}

function nonceProperty(nonce) {
  return `CT_GAS_DEPLOY_NONCE_${crypto.createHash('sha256').update(nonce).digest('hex')}`;
}

function requestProperty(requestId) {
  return `CT_GAS_DEPLOY_REQUEST_${crypto.createHash('sha256').update(requestId).digest('hex').slice(0, 48)}`;
}

test('nonce replay is rejected and expired nonces can be reused', () => {
  const h = makeHarness();
  const request = requestFor();
  const raw = JSON.stringify(request);
  const auth = h.sign(raw, request, 'nonce-12345678');
  h.authenticate(raw, auth);
  assert.throws(() => h.authenticate(raw, auth), /nonce-replay/);
  h.advance(11 * 60 * 1000);
  const fresh = h.sign(raw, request, 'nonce-12345678');
  h.authenticate(raw, fresh);
});

test('nonce capacity fails closed without evicting an active nonce', () => {
  const h = makeHarness();
  const expires = 1_750_000_600_000;
  for (let i = 0; i < 256; i++) h.properties.set(nonceProperty(`active-${i}`), String(expires));
  const request = requestFor();
  const raw = JSON.stringify(request);
  const auth = h.sign(raw, request, 'new-capacity-nonce');
  assert.throws(() => h.authenticate(raw, auth), /nonce-capacity/);
  assert.equal([...h.properties.keys()].filter((k) => k.startsWith('CT_GAS_DEPLOY_NONCE_')).length, 256);
});

test('same request identity with a different bundle is rejected', () => {
  const h = makeHarness();
  const request = requestFor();
  h.deploy(request, NEW_FILES);
  const changed = requestFor(OLD_FILES, { bundle_hash: bundleHash(OLD_FILES) });
  assert.throws(() => h.deploy(changed, OLD_FILES), /request-marker-conflict/);
});

test('request-fence capacity fails closed without evicting unresolved identities', () => {
  const h = makeHarness();
  for (let i = 0; i < 256; i++) h.properties.set(requestProperty(`unresolved-${i}`), JSON.stringify({ identity: `${'b'.repeat(64)}:${'c'.repeat(64)}`, createdAt: i }));
  const request = requestFor();
  assert.throws(() => h.deploy(request, NEW_FILES), /request-fence-capacity/);
  assert.equal([...h.properties.keys()].filter((k) => k.startsWith('CT_GAS_DEPLOY_REQUEST_')).length, 256);
  assert.equal(h.calls.filter((c) => ['put', 'post'].includes(c.method)).length, 0);
});

test('stale predecessor fence fails before mutation', () => {
  const h = makeHarness({ liveVersion: '2', versions: [
    { versionNumber: '1', description: 'initial' },
    { versionNumber: '2', description: 'other' }
  ] });
  const request = requestFor();
  assert.throws(() => h.deploy(request, NEW_FILES), /live-state-conflict/);
  assert.equal(h.calls.filter((c) => ['put', 'post'].includes(c.method)).length, 0);
});

test('unexpected HEAD drift fails closed before mutation', () => {
  const h = makeHarness({ headFiles: DRIFT_FILES });
  const request = requestFor();
  assert.throws(() => h.deploy(request, NEW_FILES), /head-state-conflict/);
  assert.equal(h.calls.filter((c) => ['put', 'post'].includes(c.method)).length, 0);
});

test('already-updated HEAD resumes without rewriting it', () => {
  const h = makeHarness({ headFiles: NEW_FILES });
  const request = requestFor();
  const result = h.deploy(request, NEW_FILES);
  assert.equal(result.status, 'verified');
  assert.equal(h.calls.filter((c) => c.method === 'put' && /\/content$/.test(c.url)).length, 0);
  assert.equal(h.state().deploymentVersion, '2');
});

test('deployment update uses documented PUT and preserves full deployment config', () => {
  const h = makeHarness();
  const request = requestFor();
  const result = h.deploy(request, NEW_FILES);
  assert.equal(result.status, 'verified');
  const updates = h.calls.filter((c) => /\/deployments\//.test(c.url) && c.method === 'put');
  assert.equal(updates.length, 1);
  assert.deepEqual(updates[0].body, { deploymentConfig: {
    scriptId: SCRIPT_ID,
    versionNumber: 2,
    manifestFileName: MANIFEST,
    description: DEPLOYMENT_DESCRIPTION
  } });
  assert.equal(h.calls.some((c) => c.method === 'patch'), false);
});

test('deployment mutex is acquired for the entire mutation state machine', () => {
  const h = makeHarness();
  h.deploy(requestFor(), NEW_FILES);
  assert.equal(h.lockEvents.filter(([event]) => event === 'wait').length, 1);
  assert.equal(h.lockEvents.filter(([event]) => event === 'release').length, 1);
  assert.deepEqual(h.lockEvents, [['wait', 30000], ['release']]);
});

test('lost version-create response is recovered by the immutable marker', () => {
  const h = makeHarness({ createMode: 'lost-response' });
  const request = requestFor();
  const result = h.deploy(request, NEW_FILES);
  assert.equal(result.status, 'verified');
  assert.equal(h.state().versions.length, 2);
  assert.equal(h.calls.filter((c) => c.method === 'post').length, 1);
  assert.equal(h.calls.filter((c) => c.method === 'put' && /\/deployments\//.test(c.url)).length, 1);
});

test('lost deployment-update response converges by readback', () => {
  const h = makeHarness({ patchMode: 'lost-response' });
  const request = requestFor();
  const result = h.deploy(request, NEW_FILES);
  assert.equal(result.status, 'verified');
  assert.equal(h.state().deploymentVersion, '2');
  assert.equal(h.calls.filter((c) => c.method === 'put' && /\/deployments\//.test(c.url)).length, 1);
});

test('final readback mismatch never reports success', () => {
  const h = makeHarness({ patchMode: 'mismatch' });
  const request = requestFor();
  assert.throws(() => h.deploy(request, NEW_FILES), /readback-deployment-mismatch|readback-bundle-mismatch/);
});

test('HEAD-new/web-old partial state converges without another HEAD mutation', () => {
  const h = makeHarness({ headFiles: NEW_FILES, liveVersion: '1' });
  const request = requestFor();
  const result = h.deploy(request, NEW_FILES);
  assert.equal(result.status, 'verified');
  assert.equal(h.state().deploymentVersion, '2');
  assert.deepEqual(h.state().head, NEW_FILES);
  assert.equal(h.calls.filter((c) => c.method === 'put' && /\/content$/.test(c.url)).length, 0);
  assert.equal(h.calls.filter((c) => c.method === 'put' && /\/deployments\//.test(c.url)).length, 1);
});

test('plan exposes paginated version capacity', () => {
  const rows = Array.from({ length: 199 }, (_, i) => ({ versionNumber: String(i + 1), description: i === 198 ? 'current' : 'old' }));
  const h = makeHarness({ versions: rows, liveVersion: '199' });
  const plan = h.plan(requestFor());
  assert.equal(plan.versionCapacity.used, 199);
  assert.equal(plan.versionCapacity.max, 200);
  assert.equal(plan.versionCapacity.remaining, 1);
  assert.equal(plan.versionCapacity.status, 'low');
  assert.ok(h.calls.filter((c) => c.method === 'get' && /\/versions\?/.test(c.url)).length >= 2);
});
