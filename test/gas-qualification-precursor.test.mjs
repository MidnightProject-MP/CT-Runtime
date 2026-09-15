import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { bundleHash } from '../lib/gas-deploy-contract.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const FIXTURE_FILES = [
  'appsscript.json', 'gas_actions.js', 'gas_agent_executor.js', 'gas_bootstrap.js',
  'gas_chronicle.js', 'gas_core.js', 'gas_deploy.js', 'gas_evidence.js',
  'gas_federation.js', 'gas_github.js', 'gas_migrate.js',
  'gas_observer.js', 'gas_state.js', 'gas_trigger.js', 'gas_v8.js'
];

async function fixture() {
  return Promise.all(FIXTURE_FILES.map(async (name) => ({
    name,
    type: name === 'appsscript.json' ? 'JSON' : 'SERVER_JS',
    source: await readFile(join(ROOT, 'gas', name), 'utf8')
  })));
}

function runCompatibilityLayer() {
  const source = readFileSync(join(ROOT, 'gas', 'gas_deploy_qualify.js'), 'utf8');
  let capturedRequest;
  const Utilities = {
    DigestAlgorithm: { SHA_256: 'SHA_256' },
    Charset: { UTF_8: 'UTF_8' },
    newBlob: (value) => ({ getBytes: () => Array.from(Buffer.from(String(value), 'utf8')) }),
    computeDigest: (_algorithm, value, _charset) => Array.from(createHash('sha256').update(String(value), 'utf8').digest())
  };
  const CT_GAS_DEPLOY = {
    qualify: (request) => {
      capturedRequest = request;
      return {
        status: 'qualified', scriptId: request.script_id,
        headBundleHash: 'h'.repeat(64), fileCount: Array.isArray(request.files) ? request.files.length : 0
      };
    }
  };
  vm.runInNewContext(source, { Utilities, CT_GAS_DEPLOY }, { filename: 'gas_deploy_qualify.js' });
  return { CT_GAS_DEPLOY, getCapturedRequest: () => capturedRequest };
}

test('compatibility qualification hash equals GAS-native desired hash for canonical 15-file fixture', async () => {
  const files = await fixture();
  const nativeHash = bundleHash(files);
  const { CT_GAS_DEPLOY, getCapturedRequest } = runCompatibilityLayer();
  const request = { script_id: 'fixture-script', files };
  const result = CT_GAS_DEPLOY.qualify(request);
  assert.equal(getCapturedRequest(), request);
  assert.equal(result.status, 'qualified');
  assert.equal(result.scriptId, 'fixture-script');
  assert.equal(result.fileCount, 15);
  assert.equal(result.desiredBundleHash, nativeHash);
  assert.match(result.desiredBundleHash, /^[0-9a-f]{64}$/);
});

test('ordinary readback qualification without files preserves the original contract', () => {
  const { CT_GAS_DEPLOY, getCapturedRequest } = runCompatibilityLayer();
  const request = { script_id: 'readback-script' };
  const result = CT_GAS_DEPLOY.qualify(request);
  assert.equal(getCapturedRequest(), request);
  assert.equal(result.status, 'qualified');
  assert.equal(result.scriptId, 'readback-script');
  assert.equal(result.headBundleHash, 'h'.repeat(64));
  assert.equal(result.fileCount, 0);
  assert.equal('desiredBundleHash' in result, false);
});
