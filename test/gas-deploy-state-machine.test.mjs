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
const OLD_FILES = [
  { name: 'appsscript.json', type: 'JSON', source: '{"runtimeVersion":"V8"}' },
  { name: 'main.js', type: 'SERVER_JS', source: 'old' }
];
const NEW_FILES = [
  { name: 'appsscript.json', type: 'JSON', source: '{"runtimeVersion":"V8"}' },
  { name: 'main.js', type: 'SERVER_JS', source: 'new' }
];

function makeHarness({ versions = null, liveVersion = '1', headFiles = OLD_FILES, patchMode = 'normal', createMode = 'normal' } = {}) {
  const properties = new Map([
    ['CT_GAS_DEPLOY_HMAC_SECRET', SECRET],
    ['CT_GAS_DEPLOYMENT_ID', DEPLOYMENT_ID]
  ]);
  const calls = [];
  let now = 1_750_000_000_000;
  let nextVersion = 1;
  const versionFiles = new Map();
  const versionRows = versions ? versions.map((v) => ({ ...v })) : [{ versionNumber: '1', description: 'initial' }];
  const initialVersionFiles = new Map([['1', OLD_FILES]]);
  initialVersionFiles.forEach((value, key) => versionFiles.set(key, structuredClone(value)));
  let deploymentVersion = String(liveVersion);
  let currentHead = structuredClone(headFiles);
  nextVersion = Math.max(0, ...versionRows.map((v) => Number(v.versionNumber))) + 1;
  let createLost = createMode === 'lost-response';
  let patchLost = patchMode === 'lost-response';
  let patchMismatch = patchMode === 'mismatch';

  function content(files) { return { files: structuredClone(files) }; }
  function response(code, payload = {}) {
    return { getResponseCode: () => code, getContentText: () => JSON.stringify(payload) };
  }
  function parse(url) {
    return new URL(url);
  }
  function fetch(url, options = {}) {
    const method = String(options.method || 'get').toLowerCase();
    const u = parse(url);
    calls.push({ method, url, body: options.payload ? JSON.parse(options.payload) : undefined });

    if (method === 'get' && /\/deployments\//.test(u.pathname)) {
      return response(200, { deploymentId: DEPLOYMENT_ID, versionNumber: deploymentVersion });
    }
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
      if (n) return response(200, content(versionFiles.get(String(n)) || currentHead));
      return response(200, content(currentHead));
    }
    if (method === 'put' && /\/content$/.test(u.pathname)) {
      currentHead = structuredClone(calls.at(-1).body.files);
      return response(200, content(currentHead));
    }
    if (method === 'post' && /\/versions$/.test(u.pathname)) {
      const n = String(nextVersion++);
      const row = { versionNumber: n, description: calls.at(-1).body.description };
      versionRows.push(row);
      versionFiles.set(n, structuredClone(currentHead));
      if (createLost) {
        createLost = false;
        throw new Error('deploy-google-api-599 lost response');
      }
      return response(200, row);
    }
    if (method === 'patch' && /\/deployments\//.test(u.pathname)) {
      const n = String(calls.at(-1).body.deploymentConfig.versionNumber);
      deploymentVersion = n;
      if (patchMismatch) {
        patchMismatch = false;
        return response(200, { deploymentId: DEPLOYMENT_ID, versionNumber: String(Number(n) + 1) });
      }
      if (patchLost) {
        patchLost = false;
        throw new Error('deploy-google-api-599 lost response');
      }
      return response(200, { deploymentId: DEPLOYMENT_ID, versionNumber: n });
    }
    throw new Error(`unexpected API call: ${method} ${url}`);
  }

  const context = {
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (key) => properties.get(key) ?? null,
        setProperty: (key, value) => properties.set(key, String(value)),
        deleteProperty: (key) => properties.delete(key),
        getProperties: () => Object.fromEntries(properties)
      })
    },
    LockService: { getScriptLock: () => ({ waitLock: () => {}, releaseLock: () => {} }) },
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

test('same request identity with a different bundle is rejected', () => {
  const h = makeHarness();
  const request = requestFor();
  h.deploy(request, NEW_FILES);
  const changed = requestFor(OLD_FILES, { bundle_hash: bundleHash(OLD_FILES) });
  assert.throws(() => h.deploy(changed, OLD_FILES), /request-marker-conflict/);
});

test('stale predecessor fence fails before mutation', () => {
  const h = makeHarness({ liveVersion: '2', versions: [
    { versionNumber: '1', description: 'initial' },
    { versionNumber: '2', description: 'other' }
  ] });
  const request = requestFor();
  assert.throws(() => h.deploy(request, NEW_FILES), /live-state-conflict/);
  assert.equal(h.calls.filter((c) => ['put', 'post', 'patch'].includes(c.method)).length, 0);
});

test('already-updated HEAD resumes without rewriting it', () => {
  const h = makeHarness({ headFiles: NEW_FILES });
  const request = requestFor();
  const result = h.deploy(request, NEW_FILES);
  assert.equal(result.status, 'verified');
  assert.equal(h.calls.filter((c) => c.method === 'put').length, 0);
});

test('lost version-create response is recovered by the immutable marker', () => {
  const h = makeHarness({ createMode: 'lost-response' });
  const request = requestFor();
  const result = h.deploy(request, NEW_FILES);
  assert.equal(result.status, 'verified');
  assert.equal(h.state().versions.length, 2);
  assert.equal(h.calls.filter((c) => c.method === 'post').length, 1);
  assert.equal(h.calls.filter((c) => c.method === 'patch').length, 1);
});

test('lost deployment-update response converges by readback', () => {
  const h = makeHarness({ patchMode: 'lost-response' });
  const request = requestFor();
  const result = h.deploy(request, NEW_FILES);
  assert.equal(result.status, 'verified');
  assert.equal(h.state().deploymentVersion, '2');
  assert.equal(h.calls.filter((c) => c.method === 'patch').length, 1);
});

test('final readback mismatch never reports success', () => {
  const h = makeHarness({ patchMode: 'mismatch' });
  const request = requestFor();
  assert.throws(() => h.deploy(request, NEW_FILES), /readback-deployment-mismatch|readback-bundle-mismatch/);
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
