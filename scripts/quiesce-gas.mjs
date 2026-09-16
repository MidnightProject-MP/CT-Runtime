import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { signingString, signature } from '../lib/gas-deploy-contract.mjs';

const execFileAsync = promisify(execFile);
const operation = process.argv[2];
if (!['quiesce-legacy-autonomy', 'assert-legacy-quiesced'].includes(operation)) {
  throw new Error(`invalid operation: ${operation}`);
}

const endpoint = String(process.env.CT_GAS_ADMIN_WEB_APP_URL || '').trim();
const secret = String(process.env.CT_GAS_DEPLOY_HMAC_SECRET || '');
const scriptId = String(process.env.CT_GAS_SCRIPT_ID || '1Uzv-r4UW-y9XLuO-f3QEvrwzInGu1JarmqecVtwarJor6Z5qpmUD2dri').trim();
const deploymentId = String(process.env.CT_GAS_DEPLOYMENT_ID || 'AKfycbwyFPC55MvhCfPUmBlfm7eRp-uHr5tpZ2H9suobETGXod_hLLVDQtC9DelC7ee_WSNawg').trim();
if (!endpoint || !secret) throw new Error('CT_GAS_ADMIN_WEB_APP_URL and CT_GAS_DEPLOY_HMAC_SECRET are required');
if (!/^[A-Za-z0-9_-]{20,100}$/.test(scriptId)) throw new Error('CT_GAS_SCRIPT_ID is required');
if (!/^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/.test(deploymentId)) throw new Error('CT_GAS_DEPLOYMENT_ID is required');

const { stdout: bundleOutput } = await execFileAsync(process.execPath, ['scripts/build-gas-bundle.mjs', 'gas', '/tmp/ct-runtime-gas-bundle.json'], { encoding: 'utf8' });
const bundleResult = JSON.parse(bundleOutput.trim().split('\n').at(-1));
const githubBundleHash = String(bundleResult.bundleHash || '');
if (!/^[0-9a-f]{64}$/.test(githubBundleHash)) throw new Error('failed to derive authoritative GAS bundle hash');

const request = {
  operation,
  correlation_id: randomUUID(),
  deployment_request_id: `ct-runtime-${operation}-${process.env.GITHUB_RUN_ID || Date.now()}`,
  script_id: scriptId,
  deployment_id: deploymentId,
  commit_sha: String(process.env.GITHUB_SHA || ''),
  github_bundle_hash: githubBundleHash
};
if (!/^[0-9a-f]{40}$/.test(request.commit_sha)) throw new Error('GITHUB_SHA is required');
const body = JSON.stringify(request);
const timestamp = String(Math.floor(Date.now() / 1000));
const nonce = randomUUID();
const canonical = signingString(request, timestamp, nonce, body);
const bodySha256 = createHash('sha256').update(body, 'utf8').digest('hex');
const canonicalSha256 = createHash('sha256').update(canonical, 'utf8').digest('hex');
const suppliedSignature = signature(request, timestamp, nonce, body, secret);
const url = new URL(endpoint);
url.searchParams.set('timestamp', timestamp);
url.searchParams.set('nonce', nonce);
url.searchParams.set('signature', suppliedSignature);

const response = await fetch(url, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body,
  redirect: 'follow'
});
const text = await response.text();
let result;
try { result = JSON.parse(text); } catch (_) { throw new Error(`invalid GAS response: HTTP ${response.status}`); }

console.log(JSON.stringify({
  trace: 'ct-gas-auth-client',
  diagnostic_id: request.correlation_id,
  operation,
  timestamp,
  nonce,
  body_bytes: Buffer.byteLength(body, 'utf8'),
  body_sha256: bodySha256,
  canonical_sha256: canonicalSha256,
  identity_fields_present: Object.keys(request).filter((key) => key !== 'correlation_id' && request[key] !== undefined),
  signature_present: suppliedSignature.length > 0,
  signature_length: suppliedSignature.length,
  http_status: response.status,
  redirected: response.redirected,
  final_host: (() => { try { return new URL(response.url).hostname; } catch (_) { return null; } })(),
  response_body: text
}));

if (!response.ok) throw new Error(`GAS control-plane HTTP ${response.status}: ${JSON.stringify(result)}`);

const output = { operation, ...result };
console.log(JSON.stringify(output));
if (process.env.OUTPUT_PATH) {
  const { writeFile } = await import('node:fs/promises');
  await writeFile(process.env.OUTPUT_PATH, JSON.stringify(output, null, 2) + '\n', 'utf8');
}
