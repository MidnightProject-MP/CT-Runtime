import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { bundleHash, deploymentIdFromWebAppUrl, normalizeFiles, signingString, signature, MAX_FILES } from '../lib/gas-deploy-contract.mjs';

test('self-deploy client follows Apps Script web app redirects', async () => {
  const source = await readFile(new URL('../scripts/deploy-gas.mjs', import.meta.url), 'utf8');
  assert.match(source, /redirect:\s*['"]follow['"]/);
});

test('derives deployment ID from the existing web app URL', () => {
  assert.equal(deploymentIdFromWebAppUrl('https://script.google.com/macros/s/AbC_123-xyz/exec'), 'AbC_123-xyz');
  assert.equal(deploymentIdFromWebAppUrl('https://script.google.com/macros/s/AbC_123-xyz/exec/'), 'AbC_123-xyz');
  assert.throws(() => deploymentIdFromWebAppUrl('https://example.com/macros/s/AbC_123-xyz/exec'), /invalid-deploy-url/);
  assert.throws(() => deploymentIdFromWebAppUrl('https://script.google.com/macros/s/AbC_123-xyz/dev'), /invalid-deploy-url/);
});

test('normalizes complete project deterministically', () => {
  const files = [
    { name: 'z.js', type: 'SERVER_JS', source: 'z' },
    { name: 'appsscript.json', type: 'JSON', source: '{"runtimeVersion":"V8"}' },
    { name: 'a.html', type: 'HTML', source: '<p>a</p>' }
  ];
  const normalized = normalizeFiles(files);
  assert.deepEqual(normalized.map((f) => f.name), ['a', 'appsscript', 'z']);
  assert.equal(bundleHash(files), bundleHash([...files].reverse()));
});

test('requires a manifest and rejects unsafe or oversized sets', () => {
  assert.throws(() => normalizeFiles([{ name: 'x.js', type: 'SERVER_JS', source: 'x' }]), /manifest-required/);
  assert.throws(() => normalizeFiles([{ name: 'appsscript.json', type: 'SERVER_JS', source: '{}' }]), /invalid-manifest-type/);
  assert.throws(() => normalizeFiles([{ name: '../x.js', type: 'SERVER_JS', source: 'x' }, { name: 'appsscript.json', type: 'JSON', source: '{}' }]), /invalid-file-name/);
  const files = Array.from({ length: MAX_FILES + 1 }, (_, i) => ({ name: `x${i}.js`, type: 'SERVER_JS', source: 'x' }));
  files[0] = { name: 'appsscript.json', type: 'JSON', source: '{}' };
  assert.throws(() => normalizeFiles(files), /invalid-file-count/);
});

test('signing binds operation, request identity, bundle and body hash', () => {
  const request = { operation: 'self-deploy', deployment_request_id: 'request-12345678', script_id: 'script12345678901234567890', deployment_id: 'deployment12345678', commit_sha: 'a'.repeat(40), bundle_hash: 'b'.repeat(64) };
  const body = JSON.stringify({ files: [] });
  const signed = signingString(request, '1750000000', 'nonce-12345678', body);
  assert.match(signed, /self-deploy/);
  assert.match(signed, /request-12345678/);
  assert.match(signed, /\na{40}\nb{64}\n/);
  assert.notEqual(signature(request, '1750000000', 'nonce-12345678', body, 'secret'), signature({ ...request, bundle_hash: 'c'.repeat(64) }, '1750000000', 'nonce-12345678', body, 'secret'));
});